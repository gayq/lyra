use super::{
    movie_url, read_body_limited, ready_movie, send_with_retry, MovieServer, ResolveError,
    ResolvedSource, MAX_METADATA_BYTES,
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use url::Url;

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str, ResolveError> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(ResolveError::Upstream)
}

fn page_token(html: &str) -> Option<&str> {
    [r#"\"en\":\""#, r#"\"token\":\""#]
        .into_iter()
        .filter_map(|prefix| {
            let index = html.find(prefix)?;
            Some((index, html[index + prefix.len()..].split_once(r#"\""#)?.0))
        })
        .min_by_key(|(index, _)| *index)
        .map(|(_, token)| token)
        .filter(|token| !token.is_empty() && token.len() < 32768)
}

async fn response_text(response: reqwest::Response) -> Result<String, ResolveError> {
    if !response.status().is_success() {
        return Err(ResolveError::Upstream);
    }
    String::from_utf8(
        read_body_limited(response, MAX_METADATA_BYTES)
            .await?
            .to_vec(),
    )
    .map_err(|_| ResolveError::Upstream)
}

async fn codec(
    client: &reqwest::Client,
    site: &str,
    text: &str,
    stage: Option<u8>,
) -> Result<Value, ResolveError> {
    let response = send_with_retry(|| {
        if let Some(stage) = stage {
            client
                .get(format!("https://enc-dec.app/api/enc-{site}"))
                .query(&[("text", text), ("stage", &stage.to_string())])
        } else {
            client
                .post(format!("https://enc-dec.app/api/dec-{site}"))
                .json(&json!({"text": text}))
        }
    })
    .await?;
    let payload: Value = serde_json::from_str(&response_text(response).await?)
        .map_err(|_| ResolveError::Upstream)?;
    if payload.get("status").and_then(Value::as_u64) != Some(200) {
        return Err(ResolveError::Upstream);
    }
    payload.get("result").cloned().ok_or(ResolveError::Upstream)
}

fn endpoint(url: &str, referer: &str) -> Result<Url, ResolveError> {
    let url = Url::parse(url).map_err(|_| ResolveError::Upstream)?;
    if url.origin() != Url::parse(referer).unwrap().origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(ResolveError::Upstream);
    }
    Ok(url)
}

async fn exchange(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    server: MovieServer,
) -> Result<String, ResolveError> {
    let url = endpoint(url, server.referer())?;
    response_text(
        send_with_retry(|| {
            client
                .post(url.clone())
                .headers(super::StreamProvider::Framex4k(server).headers())
                .header("x-requested-with", "XMLHttpRequest")
                .header("x-csrf-token", token)
        })
        .await?,
    )
    .await
}

fn source_payload(payload: &Value, tmdb: u32, name: &str) -> Result<Value, ResolveError> {
    if payload.get("tmdbId").and_then(Value::as_u64) != Some(u64::from(tmdb))
        || payload.get("mp4").and_then(Value::as_bool) == Some(true)
    {
        return Err(ResolveError::NotFound);
    }
    let url = movie_url(field(payload, "url")?).ok_or(ResolveError::NotFound)?;
    Ok(json!({"sources":[{"url":url, "type":"hls", "server":name,
        "subtitles":payload.get("tracks").cloned().unwrap_or_else(|| json!([]))}]}))
}

pub(super) async fn resolve(
    client: &reqwest::Client,
    tmdb: u32,
    server: MovieServer,
) -> Result<ResolvedSource, ResolveError> {
    let site = match server {
        MovieServer::LavaHound => "vidfast",
        MovieServer::HogRider => "vidup",
        _ => return Err(ResolveError::NotFound),
    };
    let html = response_text(
        send_with_retry(|| client.get(format!("{}movie/{tmdb}", server.referer()))).await?,
    )
    .await?;
    let token = page_token(&html).ok_or(ResolveError::NotFound)?;
    let stage1 = codec(client, site, token, Some(1)).await?;
    let token = stage1
        .get("token")
        .and_then(Value::as_str)
        .ok_or(ResolveError::Upstream)?;
    let text = exchange(client, field(&stage1, "stage1")?, token, server).await?;
    let stage2 = codec(client, site, &text, Some(2)).await?;
    let token = stage2
        .get("token")
        .and_then(Value::as_str)
        .ok_or(ResolveError::Upstream)?;
    let text = exchange(client, field(&stage2, "servers")?, token, server).await?;
    let servers = codec(client, site, &text, None).await?;
    let stream = endpoint(field(&stage2, "stream")?, server.referer())?;
    let candidates: Vec<Value> = servers
        .as_array()
        .ok_or(ResolveError::NotFound)?
        .iter()
        .take(12)
        .cloned()
        .collect();
    let mut pending = futures_util::stream::iter(candidates.into_iter().map(|candidate| {
        let stream = &stream;
        async move {
            let data = field(&candidate, "data")?;
            let mut url = stream.clone();
            url.path_segments_mut()
                .map_err(|_| ResolveError::Upstream)?
                .push(data);
            let text = exchange(client, url.as_str(), token, server).await?;
            let payload = codec(client, site, &text, None).await?;
            ready_movie(
                client,
                source_payload(&payload, tmdb, field(&candidate, "name")?)?,
                tmdb,
                server,
            )
            .await
        }
    }))
    .buffer_unordered(4);
    while let Some(result) = pending.next().await {
        if let Ok(source) = result {
            return Ok(source);
        }
    }
    Err(ResolveError::NotFound)
}

