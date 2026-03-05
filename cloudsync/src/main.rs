mod auth;
mod db;
mod sync;

use axum::{Router, routing::get};
use std::net::SocketAddr;
use std::sync::Arc;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use tower_governor::{governor::GovernorConfigBuilder, key_extractor::SmartIpKeyExtractor, GovernorLayer};
use tower_http::{cors::CorsLayer, set_header::SetResponseHeaderLayer};
use axum::http::{HeaderValue, header::{X_CONTENT_TYPE_OPTIONS, X_FRAME_OPTIONS, X_XSS_PROTECTION, REFERRER_POLICY}};
use axum::extract::DefaultBodyLimit;
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
        pool: pool.clone(),
    });

    let vacuum_pool = pool.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(86400));
        
        interval.tick().await; 
        
        loop {
            interval.tick().await;
            tracing::info!("running db vacuum...");
            
            let pool_clone = vacuum_pool.clone();
            let _ = tokio::task::spawn_blocking(move || {
                if let Ok(conn) = pool_clone.get() {
                    match conn.execute("VACUUM", []) {
                        Ok(_) => tracing::info!("db vacuum successful"),
                        Err(e) => tracing::error!("failed to vacuum db: {}", e),
                    }
                } else {
                    tracing::error!("vacuum task failed to get a db connection");
                }
            }).await;
        }
    });

    let strict_conf = Box::new(
        GovernorConfigBuilder::default()
            .per_second(1)
            .burst_size(3)
            .key_extractor(SmartIpKeyExtractor)
            .finish()
            .unwrap(),
    );

    let loose_conf_auth = Box::new(
        GovernorConfigBuilder::default()
            .per_second(80)
            .burst_size(300)
            .key_extractor(SmartIpKeyExtractor)
            .finish()
            .unwrap(),
    );

    let loose_conf_sync = Box::new(
        GovernorConfigBuilder::default()
            .per_second(120)
            .burst_size(500)
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
        .route("/", get(|| async { "cloudsync active" }))
        .layer(tower_cookies::CookieManagerLayer::new())
        .layer({
            use tower_http::cors::AllowOrigin;

            CorsLayer::new()
                .allow_origin(AllowOrigin::predicate(|origin: &HeaderValue, _| {
                    origin.to_str()
                        .map(|s| s.starts_with("https://") || s.starts_with("http://localhost") || s.starts_with("http://127.0.0.1"))
                        .unwrap_or(false)
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
                .allow_credentials(true)
        })
        .layer(SetResponseHeaderLayer::overriding(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::overriding(X_FRAME_OPTIONS, HeaderValue::from_static("DENY")))
        .layer(SetResponseHeaderLayer::overriding(X_XSS_PROTECTION, HeaderValue::from_static("1; mode=block")))
        .layer(SetResponseHeaderLayer::overriding(REFERRER_POLICY, HeaderValue::from_static("strict-origin-when-cross-origin")))
        .layer(DefaultBodyLimit::max(50 * 1024 * 1024));

    let addr = SocketAddr::from(([127, 0, 0, 1], 5000));
    tracing::info!("listening on {}!!", addr);
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
}