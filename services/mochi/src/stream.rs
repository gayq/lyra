use crate::cache::{load_stream_from_disk, StreamCacheWriter, StreamDiskEntry};
use crate::state::{AppState, CachedResponse};
use crate::{negative_message, NEGATIVE};
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Json;
use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;
use moka::future::Cache;
use reqwest::header::{
    ACCEPT, ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE, REFERER, RETRY_AFTER,
};
use serde::Serialize;
use std::io::SeekFrom;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::io::ReaderStream;
use url::Url;

const MEGAPLAY_BASE: &str = "https://megaplay.buzz";
const MEGAPLAY_REFERER: &str = "https://megaplay.buzz/api";
const SEGMENT_PREFIX_BYTES: usize = 252;
const MAX_METADATA_BYTES: usize = 2 * 1024 * 1024;
const UPSTREAM_REQUEST_BUDGET: Duration = Duration::from_secs(12);
const UPSTREAM_BODY_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
struct StreamMetrics {
    active_requests: AtomicU64,
    requests: AtomicU64,
    source_cache_hits: AtomicU64,
    source_cache_misses: AtomicU64,
    playlist_cache_hits: AtomicU64,
    playlist_cache_misses: AtomicU64,
    segment_memory_hits: AtomicU64,
    segment_disk_hits: AtomicU64,
    segment_cache_misses: AtomicU64,
    segment_coalesced: AtomicU64,
    upstream_attempts: AtomicU64,
    upstream_retries: AtomicU64,
    upstream_errors: AtomicU64,
    source_refreshes: AtomicU64,
    range_requests: AtomicU64,
    bytes_served: AtomicU64,
    source_resolution_ms: AtomicU64,
    source_resolutions: AtomicU64,
    playlist_resolution_ms: AtomicU64,
    playlist_resolutions: AtomicU64,
    segment_upstream_ttfb_ms: AtomicU64,
    segment_upstream_ttfb_samples: AtomicU64,
    segment_upstream_download_ms: AtomicU64,
    segment_upstream_downloads: AtomicU64,
    segment_upstream_bytes: AtomicU64,
    downstream_cancellations: AtomicU64,
    segment_partial_fills: AtomicU64,
    segment_failed_fills: AtomicU64,
    segment_disk_write_failures: AtomicU64,
}

static STREAM_METRICS: LazyLock<StreamMetrics> = LazyLock::new(StreamMetrics::default);

struct ActiveRequest;

impl ActiveRequest {
    fn start() -> Self {
        STREAM_METRICS.requests.fetch_add(1, Ordering::Relaxed);
        STREAM_METRICS
            .active_requests
            .fetch_add(1, Ordering::Relaxed);
        Self
    }
}

impl Drop for ActiveRequest {
    fn drop(&mut self) {
        STREAM_METRICS
            .active_requests
            .fetch_sub(1, Ordering::Relaxed);
    }
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct EpisodeKey {
    anilist_id: i64,
    mal_id: i64,
    anikoto_episode_id: String,
    episode: i32,
    language: String,
}

#[derive(Debug, Clone)]
struct SubtitleTrack {
    url: String,
    label: String,
    language: String,
    kind: String,
    default: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct TimeMarker {
    start: f64,
    end: f64,
}

#[derive(Debug, Clone, Default)]
struct SourceMetadata {
    duration: Option<f64>,
    intro: Option<TimeMarker>,
    outro: Option<TimeMarker>,
    server: Option<String>,
}

#[derive(Debug, Clone)]
struct ResolvedSource {
    playlist_url: String,
    tracks: Vec<SubtitleTrack>,
    internal_id: String,
    generation: u64,
    language: Option<String>,
    metadata: SourceMetadata,
}

#[derive(Debug, Clone, Copy)]
enum ResolveError {
    Invalid,
    Stale,
    NotFound,
    Upstream,
    RateLimited,
    Busy,
    TooLarge,
}

async fn send_with_retry<F>(mut build: F) -> Result<reqwest::Response, ResolveError>
where
    F: FnMut() -> reqwest::RequestBuilder,
{
    const ATTEMPTS: usize = 3;
    let deadline = Instant::now() + UPSTREAM_REQUEST_BUDGET;
    for attempt in 0..ATTEMPTS {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            STREAM_METRICS
                .upstream_errors
                .fetch_add(1, Ordering::Relaxed);
            return Err(ResolveError::Upstream);
        }
        STREAM_METRICS
            .upstream_attempts
            .fetch_add(1, Ordering::Relaxed);
        match tokio::time::timeout(remaining, build().send()).await {
            Ok(Ok(response)) => {
                let retryable = response.status() == StatusCode::TOO_MANY_REQUESTS
                    || response.status() == StatusCode::BAD_GATEWAY
                    || response.status() == StatusCode::SERVICE_UNAVAILABLE
                    || response.status() == StatusCode::GATEWAY_TIMEOUT;
                if !retryable {
                    return Ok(response);
                }
                if attempt + 1 == ATTEMPTS {
                    STREAM_METRICS
                        .upstream_errors
                        .fetch_add(1, Ordering::Relaxed);
                    return if response.status() == StatusCode::TOO_MANY_REQUESTS {
                        Err(ResolveError::RateLimited)
                    } else {
                        Err(ResolveError::Upstream)
                    };
                }
                STREAM_METRICS
                    .upstream_retries
                    .fetch_add(1, Ordering::Relaxed);
                let retry_after = response
                    .headers()
                    .get(RETRY_AFTER)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<u64>().ok())
                    .map(|seconds| Duration::from_secs(seconds.min(10)))
                    .unwrap_or_else(|| Duration::from_millis(250 * (1 << attempt)));
                let remaining = deadline.saturating_duration_since(Instant::now());
                if retry_after >= remaining {
                    STREAM_METRICS
                        .upstream_errors
                        .fetch_add(1, Ordering::Relaxed);
                    return Err(ResolveError::Upstream);
                }
                tokio::time::sleep(retry_after).await;
            }
            Ok(Err(_)) | Err(_) if attempt + 1 < ATTEMPTS => {
                STREAM_METRICS
                    .upstream_retries
                    .fetch_add(1, Ordering::Relaxed);
                let delay = Duration::from_millis(250 * (1 << attempt));
                let remaining = deadline.saturating_duration_since(Instant::now());
                if delay >= remaining {
                    STREAM_METRICS
                        .upstream_errors
                        .fetch_add(1, Ordering::Relaxed);
                    return Err(ResolveError::Upstream);
                }
                tokio::time::sleep(delay).await;
            }
            Ok(Err(_)) | Err(_) => {
                STREAM_METRICS
                    .upstream_errors
                    .fetch_add(1, Ordering::Relaxed);
                return Err(ResolveError::Upstream);
            }
        }
    }
    STREAM_METRICS
        .upstream_errors
        .fetch_add(1, Ordering::Relaxed);
    Err(ResolveError::Upstream)
}

async fn read_body_limited(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<Bytes, ResolveError> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(ResolveError::TooLarge);
    }
    let capacity = response.content_length().unwrap_or(0).min(max_bytes as u64) as usize;
    let read = async move {
        let mut stream = response.bytes_stream();
        let mut body = BytesMut::with_capacity(capacity);
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| ResolveError::Upstream)?;
            if body.len().saturating_add(chunk.len()) > max_bytes {
                return Err(ResolveError::TooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body.freeze())
    };
    tokio::time::timeout(UPSTREAM_BODY_TIMEOUT, read)
        .await
        .map_err(|_| ResolveError::Upstream)?
}

static SOURCE_CACHE: LazyLock<Cache<EpisodeKey, Arc<ResolvedSource>>> = LazyLock::new(|| {
    Cache::builder()
        .time_to_live(Duration::from_secs(10 * 60))
        .max_capacity(10_000)
        .build()
});

static FAILED_SOURCES: LazyLock<Cache<String, ()>> = LazyLock::new(|| {
    Cache::builder()
        .time_to_live(Duration::from_secs(5 * 60))
        .max_capacity(10_000)
        .build()
});

static PLAYLIST_CACHE: LazyLock<Cache<String, Arc<String>>> = LazyLock::new(|| {
    Cache::builder()
        .time_to_live(Duration::from_secs(5 * 60))
        .max_capacity(64 * 1024 * 1024)
        .weigher(|key: &String, playlist: &Arc<String>| {
            u32::try_from(key.len().saturating_add(playlist.len()).saturating_add(128))
                .unwrap_or(u32::MAX)
        })
        .build()
});

fn normalized_language(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "" | "sub" => Some("sub"),
        "dub" => Some("dub"),
        _ => None,
    }
}

fn parse_episode_key(uri: &Uri) -> Result<EpisodeKey, ResolveError> {
    let mut anilist_id = 0;
    let mut mal_id = 0;
    let mut anikoto_episode_id = String::new();
    let mut episode = 0;
    let mut language = "sub".to_string();
    let path_parts: Vec<_> = uri
        .path()
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    if path_parts.first() == Some(&"stream") && path_parts.get(1) == Some(&"s-2") {
        anikoto_episode_id = path_parts.get(2).copied().unwrap_or_default().to_string();
        if let Some(path_language) = path_parts.get(3) {
            language = (*path_language).to_string();
        }
    }
    for (key, value) in url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes()) {
        match key.as_ref() {
            "anilist_id" => anilist_id = value.parse().unwrap_or(0),
            "mal_id" => mal_id = value.parse().unwrap_or(0),
            "anikoto_episode_id" => anikoto_episode_id = value.into_owned(),
            "episode" => episode = value.parse().unwrap_or(0),
            "language" => language = value.into_owned(),
            _ => {}
        }
    }
    let Some(language) = normalized_language(&language) else {
        return Err(ResolveError::Invalid);
    };
    let valid_direct_id = !anikoto_episode_id.is_empty()
        && anikoto_episode_id.bytes().all(|byte| byte.is_ascii_digit());
    if !valid_direct_id && (episode <= 0 || (anilist_id <= 0 && mal_id <= 0)) {
        return Err(ResolveError::Invalid);
    }
    if valid_direct_id && episode <= 0 {
        episode = 1;
    }
    Ok(EpisodeKey {
        anilist_id,
        mal_id,
        anikoto_episode_id: if valid_direct_id {
            anikoto_episode_id
        } else {
            String::new()
        },
        episode,
        language: language.to_string(),
    })
}

fn query_value(uri: &Uri, name: &str) -> Option<String> {
    url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
        .find_map(|(key, value)| (key == name).then(|| value.into_owned()))
}

fn query_string(key: &EpisodeKey, extra: &[(&str, String)]) -> String {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    if key.anilist_id > 0 {
        query.append_pair("anilist_id", &key.anilist_id.to_string());
    }
    if key.mal_id > 0 {
        query.append_pair("mal_id", &key.mal_id.to_string());
    }
    if !key.anikoto_episode_id.is_empty() {
        query.append_pair("anikoto_episode_id", &key.anikoto_episode_id);
    }
    query.append_pair("episode", &key.episode.to_string());
    query.append_pair("language", &key.language);
    for (name, value) in extra {
        query.append_pair(name, value);
    }
    query.finish()
}

fn requested_source_generation(uri: &Uri) -> Result<Option<u64>, ResolveError> {
    query_value(uri, "source_generation")
        .map(|value| value.parse::<u64>().map_err(|_| ResolveError::Invalid))
        .transpose()
}

fn ensure_source_generation(
    source: &ResolvedSource,
    requested: Option<u64>,
) -> Result<(), ResolveError> {
    if requested.is_some_and(|generation| generation != source.generation) {
        return Err(ResolveError::Stale);
    }
    Ok(())
}

fn source_generation(internal_id: &str, language: Option<&str>) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;

    let mut hash = FNV_OFFSET;
    for part in [internal_id, language.unwrap_or_default()] {
        for byte in part.bytes().chain(std::iter::once(0)) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(FNV_PRIME);
        }
    }
    hash.max(1)
}

fn data_id(html: &str) -> Option<&str> {
    let marker = "data-id=\"";
    let start = html.find(marker)? + marker.len();
    let value = html.get(start..)?.split('"').next()?;
    (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())).then_some(value)
}

fn data_realid(html: &str) -> Option<&str> {
    let marker = "data-realid=\"";
    let start = html.find(marker)? + marker.len();
    let value = html.get(start..)?.split('\"').next()?;
    (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())).then_some(value)
}

fn embed_language(html: &str) -> Option<String> {
    let settings_start = html.find("const settings")?;
    let settings = html.get(settings_start..)?.split("};").next()?;
    for marker in ["type:", "\"type\":", "'type':"] {
        let Some(value) = settings.split_once(marker).map(|(_, value)| value) else {
            continue;
        };
        let value = value.trim_start();
        let quote = value.chars().next()?;
        if quote != '\'' && quote != '"' {
            continue;
        }
        let value = value.get(quote.len_utf8()..)?.split(quote).next()?.trim();
        if value == "sub" || value == "dub" {
            return Some(value.to_string());
        }
    }
    None
}

fn source_urls(internal_id: &str) -> Vec<String> {
    vec![
        format!("{MEGAPLAY_BASE}/stream/getSourcesNew?id={internal_id}"),
        format!("{MEGAPLAY_BASE}/stream/getSources?id={internal_id}"),
    ]
}

fn json_number(value: &serde_json::Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|value| value.trim().parse().ok()))
        .filter(|value: &f64| value.is_finite())
}

fn source_field<'a>(payload: &'a serde_json::Value, name: &str) -> Option<&'a serde_json::Value> {
    payload.get(name).or_else(|| {
        payload.get("sources").and_then(|sources| {
            sources
                .as_object()
                .and_then(|sources| sources.get(name))
                .or_else(|| sources.as_array()?.first()?.get(name))
        })
    })
}

fn source_file_url(payload: &serde_json::Value) -> Option<String> {
    let sources = payload.get("sources");
    let candidates = [
        payload.get("file"),
        sources.and_then(|sources| sources.get("file")),
        sources.and_then(|sources| sources.as_array()?.first()?.get("file")),
    ];
    candidates
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::trim)
        .find(|url| url.starts_with("https://") && url.contains(".m3u8"))
        .map(str::to_string)
}

fn source_marker(value: Option<&serde_json::Value>) -> Option<TimeMarker> {
    let value = value?;
    let (start, end) = if let Some(object) = value.as_object() {
        (object.get("start"), object.get("end"))
    } else if let Some(values) = value.as_array() {
        (values.first(), values.get(1))
    } else {
        (None, None)
    };
    let start = json_number(start?)?;
    let end = json_number(end?)?;
    (start >= 0.0 && end > start).then_some(TimeMarker { start, end })
}

fn source_label(value: Option<&serde_json::Value>) -> Option<String> {
    let value = value?;
    if let Some(label) = value.as_str() {
        let label = label.trim();
        return (!label.is_empty()).then(|| label.to_string());
    }
    value.as_i64().map(|value| value.to_string())
}

fn source_metadata(payload: &serde_json::Value) -> SourceMetadata {
    SourceMetadata {
        duration: source_field(payload, "duration")
            .and_then(json_number)
            .filter(|duration| *duration > 0.0),
        intro: source_marker(source_field(payload, "intro")),
        outro: source_marker(source_field(payload, "outro")),
        server: source_label(source_field(payload, "server")),
    }
}

fn track_language(track: &serde_json::Value) -> String {
    let language_code = ["language", "lang", "srclang"]
        .iter()
        .filter_map(|key| track.get(*key).and_then(serde_json::Value::as_str))
        .map(str::trim)
        .find(|value| !value.is_empty())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if language_code == "en" || language_code.starts_with("en-") {
        return "en".to_string();
    }
    if is_bcp47_language_tag(&language_code) {
        return language_code;
    }
    let label = track
        .get("label")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("und")
        .to_ascii_lowercase();
    let descriptor = format!("{language_code} {label}");
    match descriptor.as_str() {
        value if value == "en" || value.starts_with("en-") || value.contains("english") => "en",
        value if value.contains("indonesian") => "id",
        value if value.contains("thai") => "th",
        value if value.contains("spanish") => "es",
        value if value.contains("french") => "fr",
        value if value.contains("german") => "de",
        value if value.contains("portuguese") => "pt",
        value if value.contains("japanese") => "ja",
        value if value.contains("arabic") => "ar",
        value if value.contains("traditional") && value.contains("chinese") => "zh-hant",
        value if value.contains("simplified") && value.contains("chinese") => "zh-hans",
        value if value.contains("chinese") => "zh",
        value if value.contains("korean") => "ko",
        value if value.contains("russian") => "ru",
        value if value.contains("italian") => "it",
        value if value.contains("turkish") => "tr",
        value if value.contains("vietnamese") => "vi",
        value if value.contains("malay") => "ms",
        _ => "und",
    }
    .to_string()
}

fn is_bcp47_language_tag(value: &str) -> bool {
    let mut parts = value.split('-');
    let Some(primary) = parts.next() else {
        return false;
    };
    if !(2..=3).contains(&primary.len()) || !primary.bytes().all(|byte| byte.is_ascii_alphabetic())
    {
        return false;
    }
    parts.all(|part| {
        !part.is_empty() && part.len() <= 8 && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
    })
}

fn embed_urls(key: &EpisodeKey) -> Vec<String> {
    let mut urls = Vec::with_capacity(3);
    if !key.anikoto_episode_id.is_empty() {
        urls.push(format!(
            "{MEGAPLAY_BASE}/stream/s-2/{}/{}",
            key.anikoto_episode_id, key.language
        ));
    }
    if key.anilist_id > 0 {
        urls.push(format!(
            "{MEGAPLAY_BASE}/stream/ani/{}/{}/{}",
            key.anilist_id, key.episode, key.language
        ));
    }
    if key.mal_id > 0 {
        urls.push(format!(
            "{MEGAPLAY_BASE}/stream/mal/{}/{}/{}",
            key.mal_id, key.episode, key.language
        ));
    }
    urls
}

async fn resolve_source(
    client: &reqwest::Client,
    key: &EpisodeKey,
) -> Result<ResolvedSource, ResolveError> {
    let mut saw_upstream_error = false;
    for embed_url in embed_urls(key) {
        let response = match send_with_retry(|| {
            client
                .get(&embed_url)
                .header(ACCEPT, "text/html,application/xhtml+xml")
                .header(REFERER, MEGAPLAY_REFERER)
                .header("Origin", MEGAPLAY_BASE)
                .header("X-Requested-With", "XMLHttpRequest")
        })
        .await
        {
            Ok(response) => response,
            Err(_) => {
                saw_upstream_error = true;
                continue;
            }
        };
        if !response.status().is_success() {
            continue;
        }
        let body = match read_body_limited(response, MAX_METADATA_BYTES).await {
            Ok(body) => body,
            Err(_) => {
                saw_upstream_error = true;
                continue;
            }
        };
        let html = match String::from_utf8(body.to_vec()) {
            Ok(html) => html,
            Err(_) => {
                saw_upstream_error = true;
                continue;
            }
        };
        let Some(internal_id) = data_id(&html).or_else(|| data_realid(&html)) else {
            continue;
        };
        let embed_language = embed_language(&html);
        if let Some(actual_language) = embed_language.as_deref() {
            if actual_language != key.language {
                continue;
            }
        }
        for sources_url in source_urls(internal_id) {
            let response = match send_with_retry(|| {
                client
                    .get(&sources_url)
                    .header(ACCEPT, "application/json, text/plain, */*")
                    .header(REFERER, &embed_url)
                    .header("Origin", MEGAPLAY_BASE)
                    .header("X-Requested-With", "XMLHttpRequest")
            })
            .await
            {
                Ok(response) => response,
                Err(_) => {
                    saw_upstream_error = true;
                    continue;
                }
            };
            if !response.status().is_success() {
                continue;
            }
            let source_body = match read_body_limited(response, MAX_METADATA_BYTES).await {
                Ok(body) => body,
                Err(_) => {
                    saw_upstream_error = true;
                    continue;
                }
            };
            let payload: serde_json::Value = match serde_json::from_slice(&source_body) {
                Ok(payload) => payload,
                Err(_) => {
                    saw_upstream_error = true;
                    continue;
                }
            };
            let playlist_url = source_file_url(&payload);
            let Some(playlist_url) = playlist_url else {
                continue;
            };
            if FAILED_SOURCES.get(&playlist_url).await.is_some() {
                continue;
            }
            let metadata = source_metadata(&payload);
            let tracks = payload
                .get("tracks")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|track| {
                    let url = track.get("file")?.as_str()?;
                    if !url.starts_with("https://") {
                        return None;
                    }
                    Some(SubtitleTrack {
                        url: url.to_string(),
                        label: track
                            .get("label")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("Subtitles")
                            .to_string(),
                        language: track_language(track),
                        kind: track
                            .get("kind")
                            .or_else(|| track.get("type"))
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("subtitles")
                            .to_string(),
                        default: track
                            .get("default")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false),
                    })
                })
                .collect::<Vec<_>>();
            let generation = source_generation(internal_id, embed_language.as_deref());
            return Ok(ResolvedSource {
                playlist_url,
                tracks,
                internal_id: internal_id.to_string(),
                generation,
                language: embed_language.clone(),
                metadata,
            });
        }
    }
    if saw_upstream_error {
        Err(ResolveError::Upstream)
    } else {
        Err(ResolveError::NotFound)
    }
}

async fn get_source(
    client: &reqwest::Client,
    key: &EpisodeKey,
) -> Result<Arc<ResolvedSource>, ResolveError> {
    if let Some(source) = SOURCE_CACHE.get(key).await {
        STREAM_METRICS
            .source_cache_hits
            .fetch_add(1, Ordering::Relaxed);
        return Ok(source);
    }
    STREAM_METRICS
        .source_cache_misses
        .fetch_add(1, Ordering::Relaxed);
    let owned_client = client.clone();
    let owned_key = key.clone();
    SOURCE_CACHE
        .try_get_with(key.clone(), async move {
            let started_at = Instant::now();
            let result = resolve_source(&owned_client, &owned_key)
                .await
                .map(Arc::new);
            STREAM_METRICS
                .source_resolutions
                .fetch_add(1, Ordering::Relaxed);
            STREAM_METRICS.source_resolution_ms.fetch_add(
                started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
                Ordering::Relaxed,
            );
            result
        })
        .await
        .map_err(|error| *error)
}

async fn fetch_playlist(client: &reqwest::Client, url: &str) -> Result<Arc<String>, ResolveError> {
    if let Some(playlist) = PLAYLIST_CACHE.get(url).await {
        STREAM_METRICS
            .playlist_cache_hits
            .fetch_add(1, Ordering::Relaxed);
        return Ok(playlist);
    }
    STREAM_METRICS
        .playlist_cache_misses
        .fetch_add(1, Ordering::Relaxed);
    let owned_client = client.clone();
    let owned_url = url.to_string();
    PLAYLIST_CACHE
        .try_get_with(url.to_string(), async move {
            let started_at = Instant::now();
            let result = async {
                let parsed = Url::parse(&owned_url).map_err(|_| ResolveError::Upstream)?;
                if parsed.scheme() != "https" {
                    return Err(ResolveError::Upstream);
                }
                let response = send_with_retry(|| {
                    owned_client
                        .get(parsed.clone())
                        .header(
                            ACCEPT,
                            "application/vnd.apple.mpegurl,application/x-mpegURL,text/plain",
                        )
                        .header(REFERER, "https://megaplay.buzz/")
                })
                .await?;
                if !response.status().is_success() {
                    return Err(ResolveError::Upstream);
                }
                let text = Arc::new(
                    String::from_utf8(
                        read_body_limited(response, MAX_METADATA_BYTES)
                            .await?
                            .to_vec(),
                    )
                    .map_err(|_| ResolveError::Upstream)?,
                );
                if !text.trim_start().starts_with("#EXTM3U") {
                    return Err(ResolveError::Upstream);
                }
                Ok(text)
            }
            .await;
            STREAM_METRICS
                .playlist_resolutions
                .fetch_add(1, Ordering::Relaxed);
            STREAM_METRICS.playlist_resolution_ms.fetch_add(
                started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
                Ordering::Relaxed,
            );
            result
        })
        .await
        .map_err(|error| *error)
}

fn absolute_url(base: &str, value: &str) -> Option<String> {
    Url::parse(base)
        .ok()?
        .join(value.trim())
        .ok()
        .and_then(|url| (url.scheme() == "https").then(|| url.to_string()))
}

fn quoted_uri(line: &str) -> Option<(usize, usize, &str)> {
    let marker = "URI=\"";
    let start = line.find(marker)? + marker.len();
    let end = start + line.get(start..)?.find('"')?;
    Some((start, end, line.get(start..end)?))
}

fn hls_references(base_url: &str, playlist: &str) -> Vec<String> {
    let mut references = Vec::new();
    for line in playlist.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('#') {
            if let Some((_, _, value)) = quoted_uri(line) {
                if let Some(url) = absolute_url(base_url, value) {
                    references.push(url);
                }
            }
        } else if let Some(url) = absolute_url(base_url, line) {
            references.push(url);
        }
    }
    references
}

fn hls_variant_references(base_url: &str, playlist: &str) -> Vec<String> {
    let lines: Vec<_> = playlist.lines().map(str::trim).collect();
    let mut references = Vec::new();
    let mut expecting_variant = false;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if line.starts_with("#EXT-X-STREAM-INF:") {
            expecting_variant = true;
            continue;
        }
        if expecting_variant {
            if !line.starts_with('#') {
                if let Some(url) = absolute_url(base_url, line) {
                    references.push(url);
                }
            }
            expecting_variant = false;
        }
    }
    references
}

fn hls_master_references(base_url: &str, playlist: &str) -> Vec<String> {
    playlist
        .lines()
        .map(str::trim)
        .filter(|line| {
            line.starts_with("#EXT-X-MEDIA:") || line.starts_with("#EXT-X-I-FRAME-STREAM-INF:")
        })
        .filter_map(quoted_uri)
        .filter_map(|(_, _, value)| absolute_url(base_url, value))
        .collect()
}

fn hls_attribute_list(value: &str) -> Vec<(&str, &str)> {
    let mut attributes = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    for (index, character) in value.char_indices() {
        match character {
            '"' => quoted = !quoted,
            ',' if !quoted => {
                if let Some(attribute) = value.get(start..index) {
                    if let Some((key, value)) = attribute.split_once('=') {
                        attributes.push((key.trim(), value.trim().trim_matches('"')));
                    }
                }
                start = index + character.len_utf8();
            }
            _ => {}
        }
    }
    if let Some(attribute) = value.get(start..) {
        if let Some((key, value)) = attribute.split_once('=') {
            attributes.push((key.trim(), value.trim().trim_matches('"')));
        }
    }
    attributes
}

fn hls_attribute<'a>(attributes: &'a [(&str, &str)], name: &str) -> Option<&'a str> {
    attributes
        .iter()
        .find_map(|(key, value)| (*key == name).then_some(*value))
}

fn parse_hls_qualities(playlist: &str) -> Vec<(usize, u32, u32, u64, String)> {
    let mut qualities = Vec::new();
    for line in playlist.lines().map(str::trim) {
        let Some(attributes) = line.strip_prefix("#EXT-X-STREAM-INF:") else {
            continue;
        };
        let attributes = hls_attribute_list(attributes);
        let (width, height) = hls_attribute(&attributes, "RESOLUTION")
            .and_then(|resolution| resolution.split_once('x'))
            .map(|(width, height)| {
                (
                    width.parse::<u32>().unwrap_or(0),
                    height.parse::<u32>().unwrap_or(0),
                )
            })
            .unwrap_or((0, 0));
        let bitrate = hls_attribute(&attributes, "BANDWIDTH")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let codecs = hls_attribute(&attributes, "CODECS")
            .unwrap_or_default()
            .to_string();
        qualities.push((qualities.len(), width, height, bitrate, codecs));
    }
    qualities
}

fn parse_hls_audio_tracks(playlist: &str) -> Vec<(String, String, bool)> {
    let mut tracks = Vec::new();
    for line in playlist.lines().map(str::trim) {
        let Some(attributes) = line.strip_prefix("#EXT-X-MEDIA:") else {
            continue;
        };
        let attributes = hls_attribute_list(attributes);
        if hls_attribute(&attributes, "TYPE") != Some("AUDIO") {
            continue;
        }
        let language = hls_attribute(&attributes, "LANGUAGE")
            .unwrap_or("und")
            .to_ascii_lowercase();
        let label = hls_attribute(&attributes, "NAME")
            .or_else(|| hls_attribute(&attributes, "LANGUAGE"))
            .unwrap_or("Audio")
            .to_string();
        let default = matches!(
            hls_attribute(&attributes, "DEFAULT"),
            Some("YES" | "yes" | "TRUE" | "true" | "1")
        );
        tracks.push((label, language, default));
    }
    tracks
}

fn rewrite_hls_master<F, G>(
    playlist: &str,
    mut variant_route: F,
    mut resource_route: G,
) -> Result<String, ResolveError>
where
    F: FnMut(usize) -> String,
    G: FnMut(usize) -> String,
{
    let mut output = String::with_capacity(playlist.len() + 256);
    let mut expecting_variant = false;
    let mut variant_index = 0usize;
    let mut resource_index = 0usize;
    let mut replaced = false;
    for line in playlist.lines() {
        let trimmed = line.trim();
        if (trimmed.starts_with("#EXT-X-MEDIA:")
            || trimmed.starts_with("#EXT-X-I-FRAME-STREAM-INF:"))
            && quoted_uri(trimmed).is_some()
        {
            if let Some((start, end, _)) = quoted_uri(trimmed) {
                output.push_str(&trimmed[..start]);
                output.push_str(&resource_route(resource_index));
                output.push_str(&trimmed[end..]);
                resource_index += 1;
            }
            expecting_variant = false;
        } else if trimmed.starts_with("#EXT-X-STREAM-INF:") {
            expecting_variant = true;
            output.push_str(trimmed);
        } else if expecting_variant && !trimmed.is_empty() && !trimmed.starts_with('#') {
            output.push_str(&variant_route(variant_index));
            variant_index += 1;
            replaced = true;
            expecting_variant = false;
        } else {
            output.push_str(trimmed);
            if expecting_variant && !trimmed.is_empty() {
                expecting_variant = false;
            }
        }
        output.push('\n');
    }
    if !replaced {
        return Err(ResolveError::Upstream);
    }
    Ok(output)
}

fn rewrite_hls<F>(playlist: &str, mut route: F) -> Result<String, ResolveError>
where
    F: FnMut(usize) -> String,
{
    let mut output = String::with_capacity(playlist.len() + 512);
    let mut index = 0usize;
    for line in playlist.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            output.push('\n');
            continue;
        }
        if trimmed.starts_with('#') {
            if let Some((start, end, _)) = quoted_uri(trimmed) {
                output.push_str(&trimmed[..start]);
                output.push_str(&route(index));
                output.push_str(&trimmed[end..]);
                index += 1;
            } else {
                output.push_str(trimmed);
            }
        } else {
            output.push_str(&route(index));
            index += 1;
        }
        output.push('\n');
    }
    if index == 0 {
        return Err(ResolveError::Upstream);
    }
    Ok(output)
}

fn is_master_playlist(playlist: &str) -> bool {
    playlist.lines().any(|line| {
        let line = line.trim();
        line.starts_with("#EXT-X-STREAM-INF") || line.starts_with("#EXT-X-MEDIA:")
    })
}

async fn invalidate_source(key: &EpisodeKey, playlist_urls: &[&str]) {
    SOURCE_CACHE.invalidate(key).await;
    for url in playlist_urls {
        PLAYLIST_CACHE.invalidate(*url).await;
    }
    STREAM_METRICS
        .source_refreshes
        .fetch_add(1, Ordering::Relaxed);
}

async fn reject_source(key: &EpisodeKey, source: &ResolvedSource, playlist_urls: &[&str]) {
    FAILED_SOURCES.insert(source.playlist_url.clone(), ()).await;
    invalidate_source(key, playlist_urls).await;
}

async fn source_master(
    state: &AppState,
    key: &EpisodeKey,
) -> Result<(Arc<ResolvedSource>, Arc<String>), ResolveError> {
    let source = get_source(&state.asset_client, key).await?;
    match fetch_playlist(&state.asset_client, &source.playlist_url).await {
        Ok(master) => Ok((source, master)),
        Err(ResolveError::Upstream | ResolveError::NotFound) => {
            reject_source(key, &source, &[&source.playlist_url]).await;
            let source = get_source(&state.asset_client, key).await?;
            let master = fetch_playlist(&state.asset_client, &source.playlist_url).await?;
            Ok((source, master))
        }
        Err(error) => Err(error),
    }
}

async fn media_playlist(
    state: &AppState,
    key: &EpisodeKey,
    variant: i32,
    requested_generation: Option<u64>,
) -> Result<(Arc<ResolvedSource>, String, Arc<String>), ResolveError> {
    let (source, master) = source_master(state, key).await?;
    ensure_source_generation(&source, requested_generation)?;
    if !is_master_playlist(&master) {
        if variant == -1 || variant == 0 {
            return Ok((source.clone(), source.playlist_url.clone(), master));
        }
        return Err(ResolveError::Invalid);
    }
    if variant < 0 {
        return Err(ResolveError::Invalid);
    }
    let variants = hls_variant_references(&source.playlist_url, &master);
    let url = variants
        .get(variant as usize)
        .ok_or(ResolveError::Invalid)?
        .clone();
    match fetch_playlist(&state.asset_client, &url).await {
        Ok(playlist) => Ok((source.clone(), url, playlist)),
        Err(ResolveError::Upstream | ResolveError::NotFound) => {
            reject_source(key, &source, &[&source.playlist_url, &url]).await;
            let (source, master) = source_master(state, key).await?;
            ensure_source_generation(&source, requested_generation)?;
            let variants = hls_variant_references(&source.playlist_url, &master);
            let url = variants
                .get(variant as usize)
                .ok_or(ResolveError::Invalid)?
                .clone();
            let playlist = fetch_playlist(&state.asset_client, &url).await?;
            Ok((source, url, playlist))
        }
        Err(error) => Err(error),
    }
}

async fn master_resource_playlist(
    state: &AppState,
    key: &EpisodeKey,
    resource: usize,
    requested_generation: Option<u64>,
) -> Result<(Arc<ResolvedSource>, String, Arc<String>), ResolveError> {
    let (source, master) = source_master(state, key).await?;
    ensure_source_generation(&source, requested_generation)?;
    let resources = hls_master_references(&source.playlist_url, &master);
    let url = resources
        .get(resource)
        .ok_or(ResolveError::Invalid)?
        .clone();
    match fetch_playlist(&state.asset_client, &url).await {
        Ok(playlist) => Ok((source, url, playlist)),
        Err(ResolveError::Upstream | ResolveError::NotFound) => {
            reject_source(key, &source, &[&source.playlist_url, &url]).await;
            let (source, master) = source_master(state, key).await?;
            ensure_source_generation(&source, requested_generation)?;
            let resources = hls_master_references(&source.playlist_url, &master);
            let url = resources
                .get(resource)
                .ok_or(ResolveError::Invalid)?
                .clone();
            let playlist = fetch_playlist(&state.asset_client, &url).await?;
            Ok((source, url, playlist))
        }
        Err(error) => Err(error),
    }
}

fn playlist_response(body: String) -> Response {
    let mut response = body.into_response();
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/vnd.apple.mpegurl"),
    );
    response.headers_mut().insert(
        "Cache-Control",
        HeaderValue::from_static("private, max-age=60, no-transform"),
    );
    response
}

fn error_response(error: ResolveError) -> Response {
    let (status, message) = match error {
        ResolveError::Invalid => (
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid episode stream request",
        ),
        ResolveError::Stale => (StatusCode::CONFLICT, "stale episode stream resource"),
        ResolveError::NotFound => (StatusCode::NOT_FOUND, "episode is unavailable"),
        ResolveError::Upstream => (
            StatusCode::BAD_GATEWAY,
            "anime stream source is unavailable",
        ),
        ResolveError::RateLimited => (
            StatusCode::SERVICE_UNAVAILABLE,
            "anime stream source is rate limited; retry shortly",
        ),
        ResolveError::Busy => (
            StatusCode::SERVICE_UNAVAILABLE,
            "stream proxy is at upstream capacity; retry shortly",
        ),
        ResolveError::TooLarge => (
            StatusCode::BAD_GATEWAY,
            "upstream media segment exceeds the configured safety limit",
        ),
    };
    let mut response = (status, negative_message(message)).into_response();
    if matches!(error, ResolveError::RateLimited | ResolveError::Busy) {
        response
            .headers_mut()
            .insert(RETRY_AFTER, HeaderValue::from_static("5"));
    }
    response
}

async fn master_handler(state: &AppState, key: &EpisodeKey) -> Result<Response, ResolveError> {
    let (source, master) = source_master(state, key).await?;
    let source_generation = source.generation.to_string();
    if is_master_playlist(&master) {
        let query = query_string(key, &[]);
        let rewritten = rewrite_hls_master(
            &master,
            |variant| {
                format!(
                    "/stream/anikoto/variant?{query}&source_generation={source_generation}&variant={variant}"
                )
            },
            |resource| {
                format!(
                    "/stream/anikoto/resource?{query}&source_generation={source_generation}&master_resource={resource}"
                )
            },
        )?;
        Ok(playlist_response(rewritten))
    } else {
        let query = query_string(key, &[]);
        let rewritten = rewrite_hls(&master, |resource| {
            format!(
                "/stream/anikoto/resource?{query}&source_generation={source_generation}&variant=-1&resource={resource}"
            )
        })?;
        Ok(playlist_response(rewritten))
    }
}

async fn variant_handler(
    state: &AppState,
    key: &EpisodeKey,
    uri: &Uri,
) -> Result<Response, ResolveError> {
    let variant = query_value(uri, "variant")
        .and_then(|value| value.parse::<i32>().ok())
        .ok_or(ResolveError::Invalid)?;
    let requested_generation = requested_source_generation(uri)?;
    let (source, _, playlist) = media_playlist(state, key, variant, requested_generation).await?;
    let query = query_string(
        key,
        &[
            ("source_generation", source.generation.to_string()),
            ("variant", variant.to_string()),
        ],
    );
    let rewritten = rewrite_hls(&playlist, |resource| {
        format!("/stream/anikoto/resource?{query}&resource={resource}")
    })?;
    Ok(playlist_response(rewritten))
}

fn has_media_signature(body: &[u8], offset: usize) -> bool {
    let Some(body) = body.get(offset..) else {
        return false;
    };
    let transport_stream = body.first() == Some(&0x47) && body.get(188) == Some(&0x47);
    let fragmented_mp4 = body
        .get(4..8)
        .is_some_and(|marker| matches!(marker, b"ftyp" | b"styp" | b"moof"));
    transport_stream || fragmented_mp4
}

fn media_prefix_len(body: &[u8]) -> usize {
    if has_media_signature(body, 0) {
        0
    } else if has_media_signature(body, SEGMENT_PREFIX_BYTES) {
        SEGMENT_PREFIX_BYTES
    } else {
        0
    }
}

#[derive(Clone, Copy)]
enum CacheStatus {
    Memory,
    Disk,
    Miss,
    Coalesced,
}

impl CacheStatus {
    fn header(self) -> HeaderValue {
        HeaderValue::from_static(match self {
            Self::Memory => "HIT",
            Self::Disk => "DISK",
            Self::Miss => "MISS",
            Self::Coalesced => "COALESCED",
        })
    }
}

fn parse_byte_range(value: &str, length: usize) -> Result<(usize, usize), ()> {
    let value = value.strip_prefix("bytes=").ok_or(())?;
    if value.contains(',') || length == 0 {
        return Err(());
    }
    let (start, end) = value.split_once('-').ok_or(())?;
    if start.is_empty() {
        let suffix = end.parse::<usize>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        return Ok((length.saturating_sub(suffix), length - 1));
    }
    let start = start.parse::<usize>().map_err(|_| ())?;
    if start >= length {
        return Err(());
    }
    let end = if end.is_empty() {
        length - 1
    } else {
        end.parse::<usize>().map_err(|_| ())?.min(length - 1)
    };
    (start <= end).then_some((start, end)).ok_or(())
}

fn cached_response(
    cached: Arc<CachedResponse>,
    method: &Method,
    request_headers: &HeaderMap,
    cache_status: CacheStatus,
) -> Response {
    let mut status = StatusCode::from_u16(cached.status).unwrap_or(StatusCode::OK);
    let mut headers = cached.headers.clone();
    let upstream_content_type = headers.get(CONTENT_TYPE).cloned();
    headers.insert(
        CONTENT_TYPE,
        normalized_content_type(&cached.body, upstream_content_type),
    );
    headers.insert("X-Cache", cache_status.header());
    headers.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    let mut body = cached.body.clone();

    if status == StatusCode::OK {
        if let Some(range) = request_headers
            .get(RANGE)
            .and_then(|value| value.to_str().ok())
        {
            STREAM_METRICS
                .range_requests
                .fetch_add(1, Ordering::Relaxed);
            match parse_byte_range(range, body.len()) {
                Ok((start, end)) => {
                    status = StatusCode::PARTIAL_CONTENT;
                    body = body.slice(start..=end);
                    if let Ok(value) =
                        HeaderValue::from_str(&format!("bytes {start}-{end}/{}", cached.body.len()))
                    {
                        headers.insert(CONTENT_RANGE, value);
                    }
                }
                Err(()) => {
                    let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
                    if let Ok(value) =
                        HeaderValue::from_str(&format!("bytes */{}", cached.body.len()))
                    {
                        response.headers_mut().insert(CONTENT_RANGE, value);
                    }
                    response
                        .headers_mut()
                        .insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
                    response
                        .headers_mut()
                        .insert("X-Cache", cache_status.header());
                    return response;
                }
            }
        }
    }

    if let Ok(value) = HeaderValue::from_str(&body.len().to_string()) {
        headers.insert(CONTENT_LENGTH, value);
    }
    if method != Method::HEAD {
        STREAM_METRICS
            .bytes_served
            .fetch_add(body.len() as u64, Ordering::Relaxed);
    }
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(body)
    };
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    response
}

fn normalized_content_type(body: &Bytes, upstream: Option<HeaderValue>) -> HeaderValue {
    let is_transport_stream =
        body.first() == Some(&0x47) && (body.len() <= 188 || body.get(188) == Some(&0x47));
    if is_transport_stream {
        return HeaderValue::from_static("video/mp2t");
    }
    if body.len() >= 8 && matches!(&body[4..8], b"ftyp" | b"styp" | b"moof") {
        return HeaderValue::from_static("video/mp4");
    }
    upstream.unwrap_or_else(|| HeaderValue::from_static("application/octet-stream"))
}

struct DownstreamBodyMetrics {
    expected: u64,
    yielded: u64,
    failed: bool,
}

impl DownstreamBodyMetrics {
    fn observe(&mut self, item: &std::io::Result<Bytes>) {
        match item {
            Ok(chunk) => {
                self.yielded = self.yielded.saturating_add(chunk.len() as u64);
                STREAM_METRICS
                    .bytes_served
                    .fetch_add(chunk.len() as u64, Ordering::Relaxed);
            }
            Err(_) => self.failed = true,
        }
    }
}

impl Drop for DownstreamBodyMetrics {
    fn drop(&mut self) {
        if !self.failed && self.yielded < self.expected {
            STREAM_METRICS
                .downstream_cancellations
                .fetch_add(1, Ordering::Relaxed);
        }
    }
}

struct SegmentFillAttempt {
    handed_off: bool,
}

impl SegmentFillAttempt {
    fn start() -> Self {
        Self { handed_off: false }
    }

    fn hand_off(&mut self) {
        self.handed_off = true;
    }
}

impl Drop for SegmentFillAttempt {
    fn drop(&mut self) {
        if !self.handed_off {
            STREAM_METRICS
                .segment_failed_fills
                .fetch_add(1, Ordering::Relaxed);
        }
    }
}

async fn disk_cached_response(
    mut cached: StreamDiskEntry,
    method: &Method,
    request_headers: &HeaderMap,
    cache_status: CacheStatus,
) -> Result<Response, ResolveError> {
    let total_len = usize::try_from(cached.body_len).map_err(|_| ResolveError::TooLarge)?;
    let mut status = StatusCode::from_u16(cached.status).unwrap_or(StatusCode::OK);
    let mut headers = cached.headers;
    headers.insert("X-Cache", cache_status.header());
    headers.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.remove(CONTENT_RANGE);

    let mut start = 0usize;
    let mut end = total_len.saturating_sub(1);
    if status == StatusCode::OK {
        if let Some(range) = request_headers
            .get(RANGE)
            .and_then(|value| value.to_str().ok())
        {
            STREAM_METRICS
                .range_requests
                .fetch_add(1, Ordering::Relaxed);
            match parse_byte_range(range, total_len) {
                Ok((range_start, range_end)) => {
                    start = range_start;
                    end = range_end;
                    status = StatusCode::PARTIAL_CONTENT;
                    if let Ok(value) =
                        HeaderValue::from_str(&format!("bytes {start}-{end}/{total_len}"))
                    {
                        headers.insert(CONTENT_RANGE, value);
                    }
                }
                Err(()) => {
                    let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
                    if let Ok(value) = HeaderValue::from_str(&format!("bytes */{total_len}")) {
                        response.headers_mut().insert(CONTENT_RANGE, value);
                    }
                    response
                        .headers_mut()
                        .insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
                    response
                        .headers_mut()
                        .insert("X-Cache", cache_status.header());
                    return Ok(response);
                }
            }
        }
    }

    let response_len = if total_len == 0 { 0 } else { end - start + 1 };
    headers.insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&response_len.to_string()).map_err(|_| ResolveError::Upstream)?,
    );
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        cached
            .reader
            .seek(SeekFrom::Start(cached.body_offset + start as u64))
            .await
            .map_err(|_| ResolveError::Upstream)?;
        let reader = cached.reader.take(response_len as u64);
        let mut metrics = DownstreamBodyMetrics {
            expected: response_len as u64,
            yielded: 0,
            failed: false,
        };
        let stream = ReaderStream::new(reader).map(move |item| {
            metrics.observe(&item);
            item
        });
        Body::from_stream(stream)
    };
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    Ok(response)
}

struct SegmentFill {
    cache_key: String,
    cache: Cache<String, Arc<CachedResponse>>,
    headers: HeaderMap,
    expected_len: Option<usize>,
    max_entry_size: usize,
    ram_limit: usize,
    ram: Option<BytesMut>,
    disk: Option<StreamCacheWriter>,
    disk_failed: bool,
    sender: Option<mpsc::Sender<std::io::Result<Bytes>>>,
    downstream_range: Option<(usize, usize)>,
    downstream_cancelled: bool,
    bytes: usize,
}

impl SegmentFill {
    async fn push(&mut self, chunk: Bytes) -> Result<(), ResolveError> {
        let chunk_start = self.bytes;
        let next_len = self
            .bytes
            .checked_add(chunk.len())
            .ok_or(ResolveError::TooLarge)?;
        if next_len > self.max_entry_size {
            return Err(ResolveError::TooLarge);
        }
        self.bytes = next_len;

        if let Some(sender) = self.sender.as_ref() {
            let downstream = if let Some((range_start, range_end)) = self.downstream_range {
                let chunk_end = next_len.saturating_sub(1);
                if chunk_end < range_start || chunk_start > range_end {
                    None
                } else {
                    let start = range_start.saturating_sub(chunk_start);
                    let end = (range_end + 1).saturating_sub(chunk_start).min(chunk.len());
                    (start < end).then(|| chunk.slice(start..end))
                }
            } else {
                Some(chunk.clone())
            };
            if let Some(downstream) = downstream {
                let downstream_len = downstream.len();
                if sender.send(Ok(downstream)).await.is_err() {
                    self.sender = None;
                    self.record_downstream_cancellation();
                } else {
                    STREAM_METRICS
                        .bytes_served
                        .fetch_add(downstream_len as u64, Ordering::Relaxed);
                }
            }
        }
        if self
            .downstream_range
            .is_some_and(|(_, range_end)| next_len > range_end)
        {
            self.sender.take();
        }

        if let Some(writer) = self.disk.as_mut() {
            if writer.write(&chunk).await.is_err() {
                self.disk.take();
                self.disk_failed = true;
            }
        }
        if let Some(ram) = self.ram.as_mut() {
            if next_len > self.ram_limit {
                self.ram = None;
            } else {
                ram.extend_from_slice(&chunk);
            }
        }
        Ok(())
    }

    fn record_downstream_cancellation(&mut self) {
        if !self.downstream_cancelled {
            self.downstream_cancelled = true;
            STREAM_METRICS
                .downstream_cancellations
                .fetch_add(1, Ordering::Relaxed);
        }
    }

    async fn fail_downstream(&mut self) {
        if let Some(sender) = self.sender.take() {
            let error = std::io::Error::other("upstream media stream failed... /ᐠ - ˕ -マ");
            if sender.send(Err(error)).await.is_err() {
                self.record_downstream_cancellation();
            }
        }
    }

    async fn finish(&mut self) -> Result<(), ResolveError> {
        if self
            .expected_len
            .is_some_and(|expected| expected != self.bytes)
        {
            return Err(ResolveError::Upstream);
        }
        self.sender.take();
        self.headers.insert(
            CONTENT_LENGTH,
            HeaderValue::from_str(&self.bytes.to_string()).map_err(|_| ResolveError::Upstream)?,
        );

        let mut published = false;
        if let Some(writer) = self.disk.take() {
            if writer.commit().await.is_ok() {
                published = true;
            } else {
                self.disk_failed = true;
            }
        }
        if self.disk_failed {
            STREAM_METRICS
                .segment_disk_write_failures
                .fetch_add(1, Ordering::Relaxed);
        }
        if let Some(body) = self.ram.take() {
            let cached = Arc::new(CachedResponse {
                status: StatusCode::OK.as_u16(),
                headers: self.headers.clone(),
                body: body.freeze(),
            });
            self.cache.insert(self.cache_key.clone(), cached).await;
            published = true;
        }
        published.then_some(()).ok_or(ResolveError::Upstream)
    }
}

async fn run_segment_fill(
    mut fill: SegmentFill,
    initial_chunks: Vec<Bytes>,
    response: reqwest::Response,
    started_at: Instant,
    mut fill_guard: tokio::sync::OwnedMutexGuard<Option<bool>>,
    completion: tokio::sync::oneshot::Sender<Result<(), ResolveError>>,
    _permit: adaptive_capacity::AdaptivePermit,
) {
    let mut upstream = response.bytes_stream();
    let read_result = tokio::time::timeout(UPSTREAM_BODY_TIMEOUT, async {
        for chunk in initial_chunks {
            fill.push(chunk).await?;
        }
        while let Some(chunk) = upstream.next().await {
            fill.push(chunk.map_err(|_| ResolveError::Upstream)?)
                .await?;
        }
        Ok::<(), ResolveError>(())
    })
    .await
    .map_err(|_| ResolveError::Upstream)
    .and_then(|result| result);

    let result = match read_result {
        Ok(()) => fill.finish().await,
        Err(error) => Err(error),
    };
    STREAM_METRICS
        .segment_upstream_downloads
        .fetch_add(1, Ordering::Relaxed);
    STREAM_METRICS.segment_upstream_download_ms.fetch_add(
        started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
        Ordering::Relaxed,
    );
    STREAM_METRICS
        .segment_upstream_bytes
        .fetch_add(fill.bytes as u64, Ordering::Relaxed);
    if result.is_err() {
        STREAM_METRICS
            .segment_failed_fills
            .fetch_add(1, Ordering::Relaxed);
        if fill.bytes > 0 {
            STREAM_METRICS
                .segment_partial_fills
                .fetch_add(1, Ordering::Relaxed);
        }
        fill.fail_downstream().await;
    }
    *fill_guard = Some(result.is_ok());
    let _ = completion.send(result);
}

async fn get_cached_upstream_resource(
    state: &AppState,
    upstream_url: &str,
    inspect_media_prefix: bool,
    accept: &'static str,
    method: &Method,
    request_headers: &HeaderMap,
) -> Result<Response, ResolveError> {
    let cache_key = format!(
        "anikoto:{}:{upstream_url}",
        if inspect_media_prefix {
            "stripped"
        } else {
            "raw"
        }
    );
    let max_entry_size = state.stream_max_entry_size;
    let mut coalesced = false;

    loop {
        if let Some(cached) = state.stream_cache.get(&cache_key).await {
            STREAM_METRICS
                .segment_memory_hits
                .fetch_add(1, Ordering::Relaxed);
            return Ok(cached_response(
                cached,
                method,
                request_headers,
                if coalesced {
                    CacheStatus::Coalesced
                } else {
                    CacheStatus::Memory
                },
            ));
        }
        if let Some(cached) =
            load_stream_from_disk(&cache_key, max_entry_size, state.disk_cache_max_age_secs).await
        {
            STREAM_METRICS
                .segment_disk_hits
                .fetch_add(1, Ordering::Relaxed);
            return disk_cached_response(
                cached,
                method,
                request_headers,
                if coalesced {
                    CacheStatus::Coalesced
                } else {
                    CacheStatus::Disk
                },
            )
            .await;
        }

        let slot = state
            .stream_fills
            .get_with(cache_key.clone(), async {
                Arc::new(tokio::sync::Mutex::new(None))
            })
            .await;
        let mut fill_guard = match slot.clone().try_lock_owned() {
            Ok(fill_guard) => fill_guard,
            Err(_) => {
                let fill_guard = slot.lock_owned().await;
                let succeeded = *fill_guard == Some(true);
                drop(fill_guard);
                STREAM_METRICS
                    .segment_coalesced
                    .fetch_add(1, Ordering::Relaxed);
                if !succeeded {
                    return Err(ResolveError::Upstream);
                }
                coalesced = true;
                continue;
            }
        };

        if let Some(cached) = state.stream_cache.get(&cache_key).await {
            drop(fill_guard);
            STREAM_METRICS
                .segment_memory_hits
                .fetch_add(1, Ordering::Relaxed);
            return Ok(cached_response(
                cached,
                method,
                request_headers,
                CacheStatus::Memory,
            ));
        }
        if let Some(cached) =
            load_stream_from_disk(&cache_key, max_entry_size, state.disk_cache_max_age_secs).await
        {
            drop(fill_guard);
            STREAM_METRICS
                .segment_disk_hits
                .fetch_add(1, Ordering::Relaxed);
            return disk_cached_response(cached, method, request_headers, CacheStatus::Disk).await;
        }

        *fill_guard = None;
        STREAM_METRICS
            .segment_cache_misses
            .fetch_add(1, Ordering::Relaxed);
        let mut fill_attempt = SegmentFillAttempt::start();
        let permit = match state
            .stream_upstream_permit
            .acquire_timeout(Duration::from_secs(10))
            .await
        {
            Some(permit) => permit,
            None => {
                *fill_guard = Some(false);
                return Err(ResolveError::Busy);
            }
        };

        let started_at = Instant::now();
        let mut response = match send_with_retry(|| {
            state
                .asset_client
                .get(upstream_url)
                .header(ACCEPT, accept)
                .header(REFERER, "https://megaplay.buzz/")
        })
        .await
        {
            Ok(response) => response,
            Err(error) => {
                *fill_guard = Some(false);
                return Err(error);
            }
        };
        if response.status() == StatusCode::NOT_FOUND {
            *fill_guard = Some(false);
            return Err(ResolveError::NotFound);
        }
        if !response.status().is_success() {
            *fill_guard = Some(false);
            return Err(ResolveError::Upstream);
        }

        let raw_len = response.content_length();
        let max_prefix_len = inspect_media_prefix
            .then_some(SEGMENT_PREFIX_BYTES)
            .unwrap_or(0);
        if raw_len
            .is_some_and(|length| length > max_entry_size.saturating_add(max_prefix_len) as u64)
        {
            *fill_guard = Some(false);
            return Err(ResolveError::TooLarge);
        }
        let content_type = response.headers().get(CONTENT_TYPE).cloned();
        let detection_bytes = SEGMENT_PREFIX_BYTES + 189;
        let mut initial = BytesMut::with_capacity(detection_bytes);
        let mut ttfb_recorded = false;
        loop {
            let next = match tokio::time::timeout(UPSTREAM_BODY_TIMEOUT, response.chunk()).await {
                Ok(Ok(next)) => next,
                _ => {
                    *fill_guard = Some(false);
                    return Err(ResolveError::Upstream);
                }
            };
            let Some(chunk) = next else {
                break;
            };
            if !ttfb_recorded && !chunk.is_empty() {
                ttfb_recorded = true;
                STREAM_METRICS.segment_upstream_ttfb_ms.fetch_add(
                    started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
                    Ordering::Relaxed,
                );
                STREAM_METRICS
                    .segment_upstream_ttfb_samples
                    .fetch_add(1, Ordering::Relaxed);
            }
            if initial.len().saturating_add(chunk.len())
                > max_entry_size.saturating_add(max_prefix_len)
            {
                *fill_guard = Some(false);
                return Err(ResolveError::TooLarge);
            }
            initial.extend_from_slice(&chunk);
            if !inspect_media_prefix || initial.len() >= detection_bytes {
                break;
            }
        }
        if initial.is_empty() {
            *fill_guard = Some(false);
            return Err(ResolveError::Upstream);
        }
        let prefix_len = if inspect_media_prefix {
            media_prefix_len(&initial)
        } else {
            0
        };
        if raw_len.is_some_and(|length| length <= prefix_len as u64) {
            *fill_guard = Some(false);
            return Err(ResolveError::Upstream);
        }
        let expected_len = raw_len.map(|length| length as usize - prefix_len);
        let first_output = initial.freeze().slice(prefix_len..);
        let initial_chunks = vec![first_output.clone()];

        let mut cache_headers = HeaderMap::new();
        cache_headers.insert(
            CONTENT_TYPE,
            normalized_content_type(&first_output, content_type),
        );
        if let Some(length) = expected_len {
            cache_headers.insert(
                CONTENT_LENGTH,
                HeaderValue::from_str(&length.to_string()).map_err(|_| ResolveError::Upstream)?,
            );
        }
        cache_headers.insert(
            "Cache-Control",
            HeaderValue::from_static("public, max-age=86400, stale-if-error=604800, no-transform"),
        );

        let (disk, disk_failed) =
            match StreamCacheWriter::create(&cache_key, StatusCode::OK.as_u16(), &cache_headers)
                .await
            {
                Ok(writer) => (Some(writer), false),
                Err(_) => (None, true),
            };
        let range_value = request_headers
            .get(RANGE)
            .and_then(|value| value.to_str().ok());
        if range_value.is_some() {
            STREAM_METRICS
                .range_requests
                .fetch_add(1, Ordering::Relaxed);
        }
        let parsed_range = match (range_value, expected_len) {
            (Some(range), Some(length)) => Some(parse_byte_range(range, length)),
            _ => None,
        };
        let deferred_range = range_value.is_some() && expected_len.is_none();
        let invalid_range = matches!(parsed_range, Some(Err(())));
        let downstream_range = parsed_range.and_then(Result::ok);
        let (sender, receiver) = if method != Method::HEAD && !invalid_range && !deferred_range {
            let (sender, receiver) = mpsc::channel(state.channel_buffer.max(1));
            (Some(sender), Some(receiver))
        } else {
            (None, None)
        };
        let ram_limit = state.ram_cache_limit.min(max_entry_size);
        let ram_capacity = expected_len.unwrap_or_default().min(ram_limit);
        let ram = (ram_limit > 0 && expected_len.is_none_or(|length| length <= ram_limit))
            .then(|| BytesMut::with_capacity(ram_capacity));
        let fill = SegmentFill {
            cache_key: cache_key.clone(),
            cache: state.stream_cache.clone(),
            headers: cache_headers.clone(),
            expected_len,
            max_entry_size,
            ram_limit,
            ram,
            disk,
            disk_failed,
            sender,
            downstream_range,
            downstream_cancelled: false,
            bytes: 0,
        };
        let (completion_sender, completion_receiver) = tokio::sync::oneshot::channel();
        fill_attempt.hand_off();
        tokio::spawn(run_segment_fill(
            fill,
            initial_chunks,
            response,
            started_at,
            fill_guard,
            completion_sender,
            permit,
        ));

        if deferred_range {
            match completion_receiver.await {
                Ok(Ok(())) => {
                    if let Some(cached) = state.stream_cache.get(&cache_key).await {
                        return Ok(cached_response(
                            cached,
                            method,
                            request_headers,
                            CacheStatus::Miss,
                        ));
                    }
                    if let Some(cached) = load_stream_from_disk(
                        &cache_key,
                        max_entry_size,
                        state.disk_cache_max_age_secs,
                    )
                    .await
                    {
                        return disk_cached_response(
                            cached,
                            method,
                            request_headers,
                            CacheStatus::Miss,
                        )
                        .await;
                    }
                    return Err(ResolveError::Upstream);
                }
                Ok(Err(error)) => return Err(error),
                Err(_) => return Err(ResolveError::Upstream),
            }
        }

        if invalid_range {
            let length = expected_len.unwrap_or_default();
            let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
            response
                .headers_mut()
                .insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            response
                .headers_mut()
                .insert("X-Cache", CacheStatus::Miss.header());
            if let Ok(value) = HeaderValue::from_str(&format!("bytes */{length}")) {
                response.headers_mut().insert(CONTENT_RANGE, value);
            }
            return Ok(response);
        }

        let mut downstream_headers = cache_headers;
        downstream_headers.insert("X-Cache", CacheStatus::Miss.header());
        downstream_headers.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        let mut status = StatusCode::OK;
        if let Some((start, end)) = downstream_range {
            status = StatusCode::PARTIAL_CONTENT;
            let length = expected_len.unwrap_or_default();
            downstream_headers.insert(
                CONTENT_LENGTH,
                HeaderValue::from_str(&(end - start + 1).to_string())
                    .map_err(|_| ResolveError::Upstream)?,
            );
            downstream_headers.insert(
                CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes {start}-{end}/{length}"))
                    .map_err(|_| ResolveError::Upstream)?,
            );
        }
        let body = if method == Method::HEAD {
            Body::empty()
        } else {
            let Some(receiver) = receiver else {
                return Err(ResolveError::Upstream);
            };
            Body::from_stream(ReceiverStream::new(receiver))
        };
        let mut downstream = Response::new(body);
        *downstream.status_mut() = status;
        *downstream.headers_mut() = downstream_headers;
        return Ok(downstream);
    }
}

async fn resource_handler(
    state: &AppState,
    key: &EpisodeKey,
    uri: &Uri,
    method: &Method,
    request_headers: &HeaderMap,
) -> Result<Response, ResolveError> {
    let requested_generation = requested_source_generation(uri)?;
    if let Some(master_resource) = query_value(uri, "master_resource") {
        let master_resource = master_resource
            .parse::<usize>()
            .map_err(|_| ResolveError::Invalid)?;
        let (source, playlist_url, playlist) =
            master_resource_playlist(state, key, master_resource, requested_generation).await?;
        if query_value(uri, "resource").is_none() {
            let query = query_string(
                key,
                &[
                    ("source_generation", source.generation.to_string()),
                    ("master_resource", master_resource.to_string()),
                ],
            );
            let rewritten = rewrite_hls(&playlist, |resource| {
                format!("/stream/anikoto/resource?{query}&resource={resource}")
            })?;
            return Ok(playlist_response(rewritten));
        }
        let resource = query_value(uri, "resource")
            .and_then(|value| value.parse::<usize>().ok())
            .ok_or(ResolveError::Invalid)?;
        let resources = hls_references(&playlist_url, &playlist);
        let upstream_url = resources.get(resource).ok_or(ResolveError::Invalid)?;
        let fetched = get_cached_upstream_resource(
            state,
            upstream_url,
            true,
            "video/mp2t,video/mp4,application/octet-stream,*/*",
            method,
            request_headers,
        )
        .await;
        return match fetched {
            Ok(response) => Ok(response),
            Err(ResolveError::NotFound | ResolveError::Upstream) => {
                reject_source(key, &source, &[&source.playlist_url, &playlist_url]).await;
                let (_, playlist_url, playlist) =
                    master_resource_playlist(state, key, master_resource, requested_generation)
                        .await?;
                let resources = hls_references(&playlist_url, &playlist);
                let upstream_url = resources.get(resource).ok_or(ResolveError::Invalid)?;
                get_cached_upstream_resource(
                    state,
                    upstream_url,
                    true,
                    "video/mp2t,video/mp4,application/octet-stream,*/*",
                    method,
                    request_headers,
                )
                .await
            }
            Err(error) => Err(error),
        };
    }
    let variant = query_value(uri, "variant")
        .and_then(|value| value.parse::<i32>().ok())
        .ok_or(ResolveError::Invalid)?;
    let resource = query_value(uri, "resource")
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or(ResolveError::Invalid)?;
    let (source, playlist_url, playlist) =
        media_playlist(state, key, variant, requested_generation).await?;
    let resources = hls_references(&playlist_url, &playlist);
    let upstream_url = resources.get(resource).ok_or(ResolveError::Invalid)?;
    let fetched = get_cached_upstream_resource(
        state,
        upstream_url,
        true,
        "video/mp2t,video/mp4,application/octet-stream,*/*",
        method,
        request_headers,
    )
    .await;
    match fetched {
        Ok(response) => Ok(response),
        Err(ResolveError::NotFound | ResolveError::Upstream) => {
            reject_source(key, &source, &[&source.playlist_url, &playlist_url]).await;
            let (_, playlist_url, playlist) =
                media_playlist(state, key, variant, requested_generation).await?;
            let resources = hls_references(&playlist_url, &playlist);
            let upstream_url = resources.get(resource).ok_or(ResolveError::Invalid)?;
            get_cached_upstream_resource(
                state,
                upstream_url,
                true,
                "video/mp2t,video/mp4,application/octet-stream,*/*",
                method,
                request_headers,
            )
            .await
        }
        Err(error) => Err(error),
    }
}

async fn track_handler(
    state: &AppState,
    key: &EpisodeKey,
    uri: &Uri,
    method: &Method,
    request_headers: &HeaderMap,
) -> Result<Response, ResolveError> {
    let track_index = query_value(uri, "track")
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or(ResolveError::Invalid)?;
    let requested_generation = requested_source_generation(uri)?;
    let source = get_source(&state.asset_client, key).await?;
    ensure_source_generation(&source, requested_generation)?;
    let track = source
        .tracks
        .get(track_index)
        .ok_or(ResolveError::Invalid)?;
    let fetched = get_cached_upstream_resource(
        state,
        &track.url,
        false,
        "text/vtt,text/plain,application/octet-stream",
        method,
        request_headers,
    )
    .await;
    let mut downstream = match fetched {
        Ok(response) => response,
        Err(ResolveError::NotFound | ResolveError::Upstream) => {
            invalidate_source(key, &[]).await;
            let source = get_source(&state.asset_client, key).await?;
            ensure_source_generation(&source, requested_generation)?;
            let track = source
                .tracks
                .get(track_index)
                .ok_or(ResolveError::Invalid)?;
            get_cached_upstream_resource(
                state,
                &track.url,
                false,
                "text/vtt,text/plain,application/octet-stream",
                method,
                request_headers,
            )
            .await?
        }
        Err(error) => return Err(error),
    };
    downstream.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/vtt; charset=utf-8"),
    );
    downstream.headers_mut().insert(
        "Cache-Control",
        HeaderValue::from_static("public, max-age=86400, stale-if-error=604800"),
    );
    Ok(downstream)
}

#[derive(Serialize)]
struct StreamTrack {
    label: String,
    language: String,
    src: String,
    kind: String,
    default: bool,
}

pub async fn stream_info_handler(
    state: Arc<AppState>,
    method: Method,
    uri: Uri,
    _headers: HeaderMap,
) -> Response {
    let _active = ActiveRequest::start();
    if method != Method::GET && method != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let result = async {
        let key = parse_episode_key(&uri)?;
        let (source, master) = source_master(&state, &key).await?;
        let tracks = source
            .tracks
            .iter()
            .enumerate()
            .map(|(index, track)| StreamTrack {
                label: track.label.clone(),
                language: track.language.clone(),
                src: format!(
                    "/stream/anikoto/track?{}",
                    query_string(
                        &key,
                        &[
                            ("source_generation", source.generation.to_string()),
                            ("track", index.to_string()),
                        ],
                    )
                ),
                kind: track.kind.clone(),
                default: track.default,
            })
            .collect::<Vec<_>>();
        let qualities = parse_hls_qualities(&master)
            .into_iter()
            .map(|(index, width, height, bitrate, codecs)| {
                serde_json::json!({
                    "index": index,
                    "width": (width > 0).then_some(width),
                    "height": (height > 0).then_some(height),
                    "bitrate": (bitrate > 0).then_some(bitrate),
                    "codecs": (!codecs.is_empty()).then_some(codecs),
                })
            })
            .collect::<Vec<_>>();
        let audio_tracks = parse_hls_audio_tracks(&master)
            .into_iter()
            .map(|(label, language, default)| {
                serde_json::json!({
                    "label": label,
                    "language": language,
                    "default": default,
                })
            })
            .collect::<Vec<_>>();
        Ok::<_, ResolveError>(
            Json(serde_json::json!({
                "hls": is_master_playlist(&master),
                "needs_transmux": false,
                "tracks": tracks,
                "source": {
                    "id": source.internal_id,
                    "generation": source.generation,
                    "server": source.metadata.server,
                    "language": source.language,
                },
                "duration": source.metadata.duration,
                "intro": source.metadata.intro.map(|marker| {
                    serde_json::json!({"start": marker.start, "end": marker.end})
                }),
                "outro": source.metadata.outro.map(|marker| {
                    serde_json::json!({"start": marker.start, "end": marker.end})
                }),
                "qualities": qualities,
                "audio_tracks": audio_tracks,
            }))
            .into_response(),
        )
    }
    .await;
    if let Err(error) = &result {
        tracing::warn!(
            stage = "stream_info",
            error = ?error,
            "anime stream stage failed{}",
            NEGATIVE
        );
    }
    result.unwrap_or_else(error_response)
}

pub async fn stream_handler(
    state: Arc<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let _active = ActiveRequest::start();
    if method != Method::GET && method != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let key = match parse_episode_key(&uri) {
        Ok(key) => key,
        Err(error) => return error_response(error),
    };
    let result = match uri.path() {
        "/stream/anikoto" => master_handler(&state, &key).await,
        "/stream/anikoto/variant" => variant_handler(&state, &key, &uri).await,
        "/stream/anikoto/resource" => resource_handler(&state, &key, &uri, &method, &headers).await,
        "/stream/anikoto/track" => track_handler(&state, &key, &uri, &method, &headers).await,
        path if path.starts_with("/stream/s-2/") => master_handler(&state, &key).await,
        _ => Err(ResolveError::Invalid),
    };
    if let Err(error) = &result {
        tracing::warn!(
            stage = %uri.path(),
            anilist_id = key.anilist_id,
            mal_id = key.mal_id,
            anikoto_episode_id = %key.anikoto_episode_id,
            episode = key.episode,
            language = %key.language,
            error = ?error,
            "anime stream stage failed{}",
            NEGATIVE
        );
    }
    result.unwrap_or_else(error_response)
}

pub async fn stream_metrics_handler(State(state): State<Arc<AppState>>) -> Response {
    let resolutions = STREAM_METRICS.source_resolutions.load(Ordering::Relaxed);
    let total_resolution_ms = STREAM_METRICS.source_resolution_ms.load(Ordering::Relaxed);
    let average_resolution_ms = total_resolution_ms.checked_div(resolutions).unwrap_or(0);
    let playlist_resolutions = STREAM_METRICS.playlist_resolutions.load(Ordering::Relaxed);
    let playlist_resolution_ms = STREAM_METRICS
        .playlist_resolution_ms
        .load(Ordering::Relaxed);
    let average_playlist_resolution_ms = playlist_resolution_ms
        .checked_div(playlist_resolutions)
        .unwrap_or(0);
    let segment_ttfb_samples = STREAM_METRICS
        .segment_upstream_ttfb_samples
        .load(Ordering::Relaxed);
    let segment_ttfb_ms = STREAM_METRICS
        .segment_upstream_ttfb_ms
        .load(Ordering::Relaxed);
    let segment_downloads = STREAM_METRICS
        .segment_upstream_downloads
        .load(Ordering::Relaxed);
    let segment_download_ms = STREAM_METRICS
        .segment_upstream_download_ms
        .load(Ordering::Relaxed);
    let segment_ttfb_average_ms = segment_ttfb_ms
        .checked_div(segment_ttfb_samples)
        .unwrap_or(0);
    let segment_download_average_ms = segment_download_ms
        .checked_div(segment_downloads)
        .unwrap_or(0);
    let upstream_capacity = state.stream_upstream_permit.snapshot();
    let rewrite_capacity = state.html_rewrite_permit.snapshot();
    let mut response = Json(serde_json::json!({
        "active_requests": STREAM_METRICS.active_requests.load(Ordering::Relaxed),
        "requests": STREAM_METRICS.requests.load(Ordering::Relaxed),
        "source_cache": {
            "hits": STREAM_METRICS.source_cache_hits.load(Ordering::Relaxed),
            "misses": STREAM_METRICS.source_cache_misses.load(Ordering::Relaxed),
        },
        "playlist_cache": {
            "hits": STREAM_METRICS.playlist_cache_hits.load(Ordering::Relaxed),
            "misses": STREAM_METRICS.playlist_cache_misses.load(Ordering::Relaxed),
        },
        "segment_cache": {
            "memory_hits": STREAM_METRICS.segment_memory_hits.load(Ordering::Relaxed),
            "disk_hits": STREAM_METRICS.segment_disk_hits.load(Ordering::Relaxed),
            "misses": STREAM_METRICS.segment_cache_misses.load(Ordering::Relaxed),
            "coalesced": STREAM_METRICS.segment_coalesced.load(Ordering::Relaxed),
            "failed_fills": STREAM_METRICS.segment_failed_fills.load(Ordering::Relaxed),
            "partial_fills": STREAM_METRICS.segment_partial_fills.load(Ordering::Relaxed),
            "disk_write_failures": STREAM_METRICS.segment_disk_write_failures.load(Ordering::Relaxed),
        },
        "upstream": {
            "attempts": STREAM_METRICS.upstream_attempts.load(Ordering::Relaxed),
            "retries": STREAM_METRICS.upstream_retries.load(Ordering::Relaxed),
            "errors": STREAM_METRICS.upstream_errors.load(Ordering::Relaxed),
            "source_refreshes": STREAM_METRICS.source_refreshes.load(Ordering::Relaxed),
        },
        "source_resolution": {
            "count": resolutions,
            "total_ms": total_resolution_ms,
            "average_ms": average_resolution_ms,
        },
        "playlist_resolution": {
            "count": playlist_resolutions,
            "total_ms": playlist_resolution_ms,
            "average_ms": average_playlist_resolution_ms,
        },
        "segment_upstream": {
            "ttfb_samples": segment_ttfb_samples,
            "ttfb_total_ms": segment_ttfb_ms,
            "ttfb_average_ms": segment_ttfb_average_ms,
            "downloads": segment_downloads,
            "download_total_ms": segment_download_ms,
            "download_average_ms": segment_download_average_ms,
            "bytes": STREAM_METRICS.segment_upstream_bytes.load(Ordering::Relaxed),
        },
        "downstream_cancellations": STREAM_METRICS.downstream_cancellations.load(Ordering::Relaxed),
        "range_requests": STREAM_METRICS.range_requests.load(Ordering::Relaxed),
        "bytes_served": STREAM_METRICS.bytes_served.load(Ordering::Relaxed),
        "capacity": {
            "upstream": {
                "active": upstream_capacity.active,
                "limit": upstream_capacity.limit,
                "minimum": upstream_capacity.minimum,
                "maximum": upstream_capacity.maximum,
                "peak": upstream_capacity.peak,
                "waits": upstream_capacity.waits,
                "rejected": upstream_capacity.rejected,
            },
            "rewrite": {
                "active": rewrite_capacity.active,
                "limit": rewrite_capacity.limit,
                "minimum": rewrite_capacity.minimum,
                "maximum": rewrite_capacity.maximum,
                "peak": rewrite_capacity.peak,
                "waits": rewrite_capacity.waits,
                "rejected": rewrite_capacity.rejected,
            }
        }
    }))
    .into_response();
    response.headers_mut().insert(
        "Cache-Control",
        HeaderValue::from_static("no-store, max-age=0"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::{
        cached_response, data_id, data_realid, embed_language, get_cached_upstream_resource,
        hls_master_references, hls_references, hls_variant_references, media_prefix_len,
        normalized_content_type, parse_byte_range, parse_episode_key, parse_hls_audio_tracks,
        parse_hls_qualities, rewrite_hls, rewrite_hls_master, source_file_url, source_generation,
        source_metadata, source_urls, track_language, CacheStatus, SEGMENT_PREFIX_BYTES,
        STREAM_METRICS,
    };
    use crate::cache::{get_stream_cache_path, load_stream_from_disk, StreamCacheWriter};
    use crate::state::{AppState, CachedResponse, FolioMetrics};
    use aho_corasick::AhoCorasick;
    use axum::body::{to_bytes, Body};
    use axum::http::header::{ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE};
    use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
    use axum::{routing::get, Router};
    use bytes::Bytes;
    use dashmap::DashMap;
    use futures_util::StreamExt;
    use moka::future::Cache;
    use std::convert::Infallible;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tokio::sync::broadcast;
    use tokio_stream::wrappers::ReceiverStream;

    async fn delayed_segment_server(
        chunk_delay: Duration,
        chunks: usize,
    ) -> (String, Arc<AtomicBool>, tokio::task::JoinHandle<()>) {
        let finished = Arc::new(AtomicBool::new(false));
        let handler_finished = finished.clone();
        let app = Router::new().route(
            "/segment.ts",
            get(move || {
                let handler_finished = handler_finished.clone();
                async move {
                    let (sender, receiver) = tokio::sync::mpsc::channel(1);
                    tokio::spawn(async move {
                        for index in 0..chunks {
                            tokio::time::sleep(chunk_delay).await;
                            if sender
                                .send(Ok::<_, Infallible>(Bytes::from(vec![index as u8; 4])))
                                .await
                                .is_err()
                            {
                                return;
                            }
                        }
                        handler_finished.store(true, Ordering::SeqCst);
                    });
                    let mut response = axum::response::Response::new(Body::from_stream(
                        ReceiverStream::new(receiver),
                    ));
                    response
                        .headers_mut()
                        .insert(CONTENT_TYPE, HeaderValue::from_static("video/mp2t"));
                    response.headers_mut().insert(
                        CONTENT_LENGTH,
                        HeaderValue::from_str(&(chunks * 4).to_string()).unwrap(),
                    );
                    response
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}/segment.ts"), finished, server)
    }

    fn test_state() -> AppState {
        let client = reqwest::Client::new();
        AppState {
            html_client: client.clone(),
            asset_client: client.clone(),
            raw_client: client,
            cache: Cache::new(128),
            stream_cache: Cache::new(128),
            stream_fills: Cache::new(128),
            folio_cache: Cache::new(128),
            folio_metrics: FolioMetrics::default(),
            blocklist_matcher: Arc::new(AhoCorasick::new(["blocked.invalid"]).unwrap()),
            caching_inflight: DashMap::new(),
            coalesce: DashMap::<String, broadcast::Sender<Arc<CachedResponse>>>::new(),
            request_permit: adaptive_capacity::AdaptiveGate::new(1, 16, 32),
            stream_upstream_permit: adaptive_capacity::AdaptiveGate::new(1, 4, 8),
            html_rewrite_permit: adaptive_capacity::AdaptiveGate::new(1, 4, 8),
            max_cache_entry_size: 1024 * 1024,
            disk_cache_max_age_secs: 3600,
            folio_cache_max_entry_size: 1024 * 1024,
            folio_cache_max_ttl_secs: 3600,
            stream_max_entry_size: 1024 * 1024,
            ram_cache_limit: 1024 * 1024,
            channel_buffer: 8,
        }
    }

    #[test]
    fn extracts_megaplay_internal_id() {
        assert_eq!(
            data_id("<div data-id=\"177682\" data-realid=\"835403\">"),
            Some("177682")
        );
        assert_eq!(data_id("<div data-id=\"nope\">"), None);
        assert_eq!(data_realid("<div data-realid=\"835403\">"), Some("835403"));
        assert_eq!(data_realid("<div data-realid=\"nope\">"), None);
    }

    #[test]
    fn keeps_source_generation_stable_across_cdn_fallbacks() {
        let preferred = source_generation("140719", Some("sub"));
        let fallback = source_generation("140719", Some("sub"));
        let other_episode = source_generation("140720", Some("sub"));

        assert_eq!(preferred, fallback);
        assert_ne!(preferred, other_episode);
    }

    #[test]
    fn extracts_the_embed_language_from_player_configuration() {
        assert_eq!(
            embed_language("const settings = { autoPlay: '1', type: 'sub' }"),
            Some("sub".to_string())
        );
        assert_eq!(
            embed_language("const settings = { type: \"dub\" };"),
            Some("dub".to_string())
        );
        assert_eq!(embed_language("const settings = { autoPlay: '1' };"), None);
    }

    #[test]
    fn accepts_direct_anikoto_episode_urls() {
        let key = parse_episode_key(&"/stream/s-2/170329/dub".parse().unwrap()).unwrap();
        assert_eq!(key.anikoto_episode_id, "170329");
        assert_eq!(key.episode, 1);
        assert_eq!(key.language, "dub");
    }

    #[test]
    fn keeps_legacy_source_endpoint_as_a_fallback() {
        assert_eq!(
            source_urls("177682"),
            vec![
                "https://megaplay.buzz/stream/getSourcesNew?id=177682",
                "https://megaplay.buzz/stream/getSources?id=177682",
            ]
        );
    }

    #[test]
    fn normalizes_megaplay_caption_language_labels() {
        assert_eq!(
            track_language(&serde_json::json!({"label": "English"})),
            "en"
        );
        assert_eq!(
            track_language(&serde_json::json!({"language": "en-US", "label": "CC"})),
            "en"
        );
        assert_eq!(track_language(&serde_json::json!({"label": "Thai"})), "th");
    }

    #[test]
    fn preserves_bcp47_caption_codes_and_common_provider_labels() {
        assert_eq!(
            track_language(&serde_json::json!({"lang": "zh-CN", "label": "Chinese"})),
            "zh-cn"
        );
        assert_eq!(
            track_language(&serde_json::json!({"label": "Arabic"})),
            "ar"
        );
        assert_eq!(
            track_language(&serde_json::json!({"label": "Korean"})),
            "ko"
        );
        assert_eq!(
            track_language(&serde_json::json!({"label": "Chinese (- Traditional)"})),
            "zh-hant"
        );
    }

    #[test]
    fn rewrites_every_playlist_resource_without_leaking_upstream_urls() {
        let playlist =
            "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:4,\nsegment.ts\n";
        let references = hls_references("https://media.example/show/index.m3u8", playlist);
        assert_eq!(
            references,
            vec![
                "https://media.example/show/key.bin",
                "https://media.example/show/segment.ts",
            ]
        );
        let rewritten = rewrite_hls(playlist, |index| format!("/proxy/{index}")).unwrap();
        assert!(rewritten.contains("URI=\"/proxy/0\""));
        assert!(rewritten.contains("/proxy/1"));
        assert!(!rewritten.contains("segment.ts"));
    }

    #[test]
    fn indexes_only_media_variants_in_a_master_playlist() {
        let master = concat!(
            "#EXTM3U\n",
            "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",URI=\"audio.m3u8\"\n",
            "#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=80000,URI=\"iframe.m3u8\"\n",
            "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n",
            "360p.m3u8\n",
            "#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720\n",
            "720p.m3u8\n",
        );

        assert_eq!(
            hls_variant_references("https://media.example/show/master.m3u8", master),
            vec![
                "https://media.example/show/360p.m3u8",
                "https://media.example/show/720p.m3u8",
            ]
        );
    }

    #[test]
    fn parses_master_quality_metadata_without_confusing_audio_or_iframe_entries() {
        let master = concat!(
            "#EXTM3U\n",
            "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",URI=\"audio.m3u8\"\n",
            "#EXT-X-STREAM-INF:BANDWIDTH=800000,AVERAGE-BANDWIDTH=700000,",
            "RESOLUTION=640x360,CODECS=\"avc1.4d401e,mp4a.40.2\"\n",
            "360p.m3u8\n",
        );

        assert_eq!(
            parse_hls_qualities(master),
            vec![(0, 640, 360, 800000, "avc1.4d401e,mp4a.40.2".to_string())]
        );
    }

    #[test]
    fn rewrites_master_variants_without_shifting_indices_for_iframe_or_audio_tags() {
        let master = concat!(
            "#EXTM3U\n",
            "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",URI=\"audio.m3u8\"\n",
            "#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=80000,URI=\"iframe.m3u8\"\n",
            "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n",
            "360p.m3u8\n",
            "#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720\n",
            "720p.m3u8\n",
        );
        let rewritten = rewrite_hls_master(
            master,
            |index| format!("/variant/{index}"),
            |index| format!("/master-resource/{index}"),
        )
        .unwrap();

        assert!(rewritten.contains("/master-resource/0"));
        assert!(rewritten.contains("/master-resource/1"));
        assert!(rewritten.contains("/variant/0"));
        assert!(rewritten.contains("/variant/1"));
        assert!(!rewritten.contains("/variant/2"));
        assert_eq!(
            hls_master_references("https://media.example/show/master.m3u8", master),
            vec![
                "https://media.example/show/audio.m3u8",
                "https://media.example/show/iframe.m3u8",
            ]
        );
    }

    #[test]
    fn extracts_source_metadata_without_treating_invalid_markers_as_facts() {
        let payload = serde_json::json!({
            "sources": {"file": "https://media.example/show/master.m3u8"},
            "duration": "123.5",
            "intro": {"start": 0, "end": 91.25},
            "outro": {"start": 118, "end": 123.5},
            "server": "MegaPlay 2"
        });

        assert_eq!(
            source_file_url(&payload),
            Some("https://media.example/show/master.m3u8".to_string())
        );
        let metadata = source_metadata(&payload);
        assert_eq!(metadata.duration, Some(123.5));
        assert_eq!(
            metadata.intro.map(|marker| (marker.start, marker.end)),
            Some((0.0, 91.25))
        );
        assert_eq!(
            metadata.outro.map(|marker| (marker.start, marker.end)),
            Some((118.0, 123.5))
        );
        assert_eq!(metadata.server.as_deref(), Some("MegaPlay 2"));

        let invalid = serde_json::json!({"intro": {"start": 10, "end": 10}});
        assert!(source_metadata(&invalid).intro.is_none());
    }

    #[test]
    fn parses_hls_audio_renditions_as_available_tracks() {
        let master = concat!(
            "#EXTM3U\n",
            "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",LANGUAGE=\"en\",",
            "NAME=\"English Dub\",DEFAULT=YES,URI=\"dub.m3u8\"\n",
            "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",LANGUAGE=\"ja\",",
            "NAME=\"Japanese\",DEFAULT=NO,URI=\"sub.m3u8\"\n",
        );
        assert_eq!(
            parse_hls_audio_tracks(master),
            vec![
                ("English Dub".to_string(), "en".to_string(), true),
                ("Japanese".to_string(), "ja".to_string(), false),
            ]
        );
    }

    #[test]
    fn parses_single_byte_ranges() {
        assert_eq!(parse_byte_range("bytes=10-19", 100), Ok((10, 19)));
        assert_eq!(parse_byte_range("bytes=90-", 100), Ok((90, 99)));
        assert_eq!(parse_byte_range("bytes=-10", 100), Ok((90, 99)));
        assert_eq!(parse_byte_range("bytes=90-200", 100), Ok((90, 99)));
        assert_eq!(parse_byte_range("bytes=100-", 100), Err(()));
        assert_eq!(parse_byte_range("bytes=0-1,4-5", 100), Err(()));
    }

    #[test]
    fn normalizes_media_content_types_from_bytes() {
        let mut transport_stream = vec![0u8; 376];
        transport_stream[0] = 0x47;
        transport_stream[188] = 0x47;
        assert_eq!(
            normalized_content_type(&Bytes::from(transport_stream), None),
            "video/mp2t"
        );
        assert_eq!(
            normalized_content_type(&Bytes::from_static(b"\0\0\0\x18ftypisom"), None,),
            "video/mp4"
        );
    }

    #[tokio::test]
    async fn serves_cached_byte_ranges_with_correct_headers() {
        let mut request_headers = HeaderMap::new();
        request_headers.insert("Range", HeaderValue::from_static("bytes=2-4"));
        let cached = Arc::new(CachedResponse {
            status: StatusCode::OK.as_u16(),
            headers: HeaderMap::new(),
            body: Bytes::from_static(b"0123456789"),
        });
        let response = cached_response(cached, &Method::GET, &request_headers, CacheStatus::Memory);
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()["Content-Range"], "bytes 2-4/10");
        assert_eq!(response.headers()["Content-Length"], "3");
        assert_eq!(response.headers()["X-Cache"], "HIT");
        assert_eq!(
            to_bytes(response.into_body(), 16).await.unwrap(),
            Bytes::from_static(b"234")
        );
    }

    #[tokio::test]
    async fn rejects_unsatisfiable_cached_ranges() {
        let mut request_headers = HeaderMap::new();
        request_headers.insert("Range", HeaderValue::from_static("bytes=10-"));
        let cached = Arc::new(CachedResponse {
            status: StatusCode::OK.as_u16(),
            headers: HeaderMap::new(),
            body: Bytes::from_static(b"0123456789"),
        });
        let response = cached_response(cached, &Method::GET, &request_headers, CacheStatus::Memory);
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(response.headers()["Content-Range"], "bytes */10");
        assert_eq!(
            to_bytes(response.into_body(), 16).await.unwrap(),
            Bytes::new()
        );
    }

    #[test]
    fn detects_media_prefix_from_content_instead_of_vendor_host() {
        let mut prefixed = vec![0u8; SEGMENT_PREFIX_BYTES + 376];
        prefixed[SEGMENT_PREFIX_BYTES] = 0x47;
        prefixed[SEGMENT_PREFIX_BYTES + 188] = 0x47;
        assert_eq!(media_prefix_len(&prefixed), SEGMENT_PREFIX_BYTES);

        let mut plain = vec![0u8; 376];
        plain[0] = 0x47;
        plain[188] = 0x47;
        assert_eq!(media_prefix_len(&plain), 0);
    }

    #[tokio::test]
    async fn strips_detected_media_prefix_while_streaming() {
        let mut media = vec![0u8; 376];
        media[0] = 0x47;
        media[188] = 0x47;
        let expected = Bytes::from(media.clone());
        let mut upstream = vec![0u8; SEGMENT_PREFIX_BYTES];
        upstream.extend_from_slice(&media);
        let app = Router::new().route(
            "/segment.bin",
            get(move || {
                let upstream = upstream.clone();
                async move { ([("content-type", "image/png")], upstream) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let url = format!("http://{address}/segment.bin");
        let state = test_state();

        let response = get_cached_upstream_resource(
            &state,
            &url,
            true,
            "video/mp2t",
            &Method::GET,
            &HeaderMap::new(),
        )
        .await
        .unwrap();
        assert_eq!(response.headers()[CONTENT_TYPE], "video/mp2t");
        assert_eq!(response.headers()[CONTENT_LENGTH], "376");
        assert_eq!(
            to_bytes(response.into_body(), 1024).await.unwrap(),
            expected
        );

        server.abort();
        tokio::time::sleep(Duration::from_millis(25)).await;
        let cache_key = format!("anikoto:stripped:{url}");
        state.stream_cache.invalidate(&cache_key).await;
        let _ = tokio::fs::remove_file(get_stream_cache_path(&cache_key)).await;
    }

    #[tokio::test]
    async fn coalesces_concurrent_segment_fetches() {
        let upstream_hits = Arc::new(AtomicUsize::new(0));
        let handler_hits = upstream_hits.clone();
        let app = Router::new().route(
            "/segment.ts",
            get(move || {
                let handler_hits = handler_hits.clone();
                async move {
                    handler_hits.fetch_add(1, Ordering::SeqCst);
                    (
                        [
                            ("content-type", "video/mp2t"),
                            ("cache-control", "no-store"),
                        ],
                        vec![7u8; 4096],
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let url = format!("http://{address}/segment.ts");
        let state = test_state();

        let method = Method::GET;
        let request_headers = HeaderMap::new();
        let requests = (0..64).map(|_| {
            get_cached_upstream_resource(
                &state,
                &url,
                false,
                "video/mp2t",
                &method,
                &request_headers,
            )
        });
        let results = futures_util::future::join_all(requests).await;
        assert!(results.iter().all(Result::is_ok));
        let statuses = results
            .iter()
            .map(|result| result.as_ref().unwrap().headers()["X-Cache"].clone())
            .collect::<Vec<_>>();
        assert_eq!(
            statuses
                .iter()
                .filter(|status| status.as_bytes() == b"MISS")
                .count(),
            1
        );
        assert!(statuses
            .iter()
            .filter(|status| status.as_bytes() != b"MISS")
            .all(|status| status.as_bytes() == b"COALESCED"));
        let bodies =
            futures_util::future::join_all(results.into_iter().map(|result| async {
                to_bytes(result.unwrap().into_body(), 8192).await.unwrap()
            }))
            .await;
        assert!(bodies.iter().all(|body| body.len() == 4096));
        assert_eq!(upstream_hits.load(Ordering::SeqCst), 1);

        server.abort();
        tokio::time::sleep(Duration::from_millis(25)).await;
        let cache_key = format!("anikoto:raw:{url}");
        let _ = tokio::fs::remove_file(get_stream_cache_path(&cache_key)).await;
    }

    #[tokio::test]
    async fn streams_ranges_on_a_cache_miss_without_caching_partial_data() {
        let (url, upstream_finished, server) =
            delayed_segment_server(Duration::from_millis(25), 3).await;
        let state = test_state();
        let mut headers = HeaderMap::new();
        headers.insert(RANGE, HeaderValue::from_static("bytes=2-7"));
        let response =
            get_cached_upstream_resource(&state, &url, false, "video/mp2t", &Method::GET, &headers)
                .await
                .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[CONTENT_RANGE], "bytes 2-7/12");
        assert_eq!(response.headers()[CONTENT_LENGTH], "6");
        assert_eq!(response.headers()["X-Cache"], "MISS");
        assert_eq!(
            to_bytes(response.into_body(), 16).await.unwrap(),
            Bytes::from_static(&[0, 0, 1, 1, 1, 1])
        );
        assert!(!upstream_finished.load(Ordering::SeqCst));

        let cache_key = format!("anikoto:raw:{url}");
        let cached = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Some(cached) = state.stream_cache.get(&cache_key).await {
                    break cached;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(upstream_finished.load(Ordering::SeqCst));
        assert_eq!(cached.body.len(), 12);
        assert_eq!(cached.body.as_ref(), &[0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2]);

        server.abort();
        state.stream_cache.invalidate(&cache_key).await;
        let _ = tokio::fs::remove_file(get_stream_cache_path(&cache_key)).await;
    }

    #[tokio::test]
    async fn records_downstream_cancellation_without_aborting_the_cache_fill() {
        let before = STREAM_METRICS
            .downstream_cancellations
            .load(Ordering::Relaxed);
        let (url, _, server) = delayed_segment_server(Duration::from_millis(20), 4).await;
        let state = test_state();
        let response = get_cached_upstream_resource(
            &state,
            &url,
            false,
            "video/mp2t",
            &Method::GET,
            &HeaderMap::new(),
        )
        .await
        .unwrap();
        drop(response.into_body());

        let cache_key = format!("anikoto:raw:{url}");
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if state.stream_cache.get(&cache_key).await.is_some() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(
            STREAM_METRICS
                .downstream_cancellations
                .load(Ordering::Relaxed)
                > before
        );

        server.abort();
        state.stream_cache.invalidate(&cache_key).await;
        let _ = tokio::fs::remove_file(get_stream_cache_path(&cache_key)).await;
    }

    #[tokio::test]
    async fn rejects_partial_fills_without_publishing_them() {
        let app = Router::new().route(
            "/segment.ts",
            get(|| async {
                let (sender, receiver) = tokio::sync::mpsc::channel(1);
                tokio::spawn(async move {
                    let _ = sender
                        .send(Ok::<_, Infallible>(Bytes::from_static(b"part")))
                        .await;
                    tokio::time::sleep(Duration::from_millis(50)).await;
                });
                let mut response =
                    axum::response::Response::new(Body::from_stream(ReceiverStream::new(receiver)));
                response
                    .headers_mut()
                    .insert(CONTENT_TYPE, HeaderValue::from_static("video/mp2t"));
                response
                    .headers_mut()
                    .insert(CONTENT_LENGTH, HeaderValue::from_static("12"));
                response
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let url = format!("http://{address}/segment.ts");
        let state = test_state();
        let response = get_cached_upstream_resource(
            &state,
            &url,
            false,
            "video/mp2t",
            &Method::GET,
            &HeaderMap::new(),
        )
        .await
        .unwrap();
        assert!(to_bytes(response.into_body(), 16).await.is_err());

        let cache_key = format!("anikoto:raw:{url}");
        assert!(state.stream_cache.get(&cache_key).await.is_none());
        assert!(load_stream_from_disk(&cache_key, 1024 * 1024, 60)
            .await
            .is_none());
        assert!(!std::path::Path::new(&get_stream_cache_path(&cache_key)).exists());

        server.abort();
    }

    #[tokio::test]
    async fn streams_a_cache_miss_before_the_upstream_finishes() {
        let (url, upstream_finished, server) =
            delayed_segment_server(Duration::from_millis(75), 3).await;
        let state = test_state();
        let response = get_cached_upstream_resource(
            &state,
            &url,
            false,
            "video/mp2t",
            &Method::GET,
            &HeaderMap::new(),
        )
        .await
        .unwrap();
        assert_eq!(response.headers()["X-Cache"], "MISS");

        let mut downstream = response.into_body().into_data_stream();
        let first = tokio::time::timeout(Duration::from_millis(100), downstream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(first, Bytes::from_static(&[0, 0, 0, 0]));
        assert!(!upstream_finished.load(Ordering::SeqCst));

        let mut received = first.len();
        while let Some(chunk) = downstream.next().await {
            received += chunk.unwrap().len();
        }
        assert_eq!(received, 12);
        assert!(upstream_finished.load(Ordering::SeqCst));

        server.abort();
        let cache_key = format!("anikoto:raw:{url}");
        state.stream_cache.invalidate(&cache_key).await;
        let _ = tokio::fs::remove_file(get_stream_cache_path(&cache_key)).await;
    }

    #[tokio::test]
    async fn streams_disk_hits_with_ranges_and_head_metadata() {
        let url = format!("https://media.example/{}.ts", uuid::Uuid::new_v4());
        let cache_key = format!("anikoto:raw:{url}");
        let mut cached_headers = HeaderMap::new();
        cached_headers.insert(CONTENT_TYPE, HeaderValue::from_static("video/mp2t"));
        cached_headers.insert(CONTENT_LENGTH, HeaderValue::from_static("10"));
        let mut writer =
            StreamCacheWriter::create(&cache_key, StatusCode::OK.as_u16(), &cached_headers)
                .await
                .unwrap();
        writer.write(b"01234").await.unwrap();
        writer.write(b"56789").await.unwrap();
        writer.commit().await.unwrap();

        let state = test_state();
        let mut range_headers = HeaderMap::new();
        range_headers.insert(RANGE, HeaderValue::from_static("bytes=2-5"));
        let response = get_cached_upstream_resource(
            &state,
            &url,
            false,
            "video/mp2t",
            &Method::GET,
            &range_headers,
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[CONTENT_RANGE], "bytes 2-5/10");
        assert_eq!(response.headers()[CONTENT_LENGTH], "4");
        assert_eq!(response.headers()[ACCEPT_RANGES], "bytes");
        assert_eq!(response.headers()["X-Cache"], "DISK");
        assert_eq!(
            to_bytes(response.into_body(), 16).await.unwrap(),
            Bytes::from_static(b"2345")
        );

        let response = get_cached_upstream_resource(
            &state,
            &url,
            false,
            "video/mp2t",
            &Method::HEAD,
            &HeaderMap::new(),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[CONTENT_LENGTH], "10");
        assert_eq!(response.headers()[ACCEPT_RANGES], "bytes");
        assert_eq!(response.headers()["X-Cache"], "DISK");
        assert_eq!(
            to_bytes(response.into_body(), 16).await.unwrap(),
            Bytes::new()
        );

        let _ = tokio::fs::remove_file(get_stream_cache_path(&cache_key)).await;
    }

    #[tokio::test]
    #[ignore = "local latency benchmark"]
    async fn benchmark_delayed_segment_streaming() {
        let delay_ms = std::env::var("MOCHI_BENCH_CHUNK_DELAY_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(100);
        let chunks = std::env::var("MOCHI_BENCH_CHUNKS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(8)
            .max(2);
        let (url, _, server) =
            delayed_segment_server(Duration::from_millis(delay_ms), chunks).await;
        let state = test_state();
        let started_at = Instant::now();
        let response = get_cached_upstream_resource(
            &state,
            &url,
            false,
            "video/mp2t",
            &Method::GET,
            &HeaderMap::new(),
        )
        .await
        .unwrap();
        let mut downstream = response.into_body().into_data_stream();
        let first = downstream.next().await.unwrap().unwrap();
        let first_byte_ms = started_at.elapsed().as_millis();
        let mut received = first.len();
        while let Some(chunk) = downstream.next().await {
            received += chunk.unwrap().len();
        }
        let total_ms = started_at.elapsed().as_millis();
        println!(
            "segment benchmark: chunks={chunks} delay_ms={delay_ms} first_byte_ms={first_byte_ms} total_ms={total_ms} bytes={received}"
        );
        assert!(first_byte_ms < total_ms);

        server.abort();
        let cache_key = format!("anikoto:raw:{url}");
        state.stream_cache.invalidate(&cache_key).await;
        let _ = tokio::fs::remove_file(get_stream_cache_path(&cache_key)).await;
    }
}
