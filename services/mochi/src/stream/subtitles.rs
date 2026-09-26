use super::ResolveError;
use axum::body::{to_bytes, Body};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;

pub(super) async fn response(
    upstream: Response,
    method: &Method,
    request: &HeaderMap,
) -> Result<Response, ResolveError> {
    if upstream.status() != StatusCode::OK {
        return Ok(upstream);
    }
    let (mut parts, body) = upstream.into_parts();
    let body = tokio::time::timeout(
        super::UPSTREAM_BODY_TIMEOUT,
        to_bytes(body, 4 * 1024 * 1024),
    )
    .await
    .map_err(|_| ResolveError::Upstream)?
    .map_err(|_| ResolveError::TooLarge)?;
    let mut body = Bytes::from(webvtt(&body)?);
    for name in [
        "content-length",
        "content-range",
        "content-encoding",
        "etag",
        "last-modified",
    ] {
        parts.headers.remove(name);
    }
    parts.headers.insert(
        "content-type",
        HeaderValue::from_static("text/vtt; charset=utf-8"),
    );
    parts
        .headers
        .insert("accept-ranges", HeaderValue::from_static("bytes"));
    let length = body.len();
    if !request.contains_key("if-range") {
        if let Some(range) = request.get("range").and_then(|value| value.to_str().ok()) {
            let Ok((start, end)) = super::parse_byte_range(range, length) else {
                return Ok((
                    StatusCode::RANGE_NOT_SATISFIABLE,
                    [("content-range", format!("bytes */{length}"))],
                )
                    .into_response());
            };
            parts.status = StatusCode::PARTIAL_CONTENT;
            parts.headers.insert(
                "content-range",
                HeaderValue::from_str(&format!("bytes {start}-{end}/{length}"))
                    .map_err(|_| ResolveError::Upstream)?,
            );
            body = body.slice(start..=end);
        }
    }
    parts.headers.insert(
        "content-length",
        HeaderValue::from_str(&body.len().to_string()).map_err(|_| ResolveError::Upstream)?,
    );
    Ok(Response::from_parts(
        parts,
        if method == Method::HEAD {
            Body::empty()
        } else {
            Body::from(body)
        },
    ))
}

pub(super) fn webvtt(body: &[u8]) -> Result<String, ResolveError> {
    let text = std::str::from_utf8(body).map_err(|_| ResolveError::Upstream)?;
    let text = text
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    if text.lines().next().is_some_and(|line| {
        line == "WEBVTT" || line.starts_with("WEBVTT ") || line.starts_with("WEBVTT\t")
    }) {
        return Ok(text);
    }
    let mut cues = if text.lines().any(|line| line.trim() == "[Events]") {
        ass(&text)
    } else {
        srt(&text)
    };
    if cues.is_empty() {
        return Err(ResolveError::Upstream);
    }
    cues.sort_by_key(|cue| timestamp(cue.split_whitespace().next().unwrap_or("")).unwrap_or(0));
    Ok(format!("WEBVTT\n\n{}", cues.join("\n\n")))
}

fn timestamp(value: &str) -> Option<u64> {
    let (clock, fraction) = value.trim().rsplit_once(['.', ','])?;
    if fraction.is_empty() || fraction.len() > 3 || !fraction.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let parts: Vec<_> = clock.split(':').collect();
    if !(2..=3).contains(&parts.len()) {
        return None;
    }
    let mut total = 0u64;
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let number = part.parse::<u64>().ok()?;
        if index > 0 && number >= 60 {
            return None;
        }
        total = total.checked_mul(60)?.checked_add(number)?;
    }
    total
        .checked_mul(1000)?
        .checked_add(fraction.parse::<u64>().ok()? * 10u64.pow(3 - fraction.len() as u32))
}

fn format_timestamp(ms: u64) -> String {
    format!(
        "{:02}:{:02}:{:02}.{:03}",
        ms / 3_600_000,
        ms / 60_000 % 60,
        ms / 1000 % 60,
        ms % 1000
    )
}

fn cue(start: &str, end: &str, text: &str) -> Option<String> {
    let (start, end) = (timestamp(start)?, timestamp(end)?);
    if end <= start || text.trim().is_empty() {
        return None;
    }
    Some(format!(
        "{} --> {}\n{}",
        format_timestamp(start),
        format_timestamp(end),
        text.trim()
    ))
}

fn srt(text: &str) -> Vec<String> {
    text.split("\n\n")
        .filter_map(|block| {
            let mut lines = block.trim().lines();
            let first = lines.next()?.trim();
            let timing = if first.contains("-->") {
                first
            } else {
                if !first.bytes().all(|b| b.is_ascii_digit()) {
                    return None;
                }
                lines.next()?
            };
            let (start, end) = timing.split_once("-->")?;
            let end = end.split_whitespace().next()?;
            cue(start, end, &lines.collect::<Vec<_>>().join("\n"))
        })
        .collect()
}

fn ass(text: &str) -> Vec<String> {
    let mut events = false;
    let mut fields = Vec::new();
    let mut cues = Vec::new();
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            events = line == "[Events]";
            continue;
        }
        if !events {
            continue;
        }
        if let Some(format) = line.strip_prefix("Format:") {
            fields = format
                .split(',')
                .map(|field| field.trim().to_ascii_lowercase())
                .collect();
        } else if let Some(dialogue) = line.strip_prefix("Dialogue:") {
            if fields.last().map(String::as_str) != Some("text") {
                continue;
            }
            let values: Vec<_> = dialogue.splitn(fields.len(), ',').collect();
            let field = |name| {
                fields
                    .iter()
                    .position(|field| field == name)
                    .and_then(|i| values.get(i).copied())
            };
            if let (Some(start), Some(end), Some(text)) =
                (field("start"), field("end"), field("text"))
            {
                if let Some(cue) = cue(start, end, &ass_text(text)) {
                    cues.push(cue);
                }
            }
        }
    }
    cues
}

fn ass_text(text: &str) -> String {
    let mut chars = text.chars().peekable();
    let mut output = String::new();
    let mut drawing = false;
    while let Some(ch) = chars.next() {
        if ch == '{' {
            let mut tags = String::new();
            for ch in chars.by_ref() {
                if ch == '}' {
                    break;
                }
                tags.push(ch);
            }
            for tag in tags.split('\\') {
                if let Some(value) = tag
                    .strip_prefix('p')
                    .and_then(|value| value.trim().parse::<u32>().ok())
                {
                    drawing = value != 0;
                }
            }
        } else if !drawing {
            match ch {
                '\\' if matches!(chars.peek(), Some('N' | 'n')) => {
                    chars.next();
                    if !output.ends_with('\n') {
                        output.push('\n');
                    }
                }
                '\\' if chars.peek() == Some(&'h') => {
                    chars.next();
                    output.push('\u{a0}');
                }
                '&' => output.push_str("&amp;"),
                '<' => output.push_str("&lt;"),
                '>' => output.push_str("&gt;"),
                _ => output.push(ch),
            }
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vtt_preserves_maps_settings_overlaps_and_precision() {
        let source = "WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000\n\n1\n00:00:01.001 --> 00:00:02.999 line:10%\n<i>one</i>\n\n2\n00:00:01.500 --> 00:00:03.000\ntwo\n";
        assert_eq!(webvtt(source.as_bytes()).unwrap(), source);
        assert_eq!(
            webvtt(format!("\u{feff}{}", source.replace('\n', "\r\n")).as_bytes()).unwrap(),
            source
        );
    }

    #[test]
    fn srt_uses_integer_milliseconds_without_drift() {
        let source = b"1\r\n01:02:03,007 --> 01:02:04,099\r\n<i>hello</i>\r\nworld\r\n\r\n2\r\n23:59:59,999 --> 24:00:00,001\r\nend";
        let converted = webvtt(source).unwrap();
        assert!(converted.contains("01:02:03.007 --> 01:02:04.099\n<i>hello</i>\nworld"));
        assert!(converted.contains("23:59:59.999 --> 24:00:00.001"));
    }

    #[test]
    fn ass_preserves_centiseconds_and_text_with_commas() {
        let source = b"[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.23,0:00:03.45,Default,,0,0,0,,{\\i1}hello, world\\N<hi>&\\hthere\nDialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,{\\p1}m 0 0 l 1 1{\\p0}text";
        let converted = webvtt(source).unwrap();
        assert!(converted
            .contains("00:00:01.230 --> 00:00:03.450\nhello, world\n&lt;hi&gt;&amp;\u{a0}there"));
        assert!(converted.contains("00:00:02.000 --> 00:00:04.000\ntext"));
        assert!(!converted.contains("m 0"));
    }

    #[test]
    fn ass_events_are_stably_ordered_without_removing_overlaps() {
        let source = b"[Events]\nFormat: Start, End, Text\nDialogue: 0:00:05.00,0:00:08.00,later\nDialogue: 0:00:01.01,0:00:06.00,earlier\nDialogue: 0:00:01.01,0:00:02.00,same start";
        let converted = webvtt(source).unwrap();
        assert!(converted.find("earlier").unwrap() < converted.find("same start").unwrap());
        assert!(converted.find("same start").unwrap() < converted.find("later").unwrap());
    }

    #[test]
    fn rejects_invalid_timestamps_and_non_subtitle_responses() {
        for value in [
            "-1:00:00.000",
            "00:60:00.000",
            "00:00:60.000",
            "00:00:00.1234",
            "NaN",
            "18446744073709551615:00:00.000",
        ] {
            assert!(timestamp(value).is_none());
        }
        for body in [
            "<html>error</html>",
            "WEBVTTjunk",
            "1\n00:00:03,000 --> 00:00:02,000\ntext",
        ] {
            assert!(webvtt(body.as_bytes()).is_err());
        }
    }

    #[tokio::test]
    async fn converted_ranges_and_head_describe_vtt_and_preserve_cache_policy() {
        fn upstream() -> Response {
            (
                [
                    ("cache-control", "no-store"),
                    ("etag", "original"),
                    ("content-length", "42"),
                ],
                "1\n00:00:01,000 --> 00:00:02,000\nhello",
            )
                .into_response()
        }
        let converted = webvtt(b"1\n00:00:01,000 --> 00:00:02,000\nhello").unwrap();
        let head = response(upstream(), &Method::HEAD, &HeaderMap::new())
            .await
            .unwrap();
        assert_eq!(
            head.headers()["content-length"],
            converted.len().to_string()
        );
        assert_eq!(head.headers()["cache-control"], "no-store");
        assert!(!head.headers().contains_key("etag"));
        assert!(to_bytes(head.into_body(), 1024).await.unwrap().is_empty());
        let mut headers = HeaderMap::new();
        headers.insert("range", HeaderValue::from_static("bytes=0-5"));
        let partial = response(upstream(), &Method::GET, &headers).await.unwrap();
        assert_eq!(partial.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(to_bytes(partial.into_body(), 1024).await.unwrap(), "WEBVTT");
        headers.insert("if-range", HeaderValue::from_static("original"));
        assert_eq!(
            response(upstream(), &Method::GET, &headers)
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
}
