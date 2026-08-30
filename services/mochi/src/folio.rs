use crate::safe_dns::validate_public_target;
use crate::state::{AppState, FolioCachedResponse};
use crate::{negative_message, NEGATIVE};
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio_stream::wrappers::ReceiverStream;
use url::Url;

pub const PREFIX: &str = "/!!folio/";
pub const REQUEST_PREFIX: &str = "/!!folio/request/";
const REQUEST_HEADERS: &str = "x-mochi-folio-headers";
const SESSION_HEADER: &str = "x-mochi-folio-session";
const UPSTREAM_META_HEADER: &str = "x-mochi-upstream-meta";
const MAX_ENVELOPE_BYTES: usize = 64 * 1024;
const MAX_HEADER_COUNT: usize = 128;

#[derive(Serialize)]
struct UpstreamMeta {
    status: u16,
    status_text: String,
    url: String,
    raw_headers: Vec<(String, String)>,
    cache: &'static str,
}

#[derive(Serialize)]
pub struct MetricsSnapshot {
    active_requests: u64,
    requests: u64,
    cache_hits: u64,
    cache_misses: u64,
    cache_revalidations: u64,
    rejected_targets: u64,
    upstream_errors: u64,
}

struct ActiveRequestGuard(Arc<AppState>);

impl ActiveRequestGuard {
    fn new(state: Arc<AppState>) -> Self {
        state
            .folio_metrics
            .active_requests
            .fetch_add(1, Ordering::Relaxed);
        Self(state)
    }
}

impl Drop for ActiveRequestGuard {
    fn drop(&mut self) {
        self.0
            .folio_metrics
            .active_requests
            .fetch_sub(1, Ordering::Relaxed);
    }
}

pub async fn health_handler() -> impl IntoResponse {
    axum::Json(serde_json::json!({ "ok": true, "protocol": 1 }))
}

pub async fn metrics_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let metrics = &state.folio_metrics;
    axum::Json(MetricsSnapshot {
        active_requests: metrics.active_requests.load(Ordering::Relaxed),
        requests: metrics.requests.load(Ordering::Relaxed),
        cache_hits: metrics.cache_hits.load(Ordering::Relaxed),
        cache_misses: metrics.cache_misses.load(Ordering::Relaxed),
        cache_revalidations: metrics.cache_revalidations.load(Ordering::Relaxed),
        rejected_targets: metrics.rejected_targets.load(Ordering::Relaxed),
        upstream_errors: metrics.upstream_errors.load(Ordering::Relaxed),
    })
}

pub async fn request_handler(
    State(state): State<Arc<AppState>>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    body: Body,
) -> Response {
    state.folio_metrics.requests.fetch_add(1, Ordering::Relaxed);

    if method == Method::CONNECT || method == Method::TRACE {
        return gateway_error(StatusCode::METHOD_NOT_ALLOWED, "method not supported");
    }

    let target = match target_from_uri(&uri) {
        Some(target) => target,
        None => return gateway_error(StatusCode::BAD_REQUEST, "invalid target"),
    };
    let target = match Url::parse(&target) {
        Ok(target) => target,
        Err(_) => return gateway_error(StatusCode::BAD_REQUEST, "invalid target url"),
    };
    if let Err(reason) = validate_public_target(&target) {
        state
            .folio_metrics
            .rejected_targets
            .fetch_add(1, Ordering::Relaxed);
        return gateway_error(StatusCode::FORBIDDEN, reason);
    }

    let upstream_headers = match decode_upstream_headers(&headers) {
        Ok(headers) => headers,
        Err(reason) => return gateway_error(StatusCode::BAD_REQUEST, reason),
    };
    let session = headers
        .get(SESSION_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| valid_session_id(value));
    let sensitive_request = upstream_headers.contains_key("cookie")
        || upstream_headers.contains_key("authorization")
        || upstream_headers.contains_key("proxy-authorization");

    let (public_key, session_key) = cache_keys(
        &method,
        target.as_str(),
        &upstream_headers,
        session,
        sensitive_request,
    );
    let now = now_ms();
    let cached = lookup_cache(&state, session_key.as_ref(), &public_key).await;
    if let Some(entry) = cached.as_ref().filter(|entry| entry.fresh_until_ms > now) {
        state
            .folio_metrics
            .cache_hits
            .fetch_add(1, Ordering::Relaxed);
        return cached_response(entry, "HIT");
    }
    state
        .folio_metrics
        .cache_misses
        .fetch_add(1, Ordering::Relaxed);

    let Some(permit) = state
        .request_permit
        .acquire_timeout(std::time::Duration::from_secs(5))
        .await
    else {
        return gateway_error(StatusCode::SERVICE_UNAVAILABLE, "gateway unavailable");
    };
    let active = ActiveRequestGuard::new(state.clone());

    let mut request = state
        .raw_client
        .request(method.clone(), target.clone())
        .headers(upstream_headers.clone());
    if let Some(stale) = cached.as_ref() {
        if let Some(etag) = raw_header(&stale.raw_headers, "etag") {
            request = request.header("if-none-match", etag);
        } else if let Some(last_modified) = raw_header(&stale.raw_headers, "last-modified") {
            request = request.header("if-modified-since", last_modified);
        }
    }
    if method != Method::GET && method != Method::HEAD {
        request = request.body(reqwest::Body::wrap_stream(body.into_data_stream()));
    }

    let upstream = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            state
                .folio_metrics
                .upstream_errors
                .fetch_add(1, Ordering::Relaxed);
            tracing::warn!(
                error = %error,
                "folio upstream request failed{}",
                NEGATIVE
            );
            return gateway_error(StatusCode::BAD_GATEWAY, "upstream request failed");
        }
    };

    if upstream.status() == reqwest::StatusCode::NOT_MODIFIED {
        if let Some(stale) = cached {
            let refreshed = Arc::new(refresh_cached_response(stale.as_ref(), upstream.headers()));
            let key = session_key.as_ref().unwrap_or(&public_key).clone();
            state.folio_cache.insert(key, refreshed.clone()).await;
            state
                .folio_metrics
                .cache_revalidations
                .fetch_add(1, Ordering::Relaxed);
            return cached_response(&refreshed, "REVALIDATED");
        }
    }

    let status = upstream.status();
    let status_text = status.canonical_reason().unwrap_or("").to_owned();
    let upstream_url = upstream.url().to_string();
    let raw_headers = raw_headers(upstream.headers());
    let cache_policy = cache_policy(
        status.as_u16(),
        &raw_headers,
        sensitive_request,
        session.is_some(),
        state.folio_cache_max_ttl_secs,
    );
    let cache_key = if cache_policy.is_some() {
        if sensitive_request || has_directive(&raw_headers, "private") {
            session_key
        } else {
            Some(public_key)
        }
    } else {
        None
    };
    let fresh_until_ms = cache_policy
        .map(|seconds| now_ms().saturating_add(seconds.saturating_mul(1000)))
        .unwrap_or(0);
    let meta = UpstreamMeta {
        status: status.as_u16(),
        status_text: status_text.clone(),
        url: upstream_url.clone(),
        raw_headers: raw_headers.clone(),
        cache: "MISS",
    };

    if method == Method::HEAD || response_has_no_body(status.as_u16()) {
        if let Some(cache_key) = cache_key {
            let entry = Arc::new(FolioCachedResponse {
                status: status.as_u16(),
                status_text,
                url: upstream_url,
                raw_headers,
                body: Bytes::new(),
                fresh_until_ms,
            });
            state.folio_cache.insert(cache_key, entry).await;
        }
        return response_with_meta(Body::empty(), &meta);
    }

    let can_buffer = upstream
        .content_length()
        .map(|length| length as usize <= state.folio_cache_max_entry_size)
        .unwrap_or(true);
    let (sender, receiver) = tokio::sync::mpsc::channel(state.channel_buffer.max(1));
    let cache_limit = state.folio_cache_max_entry_size;
    let state_for_stream = state.clone();
    tokio::spawn(async move {
        let _permit = permit;
        let _active = active;
        let mut stream = upstream.bytes_stream();
        let mut buffered = can_buffer.then(|| BytesMut::with_capacity(cache_limit.min(256 * 1024)));

        while let Some(next) = stream.next().await {
            match next {
                Ok(chunk) => {
                    if let Some(buffer) = buffered.as_mut() {
                        if buffer.len().saturating_add(chunk.len()) <= cache_limit {
                            buffer.extend_from_slice(&chunk);
                        } else {
                            buffered = None;
                        }
                    }
                    if sender
                        .send(Ok::<Bytes, std::io::Error>(chunk))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
                Err(error) => {
                    state_for_stream
                        .folio_metrics
                        .upstream_errors
                        .fetch_add(1, Ordering::Relaxed);
                    let _ = sender
                        .send(Err(std::io::Error::other(error.to_string())))
                        .await;
                    return;
                }
            }
        }

        if let (Some(cache_key), Some(buffer)) = (cache_key, buffered) {
            let entry = Arc::new(FolioCachedResponse {
                status: status.as_u16(),
                status_text,
                url: upstream_url,
                raw_headers,
                body: buffer.freeze(),
                fresh_until_ms,
            });
            state_for_stream.folio_cache.insert(cache_key, entry).await;
        }
    });

    response_with_meta(Body::from_stream(ReceiverStream::new(receiver)), &meta)
}

fn target_from_uri(uri: &Uri) -> Option<String> {
    let path = uri.path();
    let encoded = path.strip_prefix(REQUEST_PREFIX)?;
    urlencoding::decode(encoded)
        .ok()
        .map(|value| value.into_owned())
}

fn decode_upstream_headers(headers: &HeaderMap) -> Result<HeaderMap, &'static str> {
    let encoded = headers
        .get(REQUEST_HEADERS)
        .and_then(|value| value.to_str().ok())
        .ok_or("missing upstream header envelope... /ᐠ - ˕ -マ")?;
    if encoded.len() > MAX_ENVELOPE_BYTES * 2 {
        return Err("upstream header envelope is too large... /ᐠ - ˕ -マ");
    }
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "invalid upstream header envelope... /ᐠ - ˕ -マ")?;
    if decoded.len() > MAX_ENVELOPE_BYTES {
        return Err("upstream header envelope is too large... /ᐠ - ˕ -マ");
    }
    let entries: Vec<(String, String)> =
        serde_json::from_slice(&decoded).map_err(|_| "invalid upstream headers... /ᐠ - ˕ -マ")?;
    if entries.len() > MAX_HEADER_COUNT {
        return Err("too many upstream headers... /ᐠ - ˕ -マ");
    }

    let mut output = HeaderMap::new();
    for (name, value) in entries {
        let lower = name.to_ascii_lowercase();
        if blocked_upstream_header(&lower) {
            continue;
        }
        let name = HeaderName::from_bytes(lower.as_bytes())
            .map_err(|_| "invalid header name... /ᐠ - ˕ -マ")?;
        let value =
            HeaderValue::from_str(&value).map_err(|_| "invalid header value... /ᐠ - ˕ -マ")?;
        output.append(name, value);
    }
    Ok(output)
}

fn blocked_upstream_header(name: &str) -> bool {
    matches!(
        name,
        "host"
            | "connection"
            | "content-length"
            | "transfer-encoding"
            | "upgrade"
            | "keep-alive"
            | "te"
            | "trailer"
            | "proxy-authorization"
            | "proxy-authenticate"
            | "accept-encoding"
    ) || name.starts_with("x-mochi-")
        || name.starts_with("cf-")
}

fn valid_session_id(value: &str) -> bool {
    (16..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn cache_keys(
    method: &Method,
    target: &str,
    headers: &HeaderMap,
    session: Option<&str>,
    sensitive: bool,
) -> (String, Option<String>) {
    let normalized = normalized_headers(headers);
    let public = hash_key(&[method.as_str(), target, &normalized, "public"]);
    let session = session.map(|session| {
        hash_key(&[
            method.as_str(),
            target,
            &normalized,
            if sensitive { "private" } else { "session" },
            session,
        ])
    });
    (public, session)
}

fn normalized_headers(headers: &HeaderMap) -> String {
    let mut entries = headers
        .iter()
        .map(|(name, value)| format!("{}:{}", name.as_str(), value.to_str().unwrap_or("<binary>")))
        .collect::<Vec<_>>();
    entries.sort_unstable();
    entries.join("\n")
}

fn hash_key(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    hex::encode(hasher.finalize())
}

async fn lookup_cache(
    state: &AppState,
    session_key: Option<&String>,
    public_key: &String,
) -> Option<Arc<FolioCachedResponse>> {
    if let Some(session_key) = session_key {
        if let Some(entry) = state.folio_cache.get(session_key).await {
            return Some(entry);
        }
    }
    state.folio_cache.get(public_key).await
}

fn cache_policy(
    status: u16,
    headers: &[(String, String)],
    sensitive_request: bool,
    has_session: bool,
    max_ttl_secs: u64,
) -> Option<u64> {
    if !matches!(
        status,
        200 | 203 | 204 | 300 | 301 | 308 | 404 | 405 | 410 | 414 | 501
    ) || raw_header(headers, "set-cookie").is_some()
    {
        return None;
    }
    let cache_control = raw_header(headers, "cache-control")
        .unwrap_or_default()
        .to_ascii_lowercase();
    if cache_control
        .split(',')
        .any(|value| value.trim() == "no-store")
    {
        return None;
    }
    if (sensitive_request || has_directive(headers, "private")) && !has_session {
        return None;
    }

    let max_age = cache_control.split(',').find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        matches!(name.trim(), "s-maxage" | "max-age")
            .then(|| value.trim().trim_matches('"').parse::<u64>().ok())
            .flatten()
    });
    if let Some(max_age) = max_age {
        return Some(max_age.min(max_ttl_secs));
    }
    cache_control
        .split(',')
        .any(|value| value.trim() == "immutable")
        .then_some(max_ttl_secs.min(24 * 3600))
}

fn has_directive(headers: &[(String, String)], directive: &str) -> bool {
    raw_header(headers, "cache-control")
        .unwrap_or_default()
        .split(',')
        .any(|value| value.trim().eq_ignore_ascii_case(directive))
}

fn raw_headers(headers: &HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .filter_map(|(name, value)| {
            Some((name.as_str().to_owned(), value.to_str().ok()?.to_owned()))
        })
        .collect()
}

fn raw_header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn refresh_cached_response(
    cached: &FolioCachedResponse,
    headers: &HeaderMap,
) -> FolioCachedResponse {
    let replacement = raw_headers(headers);
    let replacement_names = replacement
        .iter()
        .map(|(name, _)| name.to_ascii_lowercase())
        .collect::<std::collections::HashSet<_>>();
    let mut raw_headers = cached
        .raw_headers
        .iter()
        .filter(|(name, _)| !replacement_names.contains(&name.to_ascii_lowercase()))
        .cloned()
        .collect::<Vec<_>>();
    raw_headers.extend(replacement);
    let ttl = cache_policy(cached.status, &raw_headers, false, true, 24 * 3600).unwrap_or(0);
    FolioCachedResponse {
        status: cached.status,
        status_text: cached.status_text.clone(),
        url: cached.url.clone(),
        raw_headers,
        body: cached.body.clone(),
        fresh_until_ms: now_ms().saturating_add(ttl.saturating_mul(1000)),
    }
}

fn response_has_no_body(status: u16) -> bool {
    matches!(status, 101 | 103 | 204 | 205 | 304)
}

fn cached_response(entry: &FolioCachedResponse, cache: &'static str) -> Response {
    let meta = UpstreamMeta {
        status: entry.status,
        status_text: entry.status_text.clone(),
        url: entry.url.clone(),
        raw_headers: entry.raw_headers.clone(),
        cache,
    };
    response_with_meta(Body::from(entry.body.clone()), &meta)
}

fn response_with_meta(body: Body, meta: &UpstreamMeta) -> Response {
    let encoded = serde_json::to_vec(meta)
        .ok()
        .map(|json| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json));
    let Some(encoded) = encoded else {
        return gateway_error(
            StatusCode::BAD_GATEWAY,
            "failed to encode upstream metadata",
        );
    };
    let Ok(encoded) = HeaderValue::from_str(&encoded) else {
        return gateway_error(StatusCode::BAD_GATEWAY, "upstream metadata is too large");
    };

    let mut response = Response::builder()
        .status(StatusCode::OK)
        .body(body)
        .expect("gateway response is invalid... /ᐠ - ˕ -マ");
    response.headers_mut().insert(UPSTREAM_META_HEADER, encoded);
    response.headers_mut().insert(
        "access-control-expose-headers",
        HeaderValue::from_static(UPSTREAM_META_HEADER),
    );
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    if let Some(content_type) = raw_header(&meta.raw_headers, "content-type") {
        if let Ok(content_type) = HeaderValue::from_str(content_type) {
            response.headers_mut().insert("content-type", content_type);
        }
    }
    response
}

fn gateway_error(status: StatusCode, message: &'static str) -> Response {
    (
        status,
        [("cache-control", "no-store")],
        negative_message(message),
    )
        .into_response()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_hop_by_hop_headers() {
        for name in [
            "host",
            "connection",
            "content-length",
            "transfer-encoding",
            "accept-encoding",
            "x-mochi-folio-session",
        ] {
            assert!(blocked_upstream_header(name), "{name}");
        }
        assert!(!blocked_upstream_header("cookie"));
        assert!(!blocked_upstream_header("authorization"));
    }

    #[test]
    fn cache_policy_requires_explicit_freshness() {
        assert_eq!(
            cache_policy(
                200,
                &[("cache-control".into(), "public, max-age=120".into())],
                false,
                false,
                3600,
            ),
            Some(120)
        );
        assert_eq!(
            cache_policy(
                200,
                &[("cache-control".into(), "no-store".into())],
                false,
                false,
                3600,
            ),
            None
        );
        assert_eq!(cache_policy(200, &[], false, false, 3600), None);
    }
}
