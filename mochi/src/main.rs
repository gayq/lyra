mod constants;

use aho_corasick::AhoCorasick;
use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use bytes::Bytes;
use constants::{MOCHI_PREFIX, SCRIPT_PART_1, SCRIPT_PART_2};
use futures::StreamExt;
use lol_html::{element, html_content::ContentType, HtmlRewriter, Settings};
use mimalloc::MiMalloc;
use moka::future::Cache;
use reqwest::{redirect::Policy, Client};
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tower_http::cors::{Any, CorsLayer};
use url::Url;

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

#[derive(Clone)]
struct AppState {
    client: Client,
    cache: Cache<String, Arc<CachedResponse>>,
    blocklist_matcher: Arc<AhoCorasick>,
}

#[derive(Clone)]
struct CachedResponse {
    status: u16,
    headers: HeaderMap,
    body: Bytes,
}

const MAX_CACHE_SIZE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter("mochi=info")
        .init();

    let cache = Cache::builder()
        .max_capacity(MAX_CACHE_SIZE_BYTES)
        .weigher(|_k, v: &Arc<CachedResponse>| (v.body.len() as u32) + 1024)
        .time_to_live(Duration::from_secs(20 * 60))
        .build();

    let client = Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        .danger_accept_invalid_certs(true)
        .redirect(Policy::default())
        .pool_idle_timeout(None)
        .pool_max_idle_per_host(128)
        .tcp_nodelay(true)
        .build()
        .expect("failed to build http client");

    let patterns = vec![
        "google-analytics.com",
        "googletagmanager.com",
        "googleAnalytics.js",
        "ima3.js",
        "doubleclick.net",
        "pagead2",
        "adsbygoogle",
        "cpmstar.com",
    ];

    let blocklist_matcher = Arc::new(AhoCorasick::new(&patterns).unwrap());

    let state = Arc::new(AppState {
        client,
        cache,
        blocklist_matcher,
    });

    let app = Router::new()
        .route("/!!/*path", any(proxy_handler))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], 4000));
    println!("mochi listening on http://{}!!!!", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn proxy_handler(
    State(state): State<Arc<AppState>>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    req_body: Bytes,
) -> Response {
    let path_and_query = uri.path_and_query().map(|p| p.as_str()).unwrap_or("");
    let prefix_pos = path_and_query.find(MOCHI_PREFIX).unwrap_or(0);
    let target_url_str = &path_and_query[prefix_pos + MOCHI_PREFIX.len()..];

    if method == Method::GET {
        if let Some(cached) = state.cache.get(target_url_str).await {
            let mut res_headers = cached.headers.clone();
            res_headers.insert("X-Cache", HeaderValue::from_static("HIT"));
            let status = StatusCode::from_u16(cached.status).unwrap_or(StatusCode::OK);
            return (status, res_headers, cached.body.clone()).into_response();
        }
    }

    if target_url_str.starts_with("ws/") {
        return (
            StatusCode::BAD_REQUEST,
            "webSocket connections must use the webSocket endpoint",
        )
            .into_response();
    }

    let target_url_string = if !target_url_str.starts_with("http") {
        format!("https://{}", target_url_str)
    } else {
        target_url_str.to_string()
    };

    if state.blocklist_matcher.is_match(&target_url_string) {
        return (StatusCode::OK, "/* no */").into_response();
    }

    let target_url = match Url::parse(&target_url_string) {
        Ok(u) => u,
        Err(_) => return (StatusCode::BAD_REQUEST, "invalid url").into_response(),
    };

    let mut req_builder = state.client.request(method.clone(), target_url.clone());

    for (k, v) in headers.iter() {
        let key_str = k.as_str().to_lowercase();
        if !is_blacklisted_header(&key_str)
            && !key_str.starts_with("cf-")
            && !key_str.starts_with("x-")
        {
            req_builder = req_builder.header(k, v);
        }
    }

    let origin = target_url.origin().ascii_serialization();
    req_builder = req_builder.header("Referer", format!("{}/", origin));
    req_builder = req_builder.header("Origin", origin);

    if !req_body.is_empty() {
        req_builder = req_builder.body(req_body);
    }

    let upstream_res = match req_builder.send().await {
        Ok(res) => res,
        Err(e) => {
            println!("connection failed to {}: {}", target_url_string, e);
            return (StatusCode::BAD_GATEWAY, "upstream error").into_response();
        }
    };

    let status = upstream_res.status();
    let res_headers_ref = upstream_res.headers();

    let mut safe_headers = HeaderMap::new();
    safe_headers.reserve(res_headers_ref.len());

    for (k, v) in res_headers_ref.iter() {
        let key_str = k.as_str().to_lowercase();
        if !is_blacklisted_res_header(&key_str) {
            if key_str == "set-cookie" {
                let cookie_str = v.to_str().unwrap_or("");
                let safe_cookie = cookie_str
                    .replace("Domain=", "NoDomain=")
                    .replace("Secure", "")
                    .replace("SameSite=Strict", "SameSite=Lax");
                safe_headers.append(k, HeaderValue::from_str(&safe_cookie).unwrap_or(v.clone()));
            } else {
                safe_headers.insert(k, v.clone());
            }
        }
    }

    fix_game_content_type(&target_url_string, &mut safe_headers);

    safe_headers.insert("Access-Control-Allow-Origin", HeaderValue::from_static("*"));
    safe_headers.insert("X-Cache", HeaderValue::from_static("MISS"));

    let content_type = safe_headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    let content_len = safe_headers
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0);

    let is_html = content_type.contains("text/html")
        && !target_url_str.ends_with(".swf")
        && !target_url_str.ends_with(".wasm");

    if is_html && status.is_success() {
        safe_headers.remove("content-length");

        let (tx_in, mut rx_in) = mpsc::channel::<Bytes>(128);
        let (tx_out, rx_out) = mpsc::channel::<Result<Bytes, axum::Error>>(128);
        let target_url_clone = target_url.clone();
        let mut stream = upstream_res.bytes_stream();
        tokio::spawn(async move {
            while let Some(chunk_result) = stream.next().await {
                match chunk_result {
                    Ok(chunk) => {
                        if tx_in.send(chunk).await.is_err() {
                            break;
                        }
                    },
                    Err(_) => break,
                }
            }
        });

        thread::spawn(move || {
            let base_url = target_url_clone;
            let base_url_str = base_url.to_string();
            
            let settings = Settings {
                element_content_handlers: vec![
                    element!("head", |el| {
                        let full_script = format!("{}{}{}", SCRIPT_PART_1, base_url_str, SCRIPT_PART_2);
                        let _ = el.prepend(&full_script, ContentType::Html);
                        Ok(())
                    }),
                    element!("*[src], *[href], form[action]", |el| {
                        if let Some(src) = el.get_attribute("src") {
                            let _ = el.set_attribute(
                                "src",
                                &rewrite_url_optimized(&src, MOCHI_PREFIX, &base_url),
                            );
                        }
                        if let Some(href) = el.get_attribute("href") {
                            let _ = el.set_attribute("data-mochi-orig-href", &href);
                            let _ = el.set_attribute(
                                "href",
                                &rewrite_url_optimized(&href, MOCHI_PREFIX, &base_url),
                            );
                        }
                        if let Some(action) = el.get_attribute("action") {
                            let _ = el.set_attribute(
                                "action",
                                &rewrite_url_optimized(&action, MOCHI_PREFIX, &base_url),
                            );
                        }
                        Ok(())
                    }),
                    element!(
                        "script[src*='google-analytics.com'], script[src*='googletagmanager.com']",
                        |el| {
                            el.remove();
                            Ok(())
                        }
                    ),
                ],
                ..Settings::default()
            };

            let tx_out_clone = tx_out.clone();
            let mut rewriter = HtmlRewriter::new(settings, move |c: &[u8]| {
                let _ = tx_out_clone.blocking_send(Ok(Bytes::copy_from_slice(c)));
            });

            while let Some(chunk) = rx_in.blocking_recv() {
                if rewriter.write(&chunk).is_err() {
                    break;
                }
            }
            let _ = rewriter.end();
        });

        return (
            status,
            safe_headers,
            Body::from_stream(ReceiverStream::new(rx_out)),
        ).into_response();
    }

    let is_game_file = is_game_asset(&target_url_string);
    let should_cache =
        is_game_file && status.is_success() && content_len > 0 && content_len < (100 * 1024 * 1024);

    if should_cache {
        let body_bytes = match upstream_res.bytes().await {
            Ok(b) => b,
            Err(_) => return (StatusCode::BAD_GATEWAY, "asset stream failed").into_response(),
        };

        state
            .cache
            .insert(
                target_url_string,
                Arc::new(CachedResponse {
                    status: status.as_u16(),
                    headers: safe_headers.clone(),
                    body: body_bytes.clone(),
                }),
            )
            .await;

        return (status, safe_headers, body_bytes).into_response();
    }

    let stream = Body::from_stream(upstream_res.bytes_stream());
    return (status, safe_headers, stream).into_response();
}

fn rewrite_url_optimized(url: &str, prefix: &str, base: &Url) -> String {
    if url.starts_with("data:") || url.starts_with("blob:") || url.starts_with("#") {
        return url.to_string();
    }
    match base.join(url) {
        Ok(resolved) => format!("{}{}", prefix, resolved.as_str()),
        Err(_) => url.to_string(),
    }
}

fn fix_game_content_type(url: &str, headers: &mut HeaderMap) {
    let path = Path::new(url);
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        let mime = match ext {
            "wasm" => "application/wasm",
            "data" | "symbols" | "mem" | "unityweb" | "pck" | "bin" | "fbx" => {
                "application/octet-stream"
            }
            "glb" => "model/gltf-binary",
            "gltf" => "model/gltf+json",
            "obj" => "text/plain",
            "swf" => "application/x-shockwave-flash",
            "js" | "mjs" => "application/javascript",
            "json" => "application/json",
            "css" => "text/css",
            "html" => "text/html",
            "xml" => "application/xml",
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "svg" => "image/svg+xml",
            _ => return,
        };
        headers.insert("Content-Type", HeaderValue::from_static(mime));
    }
}

fn is_game_asset(url: &str) -> bool {
    let exts = [
        ".wasm", ".pck", ".unityweb", ".data", ".mem", ".symbols", ".js", ".json", ".xml",
        ".glb", ".gltf", ".bin", ".fbx", ".obj", ".swf", ".p8", ".c3p", ".atlas", ".fnt",
        ".png", ".jpg", ".mp3", ".ogg", ".wav",
    ];

    exts.iter().any(|ext| url.ends_with(ext))
}

fn is_blacklisted_header(name: &str) -> bool {
    matches!(
        name,
        "host"
            | "connection"
            | "content-length"
            | "transfer-encoding"
            | "accept-encoding"
            | "upgrade"
            | "sec-websocket-key"
    )
}

fn is_blacklisted_res_header(name: &str) -> bool {
    matches!(
        name,
        "connection"
            | "content-length"
            | "content-encoding"
            | "transfer-encoding"
            | "content-security-policy"
            | "strict-transport-security"
    )
}
