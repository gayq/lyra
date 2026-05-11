mod auth;
mod db;
mod sync;
mod tuning;

use aes_gcm::{aead::KeyInit, Aes256Gcm};
use sha2::{Digest, Sha256};
use axum::extract::DefaultBodyLimit;
use axum::http::{header::{REFERRER_POLICY, X_CONTENT_TYPE_OPTIONS, X_FRAME_OPTIONS, X_XSS_PROTECTION}, HeaderValue};
use axum::Router;
use mimalloc::MiMalloc;
use std::net::SocketAddr;
use std::sync::Arc;
use tower_governor::{governor::GovernorConfigBuilder, key_extractor::SmartIpKeyExtractor, GovernorLayer};
use tower_http::{cors::CorsLayer, set_header::SetResponseHeaderLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

pub static WRITE_SEMAPHORE: std::sync::OnceLock<tokio::sync::Semaphore> =
    std::sync::OnceLock::new();

#[tokio::main]
async fn main() {
    dotenv::dotenv().ok();
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "cloudsync=debug,tower_http=debug".into()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let t = tuning::detect();
    tracing::info!(
        "tuning: pool_max={}, pool_min_idle={}, write_sem={}, cache_kb={}, mmap_mb={}, body_limit={}MB",
        t.db_pool_max,
        t.db_pool_min_idle,
        t.write_semaphore_permits,
        t.db_cache_size_kb,
        t.db_mmap_size / (1024 * 1024),
        t.body_limit_mb
    );

    let pool = match db::init_pool(t.db_pool_max, t.db_pool_min_idle, t.db_cache_size_kb, t.db_mmap_size) {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("failed to initialize database pool: {}", e);
            std::process::exit(1);
        }
    };

    let jwt_secret = std::env::var("JWT_SECRET").expect("JWT_SECRET must be set");
    let sync_secret = std::env::var("SYNC_SECRET").expect("SYNC_SECRET must be set");
    let mut hasher = Sha256::new();
    hasher.update(sync_secret.as_bytes());
    let key_bytes = hasher.finalize();
    let aes_key = aes_gcm::Key::<Aes256Gcm>::from_slice(&key_bytes);
    let aes_cipher = std::sync::Arc::new(Aes256Gcm::new(aes_key));

    let state = Arc::new(auth::AppState {
        jwt_secret,
        pool: pool.clone(),
        aes_cipher,
    });

    WRITE_SEMAPHORE.get_or_init(|| tokio::sync::Semaphore::new(t.write_semaphore_permits));

    let checkpoint_pool = pool.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(300)).await;
            if let Ok(conn) = checkpoint_pool.get() {
                let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
                tracing::debug!("wal checkpoint completed");
            }
        }
    });

    let strict_conf = Box::new(
        GovernorConfigBuilder::default()
            .per_second(2)
            .burst_size(5)
            .key_extractor(SmartIpKeyExtractor)
            .finish()
            .unwrap(),
    );
    let loose_conf_auth = Box::new(
        GovernorConfigBuilder::default()
            .per_second(200)
            .burst_size(1000)
            .key_extractor(SmartIpKeyExtractor)
            .finish()
            .unwrap(),
    );
    let loose_conf_sync = Box::new(
        GovernorConfigBuilder::default()
            .per_second(500)
            .burst_size(2000)
            .key_extractor(SmartIpKeyExtractor)
            .finish()
            .unwrap(),
    );

    let auth_routes_strict = Router::new()
        .route("/register", axum::routing::post(auth::register))
        .route("/login", axum::routing::post(auth::login))
        .route("/me", axum::routing::delete(auth::delete_account))
        .layer(GovernorLayer { config: strict_conf.into() });

    let auth_routes_loose = Router::new()
        .route("/logout", axum::routing::post(auth::logout))
        .route("/me", axum::routing::get(auth::me))
        .layer(GovernorLayer { config: loose_conf_auth.into() });

    let sync_routes = Router::new()
        .route("/upload", axum::routing::post(sync::upload))
        .route("/download", axum::routing::get(sync::download))
        .route("/meta", axum::routing::get(sync::meta))
        .layer(GovernorLayer { config: loose_conf_sync.into() });

    let api_routes = Router::new()
        .nest("/auth", auth_routes_strict.merge(auth_routes_loose))
        .nest("/sync", sync_routes)
        .with_state(state)
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::CACHE_CONTROL,
            HeaderValue::from_static("no-store, no-cache, must-revalidate, proxy-revalidate"),
        ));

    let app = Router::new()
        .nest("/api", api_routes)
        .route("/", axum::routing::get(|| async { "cloudsync active" }))
        .route("/health", axum::routing::get({
            let health_pool = pool.clone();
            move || {
                let pool_ok = health_pool.get().is_ok();
                async move {
                    if pool_ok {
                        format!("ok\npool: state={:?}", health_pool.state())
                    } else {
                        "degraded".to_string()
                    }
                }
            }
        }))
        .layer(tower_cookies::CookieManagerLayer::new())
        .layer(CorsLayer::new()
            .allow_origin(tower_http::cors::AllowOrigin::predicate(|origin: &HeaderValue, _| {
                origin.to_str().map(|s| {
                    s.starts_with("https://")
                        || s.starts_with("http://localhost")
                        || s.starts_with("http://127.0.0.1")
                }).unwrap_or(false)
            }))
            .allow_methods([
                axum::http::Method::GET,
                axum::http::Method::POST,
                axum::http::Method::PUT,
                axum::http::Method::DELETE,
                axum::http::Method::OPTIONS,
            ])
            .allow_headers([
                axum::http::header::AUTHORIZATION,
                axum::http::header::CONTENT_TYPE,
                axum::http::header::ACCEPT,
                axum::http::header::COOKIE,
            ])
            .allow_credentials(true))
        .layer(SetResponseHeaderLayer::overriding(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::overriding(X_FRAME_OPTIONS, HeaderValue::from_static("DENY")))
        .layer(SetResponseHeaderLayer::overriding(X_XSS_PROTECTION, HeaderValue::from_static("1; mode=block")))
        .layer(SetResponseHeaderLayer::overriding(REFERRER_POLICY, HeaderValue::from_static("strict-origin-when-cross-origin")))
        .layer(DefaultBodyLimit::max(t.body_limit_mb * 1024 * 1024));

    let addr = SocketAddr::from(([127, 0, 0, 1], 5000));
    tracing::info!("listening on {}!!", addr);
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("shutting down...");
        })
        .await.unwrap();
}