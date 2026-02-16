mod auth;
mod db;
mod sync;

use axum::{Router, routing::get};
use std::net::SocketAddr;
use std::sync::Arc;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use tower_governor::{governor::GovernorConfigBuilder, key_extractor::PeerIpKeyExtractor, GovernorLayer};
use tower_http::{cors::CorsLayer, set_header::SetResponseHeaderLayer};
use axum::http::{HeaderValue, header::{X_CONTENT_TYPE_OPTIONS, X_FRAME_OPTIONS, X_XSS_PROTECTION, REFERRER_POLICY}};
use mimalloc::MiMalloc;

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

#[tokio::main]
async fn main() {
    dotenv::dotenv().ok();
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "cloudsync=debug,tower_http=debug".into()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let pool = match db::init_pool() {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("failed to initialize database pool: {}", e);
            std::process::exit(1);
        }
    };
    let jwt_secret = std::env::var("JWT_SECRET").expect("JWT_SECRET must be set");
    let sync_secret = std::env::var("SYNC_SECRET").expect("SYNC_SECRET must be set");
    let state = Arc::new(auth::AppState {
        jwt_secret,
        sync_secret,
        pool,
    });
    let governor_conf = Box::new(
        GovernorConfigBuilder::default()
            .per_second(5)
            .burst_size(30)
            .key_extractor(PeerIpKeyExtractor)
            .finish()
            .unwrap(),
    );
    let app = Router::new()
        .nest("/api/auth", auth::routes(state.clone()))
        .nest("/api/sync", sync::routes(state.clone()))
        .route("/", get(|| async { "CloudSync Service Active" }))
        .layer(tower_cookies::CookieManagerLayer::new())
        .layer(
            CorsLayer::new()
                .allow_origin([
                    "http://localhost:3000".parse().unwrap(),
                    "http://127.0.0.1:3000".parse().unwrap(),
                    "http://localhost:5000".parse().unwrap(),
                    "http://127.0.0.1:5000".parse().unwrap(),
                ])
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
                .allow_credentials(true),
        )
        .layer(SetResponseHeaderLayer::overriding(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::overriding(X_FRAME_OPTIONS, HeaderValue::from_static("DENY")))
        .layer(SetResponseHeaderLayer::overriding(X_XSS_PROTECTION, HeaderValue::from_static("1; mode=block")))
        .layer(SetResponseHeaderLayer::overriding(REFERRER_POLICY, HeaderValue::from_static("strict-origin-when-cross-origin")))
        .layer(GovernorLayer { config: governor_conf.into() });

    let addr = SocketAddr::from(([127, 0, 0, 1], 5000));
    tracing::info!("listening on {}!!", addr);
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
}
