use super::*;

fn upstream_range(headers: &HeaderMap) -> Option<(usize, usize, usize)> {
    let value = headers
        .get(CONTENT_RANGE)?
        .to_str()
        .ok()?
        .strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let (start, end, total) = (start.parse().ok()?, end.parse().ok()?, total.parse().ok()?);
    (start <= end && end < total).then_some((start, end, total))
}

fn unsatisfied(length: usize) -> Response {
    (
        StatusCode::RANGE_NOT_SATISFIABLE,
        [(CONTENT_RANGE, format!("bytes */{length}"))],
    )
        .into_response()
}

pub(super) fn stream_response(
    response: reqwest::Response,
    permit: adaptive_capacity::AdaptivePermit,
    status: StatusCode,
    headers: HeaderMap,
    skip: usize,
    take: Option<usize>,
) -> Response {
    let stream = futures_util::stream::try_unfold(
        (response, permit, skip, take),
        |(mut response, permit, mut skip, mut take)| async move {
            loop {
                if take == Some(0) {
                    return Ok(None);
                }
                let chunk = tokio::time::timeout(UPSTREAM_BODY_TIMEOUT, response.chunk())
                    .await
                    .map_err(|_| std::io::Error::other("upstream media stalled... /ᐠ - ˕ -マ"))?
                    .map_err(|_| std::io::Error::other("upstream media failed... /ᐠ - ˕ -マ"))?;
                let Some(chunk) = chunk else {
                    if skip > 0 || take.is_some_and(|n| n > 0) {
                        return Err(std::io::Error::other(
                            "upstream media is incomplete... /ᐠ - ˕ -マ",
                        ));
                    }
                    return Ok(None);
                };
                let start = skip.min(chunk.len());
                skip -= start;
                let end = take.map_or(chunk.len(), |n| start + n.min(chunk.len() - start));
                if start == end {
                    continue;
                }
                if let Some(left) = take.as_mut() {
                    *left -= end - start;
                }
                return Ok(Some((
                    chunk.slice(start..end),
                    (response, permit, skip, take),
                )));
            }
        },
    );
    (status, headers, Body::from_stream(stream)).into_response()
}

pub(super) async fn uncached_resource(
    state: &AppState,
    url: &str,
    provider: StreamProvider,
    inspect: bool,
    accept: &'static str,
    method: &Method,
    requested: &HeaderMap,
) -> Result<Response, ResolveError> {
    if requested.contains_key(RANGE) {
        STREAM_METRICS
            .range_requests
            .fetch_add(1, Ordering::Relaxed);
    }
    let permit = state
        .stream_upstream_permit
        .acquire_timeout(Duration::from_secs(10))
        .await
        .ok_or(ResolveError::Busy)?;
    let mut prefix = 0;
    let mut total = None;
    let mut detected_type = None;
    if inspect {
        let mut probe = send_with_retry(|| {
            state
                .asset_client
                .get(url)
                .header(ACCEPT, accept)
                .header(REFERER, provider.referer())
                .header("accept-encoding", "identity")
                .header(RANGE, format!("bytes=0-{}", SEGMENT_PREFIX_BYTES + 188))
        })
        .await?;
        if !probe.status().is_success() {
            let status = probe.status();
            let headers = crate::proxy::build_safe_response_headers(probe.headers(), true);
            return Ok(stream_response(probe, permit, status, headers, 0, None));
        }
        total = if probe.status() == StatusCode::PARTIAL_CONTENT {
            let (start, _, total) =
                upstream_range(probe.headers()).ok_or(ResolveError::Upstream)?;
            if start != 0 {
                return Err(ResolveError::Upstream);
            }
            Some(total)
        } else {
            probe.content_length().and_then(|n| usize::try_from(n).ok())
        };
        let mut bytes = BytesMut::new();
        let needed = SEGMENT_PREFIX_BYTES + 189;
        while bytes.len() < needed {
            let chunk = tokio::time::timeout(UPSTREAM_BODY_TIMEOUT, probe.chunk())
                .await
                .map_err(|_| ResolveError::Upstream)?
                .map_err(|_| ResolveError::Upstream)?;
            let Some(chunk) = chunk else {
                break;
            };
            bytes.extend_from_slice(&chunk[..chunk.len().min(needed - bytes.len())]);
        }
        prefix = media_prefix_len(&bytes);
        detected_type = Some(normalized_content_type(
            &bytes.freeze().slice(prefix..),
            probe.headers().get(CONTENT_TYPE).cloned(),
        ));
    }
    let length = total.and_then(|n| n.checked_sub(prefix));
    let range = if prefix > 0 && method != Method::HEAD && !requested.contains_key("if-range") {
        match (requested.get(RANGE).and_then(|v| v.to_str().ok()), length) {
            (Some(value), Some(length)) => match parse_byte_range(value, length) {
                Ok(range) => Some(range),
                Err(()) => return Ok(unsatisfied(length)),
            },
            _ => None,
        }
    } else {
        None
    };
    let response = send_with_retry(|| {
        let mut request = state
            .asset_client
            .request(method.clone(), url)
            .header(ACCEPT, accept)
            .header(REFERER, provider.referer())
            .header("accept-encoding", "identity");
        for name in [
            "cache-control",
            "pragma",
            "if-none-match",
            "if-modified-since",
            "if-match",
            "if-unmodified-since",
        ] {
            for value in requested.get_all(name) {
                request = request.header(name, value);
            }
        }
        if let Some((start, end)) = range {
            request = request.header(RANGE, format!("bytes={}-{}", start + prefix, end + prefix));
        } else if prefix == 0 && method != Method::HEAD {
            for name in ["range", "if-range"] {
                if let Some(value) = requested.get(name) {
                    request = request.header(name, value);
                }
            }
        }
        request
    })
    .await?;
    let mut status = response.status();
    let mut headers = crate::proxy::build_safe_response_headers(response.headers(), true);
    headers.insert("x-cache", HeaderValue::from_static("BYPASS"));
    let mut skip = 0;
    let mut take = None;
    if prefix > 0 && status.is_success() {
        headers.remove("etag");
        headers.remove("last-modified");
        if let Some(content_type) = detected_type {
            headers.insert(CONTENT_TYPE, content_type);
        }
        if let Some((start, end)) = range {
            if status == StatusCode::PARTIAL_CONTENT {
                let (actual_start, actual_end, actual_total) =
                    upstream_range(response.headers()).ok_or(ResolveError::Upstream)?;
                if actual_start != start + prefix
                    || actual_end != end + prefix
                    || Some(actual_total) != total
                {
                    return Err(ResolveError::Upstream);
                }
            } else {
                skip = start + prefix;
            }
            take = Some(end - start + 1);
            status = StatusCode::PARTIAL_CONTENT;
            headers.insert(
                CONTENT_RANGE,
                HeaderValue::from_str(&format!(
                    "bytes {start}-{end}/{}",
                    length.ok_or(ResolveError::Upstream)?
                ))
                .map_err(|_| ResolveError::Upstream)?,
            );
            headers.insert(
                CONTENT_LENGTH,
                HeaderValue::from_str(&(end - start + 1).to_string())
                    .map_err(|_| ResolveError::Upstream)?,
            );
        } else {
            skip = prefix;
            if let Some(length) = length {
                headers.insert(
                    CONTENT_LENGTH,
                    HeaderValue::from_str(&length.to_string())
                        .map_err(|_| ResolveError::Upstream)?,
                );
            }
        }
    } else if let Some(length) = response.headers().get(CONTENT_LENGTH) {
        headers.insert(CONTENT_LENGTH, length.clone());
    }
    if method == Method::HEAD {
        return Ok((status, headers).into_response());
    }
    Ok(stream_response(
        response, permit, status, headers, skip, take,
    ))
}
