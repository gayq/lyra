use super::{
    read_body_limited, send_with_retry, source_metadata, track_language, EpisodeKey, ResolveError,
    ResolvedSource, StreamProvider, SubtitleTrack, FAILED_SOURCES, MAX_METADATA_BYTES,
};
use reqwest::header::{ACCEPT, REFERER};
use serde_json::Value;
use url::Url;

const BASE: &str = "https://megavid.buzz";

fn embed_urls(key: &EpisodeKey) -> Vec<String> {
    [("mal", key.mal_id), ("ani", key.anilist_id)]
        .into_iter()
        .filter(|(_, id)| *id > 0)
        .map(|(catalog, id)| format!("{BASE}/{catalog}/{id}/{}/{}", key.episode, key.language))
        .collect()
}

fn source_endpoint(html: &str, embed: &str) -> Option<Url> {
    let marker = ["id=\"player-payload\"", "id='player-payload'"]
        .into_iter()
        .find_map(|marker| html.find(marker))?;
    let contents = html
        .get(marker..)?
        .split_once('>')?
        .1
        .split_once("</script>")?
        .0;
    let payload: Value = serde_json::from_str(contents).ok()?;
    let base = Url::parse(embed).ok()?;
    let endpoint = base.join(payload.get("sourceUrl")?.as_str()?).ok()?;
    (endpoint.origin() == base.origin()
        && endpoint.path() == format!("{}/source", base.path())
        && endpoint.username().is_empty()
        && endpoint.password().is_none()
        && endpoint.fragment().is_none())
    .then_some(endpoint)
}

fn https_url(value: &Value) -> Option<String> {
    let url = Url::parse(value.as_str()?.trim()).ok()?;
    (url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none())
    .then(|| url.to_string())
}

fn parse_source(
    payload: &Value,
    embed: &str,
    language: &str,
) -> Result<ResolvedSource, ResolveError> {
    match payload.get("status").and_then(Value::as_str) {
        Some("ok") => {}
        Some("missing") => return Err(ResolveError::NotFound),
        _ => return Err(ResolveError::Upstream),
    }
    let playlist_url = payload
        .get("source")
        .and_then(https_url)
        .ok_or(ResolveError::Upstream)?;
    if payload.get("type").and_then(Value::as_str) != Some("hls")
        && !Url::parse(&playlist_url).is_ok_and(|url| url.path().ends_with(".m3u8"))
    {
        return Err(ResolveError::Upstream);
    }
    let tracks = payload
        .get("tracks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|track| {
            Some(SubtitleTrack {
                url: https_url(track.get("file")?)?,
                label: track
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or("subtitles")
                    .to_string(),
                language: track_language(track),
                kind: track
                    .get("kind")
                    .or_else(|| track.get("type"))
                    .and_then(Value::as_str)
                    .unwrap_or("subtitles")
                    .to_string(),
                default: track
                    .get("default")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect();
    Ok(ResolvedSource {
        provider: StreamProvider::Megavid,
        playlist_url,
        fallback_playlist_url: None,
        master: std::sync::Arc::new(String::new()),
        tracks,
        internal_id: embed.strip_prefix(BASE).unwrap_or_default().to_string(),
        generation: 0,
        language: Some(language.to_string()),
        metadata: source_metadata(payload),
    })
}

pub(super) async fn resolve(
    client: &reqwest::Client,
    key: &EpisodeKey,
) -> Result<ResolvedSource, ResolveError> {
    let mut failure = ResolveError::NotFound;
    for embed in embed_urls(key) {
        let result = async {
            let response = send_with_retry(|| {
                client
                    .get(&embed)
                    .header(ACCEPT, "text/html")
                    .header(REFERER, format!("{BASE}/"))
                    .header("Sec-Fetch-Dest", "iframe")
            })
            .await?;
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                return Err(ResolveError::NotFound);
            }
            if !response.status().is_success() {
                return Err(ResolveError::Upstream);
            }
            let body = read_body_limited(response, MAX_METADATA_BYTES).await?;
            let html = std::str::from_utf8(&body).map_err(|_| ResolveError::Upstream)?;
            let endpoint = source_endpoint(html, &embed).ok_or(ResolveError::Upstream)?;
            let mut failure = ResolveError::NotFound;
            for fallback in [false, true] {
                let mut endpoint = endpoint.clone();
                if fallback {
                    endpoint.query_pairs_mut().append_pair("provider", "1");
                }
                let response = send_with_retry(|| {
                    client
                        .get(endpoint.clone())
                        .header(ACCEPT, "application/json")
                        .header(REFERER, &embed)
                        .header("Origin", BASE)
                })
                .await?;
                if response.status() == reqwest::StatusCode::NOT_FOUND {
                    continue;
                }
                if !response.status().is_success() {
                    failure = ResolveError::Upstream;
                    continue;
                }
                let body = read_body_limited(response, MAX_METADATA_BYTES).await?;
                let payload: Value =
                    serde_json::from_slice(&body).map_err(|_| ResolveError::Upstream)?;
                match parse_source(&payload, &embed, &key.language) {
                    Ok(source) if FAILED_SOURCES.get(&source.playlist_url).await.is_none() => {
                        return Ok(source)
                    }
                    Ok(_) => {}
                    Err(error) => failure = error,
                }
            }
            Err(failure)
        }
        .await;
        match result {
            Ok(source) => return Ok(source),
            Err(error) if !matches!(error, ResolveError::NotFound) => failure = error,
            Err(_) => {}
        }
    }
    Err(failure)
}