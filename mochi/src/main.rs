mod constants;

use aho_corasick::AhoCorasick;
use axum::{
    body::Body,
    extract::{State, ws::{WebSocketUpgrade, WebSocket, Message}},
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use bytes::Bytes;
use constants::{MOCHI_PREFIX, SCRIPT_PART_1, SCRIPT_PART_2};
use futures::{sink::SinkExt, stream::StreamExt};
use lol_html::{element, html_content::ContentType, HtmlRewriter, Settings};
use mimalloc::MiMalloc;
use moka::future::Cache;
use reqwest::{redirect::Policy, Client};
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message as TungsteniteMessage};
use tower_http::cors::{Any, CorsLayer};
use url::Url;

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

#[derive(Clone)]
struct AppState {
    html_client: Client,
    asset_client: Client,
    cache: Cache<String, Arc<CachedResponse>>,
    blocklist_matcher: Arc<AhoCorasick>, 
}

#[derive(Clone)]
struct CachedResponse {
    status: u16,
    headers: HeaderMap,
    body: Bytes,
}

const MAX_CACHE_SIZE_BYTES: usize = 150 * 1024 * 1024;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter("mochi=info")
        .init();

    let cache = Cache::builder()
        .max_capacity(2 * 1024 * 1024 * 1024) 
        .time_to_live(Duration::from_secs(20 * 60))
        .build();

    let asset_client = Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        .danger_accept_invalid_certs(true)
        .redirect(Policy::default())
        .pool_idle_timeout(Duration::from_secs(120)) 
        .pool_max_idle_per_host(2000)
        .tcp_nodelay(true)
        .tcp_keepalive(Duration::from_secs(60))
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .build()
        .expect("failed to build asset client");

    let html_client = Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        .danger_accept_invalid_certs(true)
        .redirect(Policy::default())
        .pool_idle_timeout(Duration::from_secs(120)) 
        .pool_max_idle_per_host(500)
        .tcp_nodelay(true)
        .brotli(true)
        .build()
        .expect("failed to build html client");

    let patterns = vec![
        "google-analytics.com",
        "googletagmanager.com",
        "doubleclick.net",
        "adsbygoogle",
    ];
    
    let blocklist_matcher = Arc::new(AhoCorasick::new(&patterns).unwrap());

    let state = Arc::new(AppState {
        html_client,
        asset_client,
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
    println!("mochi listening on {}!!!!", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn proxy_handler(
    State(state): State<Arc<AppState>>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    ws: Option<WebSocketUpgrade>,
    req_body: Bytes,
) -> Response {
    let path_and_query = uri.path_and_query().map(|p| p.as_str()).unwrap_or("");
    let prefix_pos = path_and_query.find(MOCHI_PREFIX).unwrap_or(0);
    let target_url_str = &path_and_query[prefix_pos + MOCHI_PREFIX.len()..];

    if let Some(ws) = ws {
        if target_url_str.starts_with("ws/") || headers.contains_key("upgrade") {
             let real_target = if target_url_str.starts_with("ws/") {
                 target_url_str.replace("ws/", "https://").replace("http://", "ws://").replace("https://", "wss://")
             } else {
                 if target_url_str.starts_with("http") {
                     target_url_str.replace("http", "ws")
                 } else {
                     format!("wss://{}", target_url_str)
                 }
             };
             return ws.on_upgrade(move |socket| handle_socket(socket, real_target));
        }
    }

    if method == Method::GET {
        if let Some(cached) = state.cache.get(target_url_str).await {
            let mut res_headers = cached.headers.clone();
            res_headers.insert("X-Cache", HeaderValue::from_static("HIT"));
            let status = StatusCode::from_u16(cached.status).unwrap_or(StatusCode::OK);
            return (status, res_headers, cached.body.clone()).into_response();
        }
    }

    let target_url_string = if !target_url_str.starts_with("http") {
        format!("https://{}", target_url_str)
    } else {
        target_url_str.to_string()
    };

    if state.blocklist_matcher.is_match(&target_url_string) {
        return (StatusCode::OK, "/* blocked */").into_response();
    }

    let target_url = match Url::parse(&target_url_string) {
        Ok(u) => u,
        Err(_) => return (StatusCode::BAD_REQUEST, "invalid url").into_response(),
    };

    let is_likely_asset = is_likely_static_asset(&target_url_string);
    
    let client = if is_likely_asset {
        &state.asset_client
    } else {
        &state.html_client
    };

    let mut req_builder = client.request(method.clone(), target_url.clone());

    for (k, v) in headers.iter() {
        let key_str = k.as_str().to_lowercase();
        if !is_blacklisted_header(&key_str) && !key_str.starts_with("cf-") && !key_str.starts_with("x-") {
            if !is_likely_asset && key_str == "accept-encoding" {
                continue; 
            }
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
            return (StatusCode::BAD_GATEWAY, format!("upstream error: {}", e)).into_response();
        },
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
    
    if is_likely_asset {
        if let Some(enc) = res_headers_ref.get("content-encoding") {
            safe_headers.insert("content-encoding", enc.clone());
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

    let is_html = content_type.contains("text/html") 
        && !target_url_str.ends_with(".swf") 
        && !target_url_str.ends_with(".wasm");
    
    if is_html && status.is_success() && !is_likely_asset {
        safe_headers.remove("content-length");
        safe_headers.remove("content-encoding"); 
        
        let (tx_in, mut rx_in) = mpsc::channel::<Bytes>(4096);
        let (tx_out, rx_out) = mpsc::channel::<Result<Bytes, axum::Error>>(4096);

        let mut stream = upstream_res.bytes_stream();
        tokio::spawn(async move {
            while let Some(chunk_result) = stream.next().await {
                if let Ok(chunk) = chunk_result {
                    if tx_in.send(chunk).await.is_err() { break; }
                } else { break; }
            }
        });

        let target_url_clone = target_url.clone();
        
        tokio::task::spawn_blocking(move || {
            let base_url = target_url_clone;
            let base_url_str = base_url.to_string();
            
            let mut rewriter = HtmlRewriter::new(
                Settings {
                    element_content_handlers: vec![
                        element!("head", |el| {
                            let full_script = format!("{}{}{}", SCRIPT_PART_1, base_url_str, SCRIPT_PART_2);
                            let _ = el.prepend(&full_script, ContentType::Html);
                            Ok(())
                        }),
                    ],
                    ..Settings::default()
                },
                |c: &[u8]| {
                    if !c.is_empty() {
                        let _ = tx_out.blocking_send(Ok(Bytes::copy_from_slice(c)));
                    }
                },
            );

            while let Some(chunk) = rx_in.blocking_recv() {
                if rewriter.write(&chunk).is_err() { break; }
            }
            let _ = rewriter.end();
        });

        return (status, safe_headers, Body::from_stream(ReceiverStream::new(rx_out))).into_response();
    }

    let is_image = content_type.starts_with("image/");
    let is_json = content_type.contains("json");
    let is_favicon_heuristic = target_url_str.contains("favicons?");
    
    let should_cache = (is_likely_asset || is_image || is_json || is_favicon_heuristic) 
        && status.is_success();

    if should_cache {
        match upstream_res.bytes().await {
            Ok(body_bytes) => {
                if body_bytes.len() < MAX_CACHE_SIZE_BYTES {
                    state.cache.insert(target_url_str.to_string(), Arc::new(CachedResponse {
                        status: status.as_u16(),
                        headers: safe_headers.clone(),
                        body: body_bytes.clone(),
                    })).await;
                    
                    return (status, safe_headers, body_bytes).into_response();
                } else {
                    return (status, safe_headers, body_bytes).into_response();
                }
            },
            Err(_) => {
                return (StatusCode::BAD_GATEWAY, "asset stream failed").into_response();
            }
        };
    }

    let stream = Body::from_stream(upstream_res.bytes_stream());
    return (status, safe_headers, stream).into_response();
}

async fn handle_socket(client_socket: WebSocket, target_url: String) {
    let (mut client_sender, mut client_receiver) = client_socket.split();

    let (ws_stream, _) = match connect_async(&target_url).await {
        Ok(s) => s,
        Err(e) => {
            println!("ws connect error to {}: {}", target_url, e);
            return;
        }
    };
    
    let (mut upstream_sender, mut upstream_receiver) = ws_stream.split();

    let client_to_upstream = tokio::spawn(async move {
        while let Some(msg) = client_receiver.next().await {
            if let Ok(msg) = msg {
                let tungstenite_msg = match msg {
                    Message::Text(t) => TungsteniteMessage::Text(t),
                    Message::Binary(b) => TungsteniteMessage::Binary(b.into()),
                    Message::Ping(b) => TungsteniteMessage::Ping(b.into()),
                    Message::Pong(b) => TungsteniteMessage::Pong(b.into()),
                    Message::Close(_) => TungsteniteMessage::Close(None), 
                };
                
                if upstream_sender.send(tungstenite_msg).await.is_err() {
                    break;
                }
            } else {
                break;
            }
        }
    });

    let upstream_to_client = tokio::spawn(async move {
        while let Some(msg) = upstream_receiver.next().await {
            if let Ok(msg) = msg {
                 let axum_msg = match msg {
                    TungsteniteMessage::Text(t) => Message::Text(t),
                    TungsteniteMessage::Binary(b) => Message::Binary(b.into()),
                    TungsteniteMessage::Ping(b) => Message::Ping(b.into()),
                    TungsteniteMessage::Pong(b) => Message::Pong(b.into()),
                    TungsteniteMessage::Close(_) => Message::Close(None),
                    TungsteniteMessage::Frame(_) => continue,
                };

                if client_sender.send(axum_msg).await.is_err() {
                    break;
                }
            } else {
                break;
            }
        }
    });

    let _ = tokio::join!(client_to_upstream, upstream_to_client);
}

fn fix_game_content_type(url: &str, headers: &mut HeaderMap) {
    let path = Path::new(url);
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        let mime = match ext {
            "wasm" => "application/wasm",
            "data" | "symbols" | "mem" | "unityweb" | "pck" | "bin" | "fbx" => "application/octet-stream",
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

fn is_likely_static_asset(url: &str) -> bool {
    let exts = [
        ".wasm", ".pck", ".unityweb", ".data", ".mem", ".symbols", ".js", ".json", ".xml",
        ".glb", ".gltf", ".bin", ".fbx", ".obj",
        ".swf", ".p8", ".c3p",
        ".atlas", ".fnt", ".png", ".jpg", ".jpeg", ".mp3", ".ogg", ".wav", ".css", ".svg"
    ];
    
    if url.contains("favicons?") {
        return true;
    }

    exts.iter().any(|ext| url.ends_with(ext))
}

fn is_blacklisted_header(name: &str) -> bool {
    matches!(name, "host" | "connection" | "content-length" | "transfer-encoding" | "upgrade" | "sec-websocket-key" | "sec-websocket-version" | "sec-websocket-extensions")
}

fn is_blacklisted_res_header(name: &str) -> bool {
    matches!(name, "connection" | "content-length" | "transfer-encoding" | "content-security-policy" | "strict-transport-security" | "access-control-allow-origin")
}