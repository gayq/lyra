use super::{
    absolute_url, fetch_playlist, hls_attribute, hls_attribute_list, probe_media,
    read_body_limited, send_with_retry, source_metadata, subtitle_tracks, track_language,
    EpisodeKey, ResolveError, ResolvedSource, StreamProvider, FAILED_SOURCES, MAX_METADATA_BYTES,
};
use base64::Engine as _;
use futures_util::StreamExt;
use reqwest::header::{ACCEPT, REFERER};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, LazyLock,
    },
    time::Duration,
};
use url::Url;

mod cinejoy;
mod vidfast;

#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq)]
pub(super) enum MovieServer {
    Valkyrie,
    Boise,
    HogRider,
    LavaHound,
    SuperBarbarian,
}

impl MovieServer {
    pub(super) const ALL: [Self; 5] = [
        Self::Valkyrie,
        Self::Boise,
        Self::HogRider,
        Self::LavaHound,
        Self::SuperBarbarian,
    ];

    fn id(self) -> &'static str {
        match self {
            Self::Valkyrie | Self::Boise => "valkyrie",
            Self::HogRider => "hog_rider",
            Self::LavaHound => "lavahound",
            Self::SuperBarbarian => "super_barbarian",
        }
    }

    pub(super) fn referer(self) -> &'static str {
        match self {
            Self::Valkyrie | Self::Boise => "https://player.videasy.to/",
            Self::HogRider => "https://vidup.to/",
            Self::LavaHound => "https://vidfast.vc/",
            Self::SuperBarbarian => "https://cinejoy.pk/",
        }
    }
}

static MOVIE_JSON: LazyLock<moka::future::Cache<String, Value>> = LazyLock::new(|| {
    moka::future::Cache::builder()
        .max_capacity(256)
        .time_to_live(Duration::from_secs(60))
        .build()
});

const API: &str = "https://api.framextv.tech";
const API_FALLBACK: &str = "https://api.framextv.xyz";
const ANIME_APIS: [&str; 3] = [API, API_FALLBACK, "https://api.framextv.cc"];
static ANIME_API: AtomicUsize = AtomicUsize::new(0);
const ANIME_API_HEDGE_DELAY: Duration = Duration::from_millis(1500);

static ANIME_SOURCES: LazyLock<moka::future::Cache<(i64, i32), Arc<Vec<ResolvedSource>>>> =
    LazyLock::new(|| {
        moka::future::Cache::builder()
            .max_capacity(128)
            .time_to_live(Duration::from_secs(10 * 60))
            .build()
    });

fn mix(mut value: u32) -> u32 {
    value ^= value >> 16;
    value = value.wrapping_mul(2246822507);
    value ^= value >> 13;
    value = value.wrapping_mul(3266489909);
    value ^ (value >> 16)
}

fn decode_movie_sources(text: &str, seed: &str, tmdb: u32) -> Result<Value, ResolveError> {
    let mut bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(text.trim().trim_end_matches('='))
        .map_err(|_| ResolveError::Upstream)?;
    let hash = seed.encode_utf16().fold(2166136261u32, |hash, character| {
        (hash ^ u32::from(character)).wrapping_mul(16777619)
    });
    let mut value = mix(mix(hash) ^ mix(tmdb ^ 2654435769));
    let mut slots = [None; 61];
    for index in 0..8 {
        let slot = (value % 61) as usize;
        value = value.wrapping_add(2654435769).rotate_left(7 + (index & 7));
        slots[slot] = Some(value ^ mix(value));
        value = mix(value.wrapping_add(slot as u32));
    }
    let mut accumulator = mix(2779096485 ^ value);
    for (index, chunk) in bytes.chunks_mut(4).enumerate() {
        let slot = (accumulator % 61) as usize;
        let previous = slots[slot].unwrap_or(0);
        let mask = if slots[slot].is_some() { u32::MAX } else { 0 };
        let counter = (index as u32 + 1).wrapping_mul(2654435769);
        let combined = previous ^ counter;
        let rotated = ((accumulator ^ combined) | (accumulator & combined & mask))
            .wrapping_add(accumulator)
            .rotate_left(slot as u32 & 31);
        let next =
            mix((rotated ^ accumulator.rotate_left((slot as u32 * 7) & 31))
                .wrapping_add(2654435769));
        slots[slot] = Some(next);
        accumulator = next;
        for (byte, mask) in chunk.iter_mut().zip(next.to_le_bytes()) {
            *byte ^= mask;
        }
    }
    let payload = bytes.strip_prefix(b"mvm1").ok_or(ResolveError::Upstream)?;
    serde_json::from_slice(payload).map_err(|_| ResolveError::Upstream)
}

fn movie_id(payload: &Value, key: &EpisodeKey) -> Option<u32> {
    let mapping = payload.get("mappings")?;
    if key.episode != 1
        || mapping.get("type")?.as_str()? != "MOVIE"
        || mapping.get("anilist_id")?.as_i64()? != key.anilist_id
    {
        return None;
    }
    let id = mapping.get("themoviedb_id")?;
    let id = id
        .as_str()
        .and_then(|id| id.parse().ok())
        .or_else(|| id.as_u64().and_then(|id| u32::try_from(id).ok()))?;
    (id > 0).then_some(id)
}

fn movie_url(value: &str) -> Option<String> {
    let mut url = Url::parse(API).ok()?.join(value).ok()?;
    if url.host_str() == Some("api.framextv.tech")
        && matches!(url.path(), "/api/proxy" | "/api/subtitles/proxy")
        || matches!(
            url.host_str(),
            Some("spatula.hybrows.workers.dev" | "zenith.hybrows.workers.dev")
        )
    {
        let targets: Vec<_> = url
            .query_pairs()
            .filter(|(key, _)| key == "url")
            .map(|(_, value)| value.into_owned())
            .collect();
        if targets.len() != 1 {
            return None;
        }
        url = Url::parse(&targets[0]).ok()?;
    }
    (url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.fragment().is_none()
        && crate::safe_dns::validate_public_target(&url).is_ok())
    .then(|| url.to_string())
}

async fn movie_json(client: &reqwest::Client, url: &str) -> Result<Value, ResolveError> {
    let response = send_with_retry(|| {
        client
            .get(url)
            .header(REFERER, "https://framextv.cc/")
            .header(ACCEPT, "application/json")
    })
    .await?;
    if !response.status().is_success() {
        return Err(ResolveError::Upstream);
    }
    let body = read_body_limited(response, MAX_METADATA_BYTES).await?;
    serde_json::from_slice(&body).map_err(|_| ResolveError::Upstream)
}

async fn cached_movie_json(client: &reqwest::Client, url: String) -> Result<Value, ResolveError> {
    MOVIE_JSON
        .try_get_with(url.clone(), movie_json(client, &url))
        .await
        .map_err(|error| *error)
}

fn movie_tracks(native: &Value, additional: Option<&Value>) -> Vec<super::SubtitleTrack> {
    let tracks: Vec<_> = native
        .get("subtitles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .chain(
            additional
                .and_then(|payload| payload.get("subtitles"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten(),
        )
        .filter_map(|track| {
            let url = movie_url(track.get("url").or_else(|| track.get("file"))?.as_str()?)?;
            let mut track = track.clone();
            track["file"] = json!(url);
            if track.get("label").is_none() {
                track["label"] = track
                    .get("name")
                    .or_else(|| track.get("language"))
                    .or_else(|| track.get("lang"))
                    .cloned()
                    .unwrap_or(Value::Null);
            }
            track.as_object_mut()?.remove("format");
            Some(track)
        })
        .collect();
    subtitle_tracks(&json!({"tracks": tracks}))
}

fn movie_candidates(payload: &Value, tmdb: u32, server: MovieServer) -> Vec<ResolvedSource> {
    let mut candidates = Vec::new();
    let master = payload
        .get("playlist")
        .and_then(Value::as_str)
        .map(|url| json!({"url":url,"type":"hls"}));
    for candidate in master.iter().chain(
        payload
            .get("sources")
            .and_then(Value::as_array)
            .into_iter()
            .flatten(),
    ) {
        let Some(raw) = candidate
            .get("url")
            .or_else(|| candidate.get("file"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let Some(url) = movie_url(raw) else {
            continue;
        };
        if candidate
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind != "hls")
            || candidates
                .iter()
                .any(|source: &ResolvedSource| source.playlist_url == url)
        {
            continue;
        }
        let mut metadata = source_metadata(candidate);
        if metadata.server.is_none() {
            metadata.server = Some(server.id().into());
        }
        candidates.push(ResolvedSource {
            provider: StreamProvider::Framex4k(server),
            playlist_url: url,
            fallback_playlist_url: None,
            master: Default::default(),
            tracks: movie_tracks(candidate, Some(payload)),
            internal_id: format!("movie:{tmdb}"),
            generation: 0,
            language: None,
            metadata,
        });
    }
    candidates
}

async fn city_sources(
    client: &reqwest::Client,
    tmdb: u32,
    server: MovieServer,
) -> Result<Value, ResolveError> {
    let payload = movie_json(
        client,
        &format!("https://api.wecollege.net/seed?mediaId={tmdb}"),
    )
    .await?;
    let seed = payload
        .get("seed")
        .and_then(Value::as_str)
        .ok_or(ResolveError::Upstream)?;
    let city = if server == MovieServer::Boise {
        "boise"
    } else {
        "miami"
    };
    let response = send_with_retry(|| {
        client
            .get(format!("https://api.wecollege.net/{city}/sources"))
            .headers(StreamProvider::Framex4k(server).headers())
            .query(&[
                ("mediaType", "movie"),
                ("tmdbId", &tmdb.to_string()),
                ("enc", "2"),
                ("seed", seed),
            ])
    })
    .await?;
    if !response.status().is_success() {
        return Err(ResolveError::Upstream);
    }
    let body = read_body_limited(response, MAX_METADATA_BYTES).await?;
    decode_movie_sources(
        std::str::from_utf8(&body).map_err(|_| ResolveError::Upstream)?,
        seed,
        tmdb,
    )
}

async fn api_movie_sources(
    client: &reqwest::Client,
    tmdb: u32,
    server: MovieServer,
) -> Result<Value, ResolveError> {
    let payload = movie_json(
        client,
        &format!(
            "{API}/api/stream?type=movie&id={tmdb}&provider={}",
            server.id()
        ),
    )
    .await?;
    if payload.get("success").and_then(Value::as_bool) != Some(true)
        || payload.get("provider").and_then(Value::as_str) != Some(server.id())
    {
        return Err(ResolveError::NotFound);
    }
    Ok(payload)
}

async fn ready_movie(
    client: &reqwest::Client,
    payload: Value,
    tmdb: u32,
    server: MovieServer,
) -> Result<ResolvedSource, ResolveError> {
    super::first_ready(movie_candidates(&payload, tmdb, server).into_iter().map(
        |source| async move {
            let source = super::prepare_source(client, source).await?;
            if super::has_4k(&source) {
                Ok(source)
            } else {
                Err(ResolveError::NotFound)
            }
        },
    ))
    .await
}

pub(super) async fn resolve_4k(
    client: &reqwest::Client,
    key: &EpisodeKey,
    server: MovieServer,
) -> Result<ResolvedSource, ResolveError> {
    if key.anilist_id <= 0 || key.episode != 1 {
        return Err(ResolveError::NotFound);
    }
    let mapping = cached_movie_json(
        client,
        format!("https://api.ani.zip/mappings?anilist_id={}", key.anilist_id),
    )
    .await?;
    let tmdb = movie_id(&mapping, key).ok_or(ResolveError::NotFound)?;
    let source = async {
        match server {
            MovieServer::Valkyrie | MovieServer::Boise => {
                ready_movie(
                    client,
                    city_sources(client, tmdb, server).await?,
                    tmdb,
                    server,
                )
                .await
            }
            MovieServer::SuperBarbarian => {
                super::first_ready(
                    cinejoy::SERVERS
                        .into_iter()
                        .map(Some)
                        .chain(std::iter::once(None))
                        .map(|city| async move {
                            let payload = match city {
                                Some(city) => cinejoy::sources(client, tmdb, city).await?,
                                None => api_movie_sources(client, tmdb, server).await?,
                            };
                            ready_movie(client, payload, tmdb, server).await
                        }),
                )
                .await
            }
            MovieServer::HogRider | MovieServer::LavaHound => {
                let direct = vidfast::resolve(client, tmdb, server);
                let api = async {
                    ready_movie(
                        client,
                        api_movie_sources(client, tmdb, server).await?,
                        tmdb,
                        server,
                    )
                    .await
                };
                tokio::pin!(direct, api);
                tokio::select! {
                    result = &mut direct => match result { Ok(source) => Ok(source), Err(_) => api.await },
                    result = &mut api => match result { Ok(source) => Ok(source), Err(_) => direct.await },
                }
            }
        }
    };
    let captions = async {
        tokio::time::timeout(
            Duration::from_secs(5),
            cached_movie_json(client, format!("{API}/api/subtitles?id={tmdb}&type=movie")),
        )
        .await
        .ok()
        .and_then(Result::ok)
    };
    let (source, captions) = tokio::join!(source, captions);
    let mut source = source?;
    for track in movie_tracks(&json!({}), captions.as_ref()) {
        if !source
            .tracks
            .iter()
            .any(|existing| existing.url == track.url)
        {
            source.tracks.push(track);
        }
    }
    Ok(super::with_master(source.clone(), source.master.clone()))
}

fn server(language: &str) -> &'static str {
    if language == "dub" {
        "goblin_dub"
    } else {
        "goblin"
    }
}

fn source_url(value: &str) -> Option<Url> {
    let base = Url::parse(API).ok()?;
    let mut url = base.join(value).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port().is_some()
    {
        return None;
    }
    if ANIME_APIS
        .iter()
        .any(|api| url.origin() == Url::parse(api).unwrap().origin())
        && matches!(
            url.path(),
            "/anime/api/proxy" | "/anime/api/subtitles/proxy"
        )
    {
        let mut targets = url.query_pairs().filter(|(key, _)| key == "url");
        let target = targets.next()?.1.into_owned();
        if targets.next().is_some() {
            return None;
        }
        url = Url::parse(&target).ok()?;
    }
    (url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.port().is_none()
        && matches!(
            url.host_str(),
            Some("hls.krussdomi.com" | "subst.krussdomi.com" | "krussdomi.com")
        ))
    .then_some(url)
}

fn anime_playlist(candidate: &Value) -> Option<Url> {
    let value = candidate.get("url")?.as_str()?;
    if value != "https://kaa.lt/intro.mp4" {
        return source_url(value);
    }
    let mut media_id = None;
    for caption in candidate.get("subtitles")?.as_array()? {
        let url = source_url(caption.get("url")?.as_str()?)?;
        if url.host_str() != Some("subst.krussdomi.com") {
            return None;
        }
        let id = url.path_segments()?.next()?;
        if id.len() != 24 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        if media_id.as_ref().is_some_and(|previous| previous != id) {
            return None;
        }
        media_id = Some(id.to_string());
    }
    Url::parse(&format!(
        "https://hls.krussdomi.com/manifest/{}/master.m3u8",
        media_id?
    ))
    .ok()
}

fn parse_sources(payload: &Value, key: &EpisodeKey) -> Result<Vec<ResolvedSource>, ResolveError> {
    if payload.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(ResolveError::NotFound);
    }
    if payload.get("provider").and_then(Value::as_str) != Some(server(&key.language))
        || payload.get("audio").and_then(Value::as_str) != Some(key.language.as_str())
        || payload.pointer("/meta/id").and_then(Value::as_i64) != Some(key.anilist_id)
    {
        return Err(ResolveError::NotFound);
    }
    let mut sources = Vec::new();
    for candidate in payload
        .get("sources")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if candidate.get("audio").and_then(Value::as_str) != Some(key.language.as_str()) {
            continue;
        }
        let Some(url) = anime_playlist(candidate) else {
            continue;
        };
        if url.host_str() != Some("hls.krussdomi.com")
            || !url.path().starts_with("/manifest/")
            || !url.path().ends_with(".m3u8")
            || sources
                .iter()
                .any(|source: &ResolvedSource| source.playlist_url == url.as_str())
        {
            continue;
        }
        let tracks: Vec<_> = candidate
            .get("subtitles")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|track| {
                let url = source_url(track.get("url")?.as_str()?)?;
                let mut track = track.clone();
                track["file"] = json!(url.as_str());
                if track.get("label").is_none() {
                    track["label"] = track.get("lang").cloned().unwrap_or(Value::Null);
                }
                Some(track)
            })
            .collect();
        sources.push(ResolvedSource {
            provider: StreamProvider::Framex,
            playlist_url: url.to_string(),
            fallback_playlist_url: None,
            master: Default::default(),
            tracks: subtitle_tracks(&json!({"tracks": tracks})),
            internal_id: format!("{}:{}:{}", key.anilist_id, key.episode, url.path()),
            generation: 0,
            language: Some(key.language.clone()),
            metadata: source_metadata(candidate),
        });
    }
    if sources.is_empty() {
        Err(ResolveError::NotFound)
    } else {
        Ok(sources)
    }
}

pub(super) fn audio_url(master: &str, base: &str, language: &str) -> Option<String> {
    let wanted = if language == "dub" { "en" } else { "ja" };
    master.lines().find_map(|line| {
        let attrs = hls_attribute_list(line.trim().strip_prefix("#EXT-X-MEDIA:")?);
        if hls_attribute(&attrs, "TYPE") != Some("AUDIO") {
            return None;
        }
        let language = track_language(&json!({
            "language": hls_attribute(&attrs, "LANGUAGE"),
            "label": hls_attribute(&attrs, "NAME"),
        }));
        (language.split('-').next() == Some(wanted))
            .then(|| absolute_url(base, hls_attribute(&attrs, "URI")?))
            .flatten()
    })
}

async fn anime_api_sources(
    client: &reqwest::Client,
    key: &EpisodeKey,
    index: usize,
) -> Result<Arc<Vec<ResolvedSource>>, ResolveError> {
    let api = ANIME_APIS[index];
    let result = tokio::time::timeout(Duration::from_secs(8), async {
        let response = send_with_retry(|| {
            client
                .get(format!("{api}/anime/api/stream"))
                .query(&[
                    ("id", key.anilist_id.to_string()),
                    ("episode", key.episode.to_string()),
                    ("type", "tv".into()),
                    ("season", "1".into()),
                    ("sub_type", "sub".into()),
                    ("provider", "goblin".into()),
                ])
                .header(ACCEPT, "application/json")
                .header(REFERER, "https://framextv.cc/")
                .header("origin", "https://framextv.cc")
        })
        .await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(ResolveError::NotFound);
        }
        if !response.status().is_success() {
            return Err(ResolveError::Upstream);
        }
        let body = read_body_limited(response, MAX_METADATA_BYTES).await?;
        let payload = serde_json::from_slice(&body).map_err(|_| ResolveError::Upstream)?;
        parse_sources(&payload, key).map(Arc::new)
    })
    .await
    .unwrap_or(Err(ResolveError::Upstream));
    if matches!(result, Ok(_) | Err(ResolveError::NotFound)) {
        ANIME_API.store(index, Ordering::Relaxed);
    }
    result
}

async fn anime_sources(
    client: &reqwest::Client,
    key: &EpisodeKey,
) -> Result<Arc<Vec<ResolvedSource>>, ResolveError> {
    let mut discovery_key = key.clone();
    discovery_key.language = "sub".into();
    ANIME_SOURCES
        .try_get_with((key.anilist_id, key.episode), async {
            let preferred = ANIME_API.load(Ordering::Relaxed);
            let mut pending = futures_util::stream::FuturesUnordered::new();
            let mut started = 0;
            let mut failure = ResolveError::Upstream;
            loop {
                if pending.is_empty() {
                    if started == ANIME_APIS.len() {
                        return Err(failure);
                    }
                    pending.push(anime_api_sources(
                        client,
                        &discovery_key,
                        (preferred + started) % ANIME_APIS.len(),
                    ));
                    started += 1;
                }
                tokio::select! {
                    Some(result) = pending.next() => match result {
                        Ok(sources) => return Ok(sources),
                        Err(ResolveError::NotFound) => return Err(ResolveError::NotFound),
                        Err(error) => failure = error,
                    },
                    () = tokio::time::sleep(ANIME_API_HEDGE_DELAY), if started < ANIME_APIS.len() => {
                        pending.push(anime_api_sources(
                            client,
                            &discovery_key,
                            (preferred + started) % ANIME_APIS.len(),
                        ));
                        started += 1;
                    }
                }
            }
        })
        .await
        .map_err(|error| *error)
}

async fn prepare_anime(
    client: &reqwest::Client,
    key: &EpisodeKey,
    mut source: ResolvedSource,
) -> Result<ResolvedSource, ResolveError> {
    if FAILED_SOURCES.get(&source.playlist_url).await.is_some() {
        return Err(ResolveError::Upstream);
    }
    let master = fetch_playlist(client, &source.playlist_url, source.provider).await?;
    let audio =
        audio_url(&master, &source.playlist_url, &key.language).ok_or(ResolveError::NotFound)?;
    source.language = Some(key.language.clone());
    let provider = source.provider;
    let audio_ready = async {
        tokio::time::timeout(super::QUALITY_CHECK_TIMEOUT, async {
            let media = fetch_playlist(client, &audio, provider).await?;
            probe_media(client, &audio, &media, provider).await
        })
        .await
        .map_err(|_| ResolveError::Upstream)?
    };
    let ((), source) =
        tokio::try_join!(audio_ready, Box::pin(super::prepare_source(client, source)))?;
    Ok(source)
}

pub(super) async fn resolve(
    client: &reqwest::Client,
    key: &EpisodeKey,
) -> Result<ResolvedSource, ResolveError> {
    if key.anilist_id <= 0 {
        return Err(ResolveError::NotFound);
    }
    let candidates = anime_sources(client, key).await?;
    let mut pending = futures_util::stream::iter(candidates.iter().cloned().map(|source| async move {
        tokio::time::timeout(Duration::from_secs(5), prepare_anime(client, key, source))
            .await
            .unwrap_or(Err(ResolveError::Upstream))
    }))
    .buffer_unordered(2);
    let mut failed = false;
    while let Some(result) = pending.next().await {
        match result {
            Ok(source) => return Ok(source),
            Err(ResolveError::NotFound) => {}
            Err(_) => failed = true,
        }
    }
    if failed {
        ANIME_SOURCES
            .invalidate(&(key.anilist_id, key.episode))
            .await;
    }
    Err(ResolveError::NotFound)
}

pub(super) async fn reclaim_caches() {
    ANIME_SOURCES.invalidate_all();
    ANIME_SOURCES.run_pending_tasks().await;
}

pub(super) async fn invalidate(key: &EpisodeKey) {
    ANIME_SOURCES
        .invalidate(&(key.anilist_id, key.episode))
        .await;
}

