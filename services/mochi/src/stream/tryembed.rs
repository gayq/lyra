use super::{
    read_body_limited, send_with_retry, source_metadata, track_language, EpisodeKey, ResolveError,
    ResolvedSource, StreamProvider, SubtitleTrack, FAILED_SOURCES, MAX_METADATA_BYTES,
};
use base64::Engine as _;
use reqwest::header::{HeaderMap, ACCEPT, COOKIE, REFERER, SET_COOKIE};
use serde_json::Value;
use url::Url;

const BASE: &str = "https://tryembed.us.cc";

fn embed_urls(key: &EpisodeKey) -> Vec<String> {
    [("", key.anilist_id), ("mal/", key.mal_id)]
        .into_iter()
        .filter(|(_, id)| *id > 0)
        .map(|(catalog, id)| {
            format!(
                "{BASE}/embed/anime/{catalog}{id}/{}/{}",
                key.episode, key.language
            )
        })
        .collect()
}

fn string_literal<'a>(html: &'a str, marker: &str) -> Option<&'a str> {
    html.split_once(marker)
        .and_then(|(_, rest)| rest.split_once('"'))
        .map(|(encoded, _)| encoded)
}

fn player_payload(html: &str) -> Result<Value, ResolveError> {
    let encoded = string_literal(html, "window.RAW_PAYLOAD=\"").ok_or(ResolveError::Upstream)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| ResolveError::Upstream)?;
    serde_json::from_slice(&bytes).map_err(|_| ResolveError::Upstream)
}

fn https_url(value: &Value) -> Option<String> {
    let url = Url::parse(value.as_str()?.trim()).ok()?;
    (url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none())
    .then(|| url.to_string())
}

fn token_url(value: &Value) -> Option<String> {
    let token = value.as_str()?;
    (!token.is_empty()
        && token.len() <= 4096
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')))
    .then(|| format!("{BASE}/s/{token}.m3u8"))
}

fn payload_id(payload: &Value, key: &EpisodeKey) -> Result<i64, ResolveError> {
    if payload.get("error").is_some() {
        return Err(ResolveError::NotFound);
    }
    let meta = payload.get("meta").ok_or(ResolveError::Upstream)?;
    let anilist_id = meta
        .get("anilist_id")
        .and_then(|id| id.as_i64().or_else(|| id.as_str()?.parse::<i64>().ok()))
        .filter(|id| *id > 0)
        .ok_or(ResolveError::Upstream)?;
    if meta.get("type").and_then(Value::as_str) != Some("anime")
        || (key.anilist_id > 0 && anilist_id != key.anilist_id)
        || meta.get("episode").and_then(Value::as_i64) != Some(i64::from(key.episode))
        || meta.get("audio").and_then(Value::as_str) != Some(key.language.as_str())
    {
        return Err(ResolveError::Upstream);
    }
    Ok(anilist_id)
}

fn parse_sources(payload: &Value, key: &EpisodeKey) -> Result<Vec<ResolvedSource>, ResolveError> {
    let anilist_id = payload_id(payload, key)?;
    let Some(providers) = payload.get("providers") else {
        return Err(ResolveError::NotFound);
    };
    let providers = providers.as_array().ok_or(ResolveError::Upstream)?;
    let mut sources = Vec::new();
    for provider in providers {
        if provider.get("status").and_then(Value::as_str) != Some("ready")
            || provider.get("type").and_then(Value::as_str) != Some("hls")
        {
            continue;
        }
        let tracks: Vec<_> = provider
            .get("captions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|track| {
                Some(SubtitleTrack {
                    url: https_url(track.get("url")?)?,
                    label: track
                        .get("label")
                        .and_then(Value::as_str)
                        .unwrap_or("subtitles")
                        .to_string(),
                    language: track_language(track),
                    kind: "captions".to_string(),
                    default: track
                        .get("default")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                })
            })
            .collect();
        let mut metadata = source_metadata(payload);
        metadata.server = provider
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string);
        for quality in provider
            .get("qualities")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let primary = quality
                .get("directUrl")
                .and_then(https_url)
                .or_else(|| quality.get("token").and_then(token_url));
            let fallback = quality.get("fallbackToken").and_then(token_url);
            if let Some(playlist_url) = primary.clone().or_else(|| fallback.clone()) {
                sources.push(ResolvedSource {
                    provider: StreamProvider::Tryembed,
                    playlist_url,
                    fallback_playlist_url: primary.and(fallback),
                    master: std::sync::Arc::new(String::new()),
                    tracks: tracks.clone(),
                    internal_id: format!("{anilist_id}/{}/{}", key.episode, key.language),
                    generation: 0,
                    language: Some(key.language.clone()),
                    metadata: metadata.clone(),
                });
            }
        }
    }
    if sources.is_empty() {
        Err(ResolveError::NotFound)
    } else {
        Ok(sources)
    }
}

fn embed_cookies(headers: &HeaderMap) -> String {
    headers
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|value| {
            let pair = value.to_str().ok()?.split(';').next()?;
            let (name, _) = pair.split_once('=')?;
            (name == "tryembed_auth" || name.starts_with("tryembed_session_")).then_some(pair)
        })
        .collect::<Vec<_>>()
        .join("; ")
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
            let cookies = embed_cookies(response.headers());
            let body = read_body_limited(response, MAX_METADATA_BYTES).await?;
            let html = std::str::from_utf8(&body).map_err(|_| ResolveError::Upstream)?;
            let mut payload = player_payload(html)?;
            let anilist_id = payload_id(&payload, key)?;
            if matches!(parse_sources(&payload, key), Err(ResolveError::NotFound)) {
                let nonce = string_literal(html, "window.EMBED_NONCE=\"")
                    .filter(|nonce| token_url(&Value::String(nonce.to_string())).is_some())
                    .ok_or(ResolveError::Upstream)?;
                let mut endpoint = Url::parse(&format!("{BASE}/api/stream_data"))
                    .map_err(|_| ResolveError::Upstream)?;
                endpoint
                    .query_pairs_mut()
                    .append_pair("id", &anilist_id.to_string())
                    .append_pair("episode", &key.episode.to_string())
                    .append_pair("audio", &key.language)
                    .append_pair("player", "jw")
                    .append_pair("nonce", nonce);
                let response = send_with_retry(|| {
                    client
                        .get(endpoint.clone())
                        .header(ACCEPT, "application/json")
                        .header(REFERER, &embed)
                        .header(COOKIE, &cookies)
                        .header("X-Embed-Nonce", nonce)
                        .header("Sec-Fetch-Site", "same-origin")
                        .header("Sec-Fetch-Mode", "cors")
                        .header("Sec-Fetch-Dest", "empty")
                })
                .await?;
                if !response.status().is_success() {
                    return Err(ResolveError::Upstream);
                }
                payload =
                    serde_json::from_slice(&read_body_limited(response, MAX_METADATA_BYTES).await?)
                        .map_err(|_| ResolveError::Upstream)?;
            }
            for mut source in parse_sources(&payload, key)? {
                if FAILED_SOURCES.get(&source.playlist_url).await.is_some() {
                    if let Some(fallback) = source.fallback_playlist_url.take() {
                        source.playlist_url = fallback;
                    }
                }
                if FAILED_SOURCES.get(&source.playlist_url).await.is_none() {
                    return Ok(source);
                }
            }
            Err(ResolveError::NotFound)
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