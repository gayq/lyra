mod anilist;
mod config;
mod identity;
mod jikan;
mod models;

use adaptive_capacity::{spawn_rebalancer, AdaptiveGate, CapacityTarget, HostResources, Workload};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use mimalloc::MiMalloc;
use moka::future::Cache;
use serde::Deserialize;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tower_http::cors::{Any, CorsLayer};

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

const NEGATIVE: &str = "... /ᐠ - ˕ -マ";
const POSITIVE: &str = "!! (˵◝ ⩊  ◜˵マ";

fn message_base(mut message: &str) -> &str {
    loop {
        if let Some(base) = message
            .strip_suffix(NEGATIVE)
            .or_else(|| message.strip_suffix(POSITIVE))
        {
            message = base.trim_end();
        } else {
            return message.trim_end_matches(['.', '!']);
        }
    }
}

fn negative_message(message: &str) -> String {
    format!("{}{NEGATIVE}", message_base(message))
}

fn json_weight(value: &serde_json::Value) -> u32 {
    fn size(value: &serde_json::Value) -> usize {
        match value {
            serde_json::Value::Null | serde_json::Value::Bool(_) => 1,
            serde_json::Value::Number(_) => 16,
            serde_json::Value::String(value) => value.len(),
            serde_json::Value::Array(values) => values.iter().map(size).sum(),
            serde_json::Value::Object(values) => values
                .iter()
                .map(|(key, value)| key.len().saturating_add(size(value)))
                .sum(),
        }
    }

    u32::try_from(size(value).saturating_add(128)).unwrap_or(u32::MAX)
}

struct AppState {
    client: reqwest::Client,
    jikan_eps: Cache<i64, Arc<serde_json::Value>>,
    episode_counts: Cache<i64, i32>,
    jikan_rel: Cache<i64, Arc<Vec<models::AnimeRelation>>>,
    anilist_titles: Cache<i64, Arc<Vec<String>>>,
    identity: Cache<String, Arc<identity::AnimeIdentity>>,
    failures: Cache<String, ()>,
    upstream_gate: Arc<AdaptiveGate>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter("isao=info")
        .init();

    let settings = config::IsaoConfig::from_env();
    let resources = HostResources::detect();
    let memory_mb = resources.memory_bytes / (1024 * 1024);
    let upstream_min = 1;
    let upstream_max = resources
        .cores
        .saturating_mul(8)
        .min((memory_mb / 32).max(1) as usize)
        .clamp(upstream_min, 256);
    let upstream_initial = resources
        .cores
        .saturating_mul(2)
        .clamp(upstream_min, upstream_max);
    let upstream_gate = AdaptiveGate::new(upstream_min, upstream_initial, upstream_max);
    spawn_rebalancer(
        vec![CapacityTarget::new(
            upstream_gate.clone(),
            2 * 1024 * 1024,
            Workload::Io,
        )],
        Duration::from_secs(2),
    );
    let episode_cache_bytes =
        (resources.memory_bytes / 64).clamp(16 * 1024 * 1024, 256 * 1024 * 1024);
    let metadata_entries = (memory_mb as usize).saturating_mul(2).clamp(2_000, 100_000) as u64;
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .tcp_nodelay(true)
        .tcp_keepalive(Duration::from_secs(60))
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .pool_max_idle_per_host(20)
        .build()
        .expect("failed to build reqwest client... /ᐠ - ˕ -マ");

    let state = Arc::new(AppState {
        client,
        episode_counts: Cache::builder()
            .time_to_live(Duration::from_secs(10 * 60))
            .max_capacity(metadata_entries)
            .build(),
        jikan_eps: Cache::builder()
            .time_to_live(Duration::from_secs(10 * 60))
            .max_capacity(episode_cache_bytes)
            .weigher(|_key: &i64, value: &Arc<serde_json::Value>| json_weight(value))
            .build(),
        jikan_rel: Cache::builder()
            .time_to_live(Duration::from_secs(30 * 60))
            .max_capacity(metadata_entries / 4)
            .build(),
        anilist_titles: Cache::builder()
            .time_to_live(Duration::from_secs(24 * 60 * 60))
            .max_capacity(metadata_entries / 2)
            .build(),
        identity: Cache::builder()
            .time_to_live(Duration::from_secs(24 * 60 * 60))
            .max_capacity(metadata_entries)
            .build(),
        failures: Cache::builder()
            .time_to_live(Duration::from_secs(15))
            .max_capacity(metadata_entries)
            .build(),
        upstream_gate,
    });

    let app = Router::new()
        .route("/health", get(|| async { "oki" }))
        .route("/api/anime/episodes/:mal_id", get(episodes_handler))
        .route("/api/anime/relations/:mal_id", get(relations_handler))
        .route("/api/anime/alttitles/:anilist_id", get(alttitles_handler))
        .route("/api/anime/episodes", get(identity_episodes_handler))
        .route("/api/anime/identity/resolve", post(identity_handler))
        .route("/api/anime/resolve-stream", post(resolve_stream_handler))
        .route("/api/anime/metrics", get(metrics_handler))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], settings.port));
    tracing::info!("isao listening on {}{}", addr, POSITIVE);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind isao listener... /ᐠ - ˕ -マ");
    axum::serve(listener, app)
        .tcp_nodelay(true)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("shutting down");
        })
        .await
        .expect("isao server failed... /ᐠ - ˕ -マ");
}

#[derive(Default, Deserialize)]
struct EpisodeQuery {
    #[serde(default)]
    count_only: bool,
}

async fn cached_episode_count(state: &AppState, mal_id: i64) -> i32 {
    if let Some(count) = state.episode_counts.get(&mal_id).await {
        return count;
    }
    if let Some(relations) = state.jikan_rel.get(&mal_id).await {
        if let Some(count) = relations
            .iter()
            .find(|relation| relation.mal_id == mal_id && relation.relation == "Self")
            .and_then(|relation| relation.episode_count)
            .filter(|count| *count > 0)
        {
            state.episode_counts.insert(mal_id, count).await;
            return count;
        }
    }
    let failure_key = format!("episode-count:{mal_id}");
    if state.failures.get(&failure_key).await.is_some() {
        return 0;
    }
    let result = state
        .episode_counts
        .try_get_with(mal_id, async {
            let _permit = state
                .upstream_gate
                .acquire_timeout(Duration::from_secs(2))
                .await
                .ok_or(())?;
            let count = tokio::time::timeout(
                Duration::from_secs(5),
                jikan::fetch_episode_count(&state.client, mal_id),
            )
            .await
            .unwrap_or(0);
            if count > 0 {
                return Ok(count);
            }
            if let Some(count) = tokio::time::timeout(
                Duration::from_secs(6),
                anilist::fetch_episode_count(&state.client, mal_id),
            )
            .await
            .ok()
            .flatten()
            {
                return Ok(count);
            }
            let episodes = tokio::time::timeout(
                Duration::from_secs(6),
                jikan::fetch_episodes(&state.client, mal_id),
            )
            .await
            .ok()
            .flatten()
            .ok_or(())?;
            episodes
                .iter()
                .map(|episode| episode.number)
                .max()
                .filter(|count| *count > 0)
                .ok_or(())
        })
        .await;
    match result {
        Ok(count) => count,
        Err(_) => {
            state.failures.insert(failure_key, ()).await;
            0
        }
    }
}

async fn episodes_handler(
    State(state): State<Arc<AppState>>,
    Path(mal_id): Path<i64>,
    Query(query): Query<EpisodeQuery>,
) -> Response {
    if query.count_only {
        let count = if let Some(cached) = state.jikan_eps.get(&mal_id).await {
            cached["count"].as_i64().unwrap_or(0) as i32
        } else {
            cached_episode_count(&state, mal_id).await
        };
        let payload = serde_json::json!({ "count": count, "episodes": [] });
        return if count > 0 {
            Json(payload).into_response()
        } else {
            provider_failure("anime episode provider is temporarily unavailable", payload)
        };
    }
    if let Some(cached) = state.jikan_eps.get(&mal_id).await {
        return Json(&*cached).into_response();
    }
    let failure_key = format!("episodes:{mal_id}");
    if state.failures.get(&failure_key).await.is_some() {
        return provider_failure(
            "anime episode provider is temporarily unavailable",
            serde_json::json!({ "count": 0, "episodes": [] }),
        );
    }
    let client = state.client.clone();
    let gate = state.upstream_gate.clone();
    let response = state
        .jikan_eps
        .try_get_with(mal_id, async move {
            let _permit = gate
                .acquire_timeout(Duration::from_secs(10))
                .await
                .ok_or(())?;
            let (episodes, count) = tokio::join!(
                jikan::fetch_episodes(&client, mal_id),
                jikan::fetch_episode_count(&client, mal_id),
            );
            if count == 0 && episodes.as_ref().is_none_or(|items| items.is_empty()) {
                return Err(());
            }
            let episodes = episodes.unwrap_or_default();
            Ok(Arc::new(serde_json::json!({
                "count": if count > 0 { count } else { episodes.iter().map(|episode| episode.number).max().unwrap_or(0) },
                "episodes": episodes,
            })))
        })
        .await;
    match response {
        Ok(response) => Json(&*response).into_response(),
        Err(_) => {
            state.failures.insert(failure_key, ()).await;
            provider_failure(
                "anime episode provider is temporarily unavailable",
                serde_json::json!({ "count": 0, "episodes": [] }),
            )
        }
    }
}

async fn relations_handler(
    State(state): State<Arc<AppState>>,
    Path(mal_id): Path<i64>,
) -> Response {
    if let Some(cached) = state.jikan_rel.get(&mal_id).await {
        return Json(serde_json::json!({ "relations": *cached })).into_response();
    }

    let failure_key = format!("relations:{mal_id}");
    if state.failures.get(&failure_key).await.is_some() {
        return provider_failure(
            "anime relation provider is temporarily unavailable",
            serde_json::json!({ "relations": [] }),
        );
    }
    let client = state.client.clone();
    let gate = state.upstream_gate.clone();
    match state
        .jikan_rel
        .try_get_with(mal_id, async move {
            let _permit = gate
                .acquire_timeout(Duration::from_secs(2))
                .await
                .ok_or(())?;
            let relations = match tokio::time::timeout(
                Duration::from_secs(5),
                jikan::fetch_relations(&client, mal_id),
            )
            .await
            .ok()
            .flatten()
            {
                Some(relations) => Some(relations),
                None => tokio::time::timeout(
                    Duration::from_secs(6),
                    anilist::fetch_relations(&client, mal_id),
                )
                .await
                .ok()
                .flatten(),
            };
            relations.map(Arc::new).ok_or(())
        })
        .await
    {
        Ok(relations) => Json(serde_json::json!({ "relations": *relations })).into_response(),
        Err(_) => {
            state.failures.insert(failure_key, ()).await;
            provider_failure(
                "anime relation provider is temporarily unavailable",
                serde_json::json!({ "relations": [] }),
            )
        }
    }
}

async fn alttitles_handler(
    State(state): State<Arc<AppState>>,
    Path(anilist_id): Path<i64>,
) -> Response {
    if let Some(cached) = state.anilist_titles.get(&anilist_id).await {
        return Json(serde_json::json!({ "titles": *cached })).into_response();
    }

    let failure_key = format!("titles:{anilist_id}");
    if state.failures.get(&failure_key).await.is_some() {
        return provider_failure(
            "anime title provider is temporarily unavailable",
            serde_json::json!({ "titles": [] }),
        );
    }
    let client = state.client.clone();
    let gate = state.upstream_gate.clone();
    match state
        .anilist_titles
        .try_get_with(anilist_id, async move {
            let _permit = gate
                .acquire_timeout(Duration::from_secs(10))
                .await
                .ok_or(())?;
            let titles = anilist::fetch_alt_titles(&client, anilist_id).await;
            (!titles.is_empty()).then(|| Arc::new(titles)).ok_or(())
        })
        .await
    {
        Ok(titles) => Json(serde_json::json!({ "titles": *titles })).into_response(),
        Err(_) => {
            state.failures.insert(failure_key, ()).await;
            provider_failure(
                "anime title provider is temporarily unavailable",
                serde_json::json!({ "titles": [] }),
            )
        }
    }
}

async fn identity_handler(
    State(state): State<Arc<AppState>>,
    Json(request): Json<identity::IdentityRequest>,
) -> Response {
    let Some(resolved) = resolve_identity(&state, &request).await else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": negative_message("anime identity could not be resolved"),
                "ids": request.normalized_ids(),
            })),
        )
            .into_response();
    };
    Json(&*resolved).into_response()
}

async fn resolve_identity(
    state: &Arc<AppState>,
    request: &identity::IdentityRequest,
) -> Option<Arc<identity::AnimeIdentity>> {
    let key = identity::cache_key(request);
    let failure_key = format!("identity:{key}");
    if state.failures.get(&failure_key).await.is_some() {
        return None;
    }
    if let Some(cached) = state.identity.get(&key).await {
        return Some(cached);
    }
    let client = state.client.clone();
    let request = request.clone();
    let gate = state.upstream_gate.clone();
    let resolved = state
        .identity
        .try_get_with(key, async move {
            let _permit = gate
                .acquire_timeout(Duration::from_secs(15))
                .await
                .ok_or(())?;
            identity::resolve(&client, &request)
                .await
                .map(Arc::new)
                .ok_or(())
        })
        .await
        .ok();
    if resolved.is_none() {
        state.failures.insert(failure_key, ()).await;
    }
    resolved
}

fn provider_failure(message: &str, mut body: serde_json::Value) -> Response {
    if let Some(fields) = body.as_object_mut() {
        fields.insert(
            "error".to_string(),
            serde_json::Value::String(negative_message(message)),
        );
    }
    (StatusCode::BAD_GATEWAY, Json(body)).into_response()
}

async fn metrics_handler(State(state): State<Arc<AppState>>) -> Response {
    let capacity = state.upstream_gate.snapshot();
    Json(serde_json::json!({
        "upstream": {
            "active": capacity.active,
            "limit": capacity.limit,
            "minimum": capacity.minimum,
            "maximum": capacity.maximum,
            "peak": capacity.peak,
            "waits": capacity.waits,
            "rejected": capacity.rejected,
        },
        "cache": {
            "episodes": state.jikan_eps.entry_count(),
            "relations": state.jikan_rel.entry_count(),
            "titles": state.anilist_titles.entry_count(),
            "identity": state.identity.entry_count(),
            "failures": state.failures.entry_count(),
        }
    }))
    .into_response()
}

#[derive(Debug, Deserialize)]
struct IdentityEpisodeQuery {
    anilist_id: Option<i64>,
    mal_id: Option<i64>,
}

async fn identity_episodes_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<IdentityEpisodeQuery>,
) -> Response {
    if let Some(mal_id) = query.mal_id.filter(|id| *id > 0) {
        return episodes_handler(State(state), Path(mal_id), Query(EpisodeQuery::default())).await;
    }
    let Some(anilist_id) = query.anilist_id.filter(|id| *id > 0) else {
        return Json(serde_json::json!({ "count": 0, "episodes": [] })).into_response();
    };
    let request = identity::IdentityRequest {
        anilist_id: Some(serde_json::Value::from(anilist_id)),
        ..identity::IdentityRequest::default()
    };
    let Some(identity) = resolve_identity(&state, &request).await else {
        return Json(serde_json::json!({ "count": 0, "episodes": [] })).into_response();
    };
    let Some(mal_id) = identity
        .ids
        .mal
        .as_deref()
        .and_then(|id| id.parse::<i64>().ok())
        .filter(|id| *id > 0)
    else {
        return Json(serde_json::json!({
            "count": identity.episodes.unwrap_or(0),
            "episodes": []
        }))
        .into_response();
    };
    episodes_handler(State(state), Path(mal_id), Query(EpisodeQuery::default())).await
}

#[derive(Debug, Deserialize)]
struct ResolveStreamRequest {
    #[serde(flatten)]
    identity: identity::IdentityRequest,
    episode: i32,
    language: Option<String>,
}

fn normalized_language(value: Option<&str>) -> Option<&'static str> {
    match value.unwrap_or("sub").trim().to_ascii_lowercase().as_str() {
        "sub" => Some("sub"),
        "dub" => Some("dub"),
        _ => None,
    }
}

async fn resolve_stream_handler(Json(request): Json<ResolveStreamRequest>) -> Response {
    let ids = request.identity.normalized_ids();
    let anilist_id = ids.anilist.as_deref().and_then(|id| id.parse::<i64>().ok());
    let mal_id = ids.mal.as_deref().and_then(|id| id.parse::<i64>().ok());
    let Some(language) = normalized_language(request.language.as_deref()) else {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({
                "error": negative_message("language must be sub or dub")
            })),
        )
            .into_response();
    };
    if (request.episode <= 0 && ids.anikoto_episode.is_none())
        || (anilist_id.unwrap_or(0) <= 0
            && mal_id.unwrap_or(0) <= 0
            && ids.anikoto_episode.is_none())
    {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({
                "error": negative_message("an anime id and episode are required")
            })),
        )
            .into_response();
    }

    let mut query = Vec::with_capacity(5);
    if let Some(id) = anilist_id.filter(|id| *id > 0) {
        query.push(format!("anilist_id={id}"));
    }
    if let Some(id) = mal_id.filter(|id| *id > 0) {
        query.push(format!("mal_id={id}"));
    }
    if let Some(id) = ids.anikoto_episode {
        query.push(format!("anikoto_episode_id={id}"));
    }
    if request.episode > 0 {
        query.push(format!("episode={}", request.episode));
    }
    query.push(format!("language={language}"));
    Json(serde_json::json!({
        "source": "anikoto",
        "status": "ready",
        "mochi_url": format!("/stream/anikoto?{}", query.join("&")),
    }))
    .into_response()
}