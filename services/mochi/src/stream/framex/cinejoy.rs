use super::{read_body_limited, send_with_retry, ResolveError, MAX_METADATA_BYTES};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use reqwest::{header::ACCEPT, Response};
use serde_json::{json, Value};

pub(super) const SERVERS: [&str; 4] = ["Lisbon", "Nebula", "Athens", "Solara"];

async fn response_json(response: Response) -> Result<Value, ResolveError> {
    if !response.status().is_success() {
        return Err(ResolveError::Upstream);
    }
    let bytes = read_body_limited(response, MAX_METADATA_BYTES).await?;
    serde_json::from_slice(&bytes).map_err(|_| ResolveError::Upstream)
}

fn source_payload(decoded: &Value) -> Result<Value, ResolveError> {
    let streams = decoded
        .pointer("/data/stream")
        .or_else(|| decoded.get("stream"))
        .and_then(Value::as_array)
        .ok_or(ResolveError::NotFound)?;
    let sources: Vec<_> = streams
        .iter()
        .filter(|stream| stream.get("type").and_then(Value::as_str) == Some("hls"))
        .filter_map(|stream| {
            let url = stream.get("playlist")?.as_str()?;
            Some(json!({
                "url": url,
                "type": "hls",
                "subtitles": stream.get("captions").cloned().unwrap_or_else(|| json!([])),
            }))
        })
        .collect();
    if sources.is_empty() {
        return Err(ResolveError::NotFound);
    }
    Ok(json!({"sources": sources}))
}

pub(super) async fn sources(
    client: &reqwest::Client,
    tmdb: u32,
    server: &str,
) -> Result<Value, ResolveError> {
    if tmdb == 0 || !SERVERS.contains(&server) {
        return Err(ResolveError::NotFound);
    }
    let request_url = format!(
        "https://api.wing.st/?title=movie&type=movie&year=&imdb=&tmdb={tmdb}&server={server}"
    );
    let encoded = response_json(
        send_with_retry(|| {
            client
                .get("https://enc-dec.app/api/enc-cinejoy")
                .query(&[("url", &request_url)])
                .header(ACCEPT, "application/json")
        })
        .await?,
    )
    .await?;
    let result = encoded.get("result").ok_or(ResolveError::Upstream)?;
    let data = result
        .get("data")
        .and_then(Value::as_str)
        .ok_or(ResolveError::Upstream)?;
    let state = result.get("state").ok_or(ResolveError::Upstream)?;
    let body = URL_SAFE_NO_PAD
        .decode(data.trim_end_matches('='))
        .map_err(|_| ResolveError::Upstream)?;
    let response = send_with_retry(|| {
        client
            .post("https://api.wing.st/g")
            .header("origin", "https://cinejoy.pk")
            .header("referer", "https://cinejoy.pk/")
            .header("content-type", "application/octet-stream")
            .body(body.clone())
    })
    .await?;
    if !response.status().is_success() {
        return Err(ResolveError::Upstream);
    }
    let bytes = read_body_limited(response, MAX_METADATA_BYTES).await?;
    let body = json!({"text": URL_SAFE_NO_PAD.encode(bytes), "state": state});
    let decoded = response_json(
        send_with_retry(|| {
            client
                .post("https://enc-dec.app/api/dec-cinejoy")
                .json(&body)
        })
        .await?,
    )
    .await?;
    source_payload(decoded.get("result").ok_or(ResolveError::Upstream)?)
}

