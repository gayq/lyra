mod constants;

use aho_corasick::AhoCorasick;
use axum::{
    body::Body,
    extract::{State, ws::{WebSocketUpgrade, WebSocket, Message}},
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use tower_http::compression::CompressionLayer;
use bytes::Bytes;
use constants::{MOCHI_PREFIX, SCRIPT_PART_1, SCRIPT_PART_2};
use dashmap::DashMap;
use futures::{sink::SinkExt, stream::StreamExt};
use lol_html::{element, html_content::ContentType, HtmlRewriter, Settings};
use mimalloc::MiMalloc;
use moka::future::Cache;
use reqwest::{redirect::Policy, Client};
use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime};
use tokio::sync::{broadcast, mpsc, Semaphore};
use tokio_stream::wrappers::ReceiverStream;
use tokio_tungstenite::{connect_async, tungstenite::{handshake::client::generate_key, protocol::Message as TungsteniteMessage}};
use tower_http::cors::{Any, CorsLayer};
use tracing::{debug, error, warn};
use url::Url;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use tokio::fs::{self, File};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::io::ReaderStream;

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

#[derive(Clone)]
struct CachedResponse {
    status: u16,
    headers: HeaderMap,
    body: Bytes,
}

struct AppState {
    html_client: Client,
    asset_client: Client,
    cache: Cache<String, Arc<CachedResponse>>,
    blocklist_matcher: Arc<AhoCorasick>,
    caching_inflight: DashMap<String, ()>,
    coalesce: DashMap<String, broadcast::Sender<Arc<CachedResponse>>>,
    request_permit: Arc<Semaphore>,
    html_rewrite_permit: Arc<Semaphore>,
}

const MAX_CACHE_SIZE_BYTES: usize = 512 * 1024 * 1024;
const RAM_CACHE_LIMIT: usize = 512 * 1024 * 1024;
const CDN_DOMAINS: &[&str] = &[
    "site-assets.fontawesome.com",
    "ka-f.fontawesome.com",
    "kit.fontawesome.com",
    "fonts.googleapis.com",
    "fonts.gstatic.com",
    "cdn.cloudflare.com",
    "ajax.googleapis.com",
    "cdn.jsdelivr.net",
    "raw.githubusercontent.com",
    "gn-math.dev",
];

async fn disk_cache_cleanup_task(max_dir_size_bytes: u64, max_age_secs: u64) {
    let cache_dir = "./cache";
    
    loop {
        tokio::time::sleep(Duration::from_secs(7200)).await;

        let mut entries = match fs::read_dir(cache_dir).await {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!("failed to read cache for cleanup: {}", e);
                continue;
            }
        };

        let mut files = Vec::new();
        let mut total_size = 0u64;

        while let Ok(Some(entry)) = entries.next_entry().await {
            if let Ok(metadata) = entry.metadata().await {
                if metadata.is_file() {
                    let size = metadata.len();
                    let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                    files.push((entry.path(), size, modified));
                    total_size += size;
                }
            }
        }

        files.sort_by_key(|&(_, _, modified)| modified);

        let now = SystemTime::now();

        for (path, size, modified) in files {
            let age_secs = now.duration_since(modified).unwrap_or(Duration::from_secs(0)).as_secs();

            if age_secs > max_age_secs || total_size > max_dir_size_bytes {
                if fs::remove_file(&path).await.is_ok() {
                    total_size = total_size.saturating_sub(size);
                    tracing::debug!("deleted old cache: {:?}", path);
                }
            } else if total_size <= max_dir_size_bytes {
                break;
            }
        }
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter("mochi=info")
        .init();

    let _ = fs::create_dir_all("./cache").await;
    let cache = Cache::builder()
        .max_capacity(16u64 * 1024 * 1024 * 1024)
        .weigher(|_key: &String, val: &Arc<CachedResponse>| -> u32 {
            (val.body.len() as u32).saturating_add(200)
        })
        .time_to_live(Duration::from_secs(48 * 60 * 60))
        .build();

    let asset_client = Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        .danger_accept_invalid_certs(true)
        .redirect(Policy::default())
        .pool_idle_timeout(Duration::from_secs(300))
        .pool_max_idle_per_host(256)
        .tcp_nodelay(true)
        .tcp_keepalive(Duration::from_secs(60))
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(10))
        .http2_keep_alive_interval(Duration::from_secs(15))
        .http2_keep_alive_timeout(Duration::from_secs(20))
        .build()
        .expect("failed to build asset client");

    let html_client = Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        .danger_accept_invalid_certs(true)
        .redirect(Policy::default())
        .pool_idle_timeout(Duration::from_secs(300))
        .pool_max_idle_per_host(256)
        .tcp_nodelay(true)
        .tcp_keepalive(Duration::from_secs(60))
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(10))
        .http2_keep_alive_interval(Duration::from_secs(15))
        .http2_keep_alive_timeout(Duration::from_secs(20))
        .build()
        .expect("failed to build html client");

    let patterns = vec![
        "google-analytics.com",
        "googletagmanager.com",
        "doubleclick.net",
        "adsbygoogle",
        "cdn-cgi/rum",
    ];
    
    let blocklist_matcher = Arc::new(AhoCorasick::new(&patterns).unwrap());

    let state = Arc::new(AppState {
        html_client,
        asset_client,
        cache,
        blocklist_matcher,
        caching_inflight: DashMap::new(),
        coalesce: DashMap::new(),
        request_permit: Arc::new(Semaphore::new(8000)),
        html_rewrite_permit: Arc::new(Semaphore::new(4096)),
    });

    let port = std::env::var("MOCHI_PORT").unwrap_or_else(|_| "4000".to_string());
    let port = port.parse::<u16>().unwrap_or(4000);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("listening on {}!!", addr);
    let max_disk_cache = 40 * 1024 * 1024 * 1024;
    let max_file_age = 72 * 60 * 60;
    tokio::spawn(disk_cache_cleanup_task(max_disk_cache, max_file_age));

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/", any(proxy_handler))
        .route("/*path", any(proxy_handler))
        .layer(CompressionLayer::new())
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app)
        .tcp_nodelay(true)
        .await
        .unwrap();
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
    
    debug!("proxying request to: {}", target_url_str);

    if let Some(ws) = ws {
        if target_url_str.starts_with("ws/") || headers.contains_key("upgrade") {
             let real_target = if target_url_str.starts_with("ws/") {
                 let remaining = &target_url_str[3..];
                 if remaining.starts_with("http") {
                     remaining.replace("http", "ws")
                 } else if remaining.starts_with("wss://") {
                     remaining.to_string()
                 } else {
                     let decoded = urlencoding::decode(remaining).unwrap_or(std::borrow::Cow::Borrowed(remaining));
                     if decoded.starts_with("wss://") {
                         decoded.into_owned()
                     } else if decoded.starts_with("ws://") {
                         decoded.into_owned()
                     } else {
                         target_url_str.replace("ws/", "https://")
                            .replace("http://", "ws://")
                            .replace("https://", "wss://")
                     }
                 }
             } else {
                 if target_url_str.starts_with("http") {
                     target_url_str.replace("http", "ws")
                 } else {
                     format!("wss://{}", target_url_str)
                 }
             };
             let mut protocols = Vec::new();
             if let Some(p) = headers.get("sec-websocket-protocol") {
                 if let Ok(s) = p.to_str() {
                     protocols = s.split(',').map(|x| x.trim().to_string()).collect();
                 }
             }
             let ws = if !protocols.is_empty() {
                 ws.protocols(protocols)
             } else {
                 ws
             };

             let headers_clone = headers.clone();
             return ws.on_upgrade(move |socket| handle_socket(socket, real_target, headers_clone));
        }
    }

    if method == Method::GET {
        if let Some(cached) = state.cache.get(target_url_str).await {
            let mut res_headers = cached.headers.clone();
            res_headers.insert("X-Cache", HeaderValue::from_static("HIT"));

            if let Some(etag) = res_headers.get("etag").cloned() {
                if let Some(inm) = headers.get("if-none-match") {
                    if etag == *inm {
                        return (StatusCode::NOT_MODIFIED, res_headers).into_response();
                    }
                }
            }

            fix_game_content_type(target_url_str, &mut res_headers);
            let status = StatusCode::from_u16(cached.status).unwrap_or(StatusCode::OK);
            return (status, res_headers, cached.body.clone()).into_response();
        }
    }

    let target_url_string = if !target_url_str.starts_with("http") {
        format!("https://{}", target_url_str)
    } else {
        target_url_str.to_string()
    };
    
    let _is_blocked_asset = target_url_string.contains(".part") 
        || target_url_string.contains(".wasm") 
        || target_url_string.contains(".data")
        || target_url_string.contains(".mem");

    if state.blocklist_matcher.is_match(&target_url_string) {
        let mut headers = HeaderMap::new();
        headers.insert("Content-Type", HeaderValue::from_static("application/javascript"));
        return (StatusCode::OK, headers, "/* no */").into_response();
    }

    let target_url = match Url::parse(&target_url_string) {
        Ok(u) => u,
        Err(_) => return (StatusCode::BAD_REQUEST, "invalid url").into_response(),
    };

    let is_likely_asset = is_likely_static_asset(&target_url_string);

    if method == Method::GET && is_likely_asset {
        return fetch_and_cache(
            &state, &target_url, &target_url_string, target_url_str,
            &method, &headers, &req_body, is_likely_asset,
        ).await.unwrap_or_else(|e| e);
    }
    
    let client = if is_likely_asset {
        &state.asset_client
    } else {
        &state.html_client
    };

    let mut req_builder = client.request(method.clone(), target_url.clone());

    for (k, v) in headers.iter() {
        let key_str = k.as_str();
        if !is_blacklisted_header(key_str) && !key_str.starts_with("cf-") && !key_str.starts_with("x-") {
            if !is_likely_asset && key_str == "accept-encoding" {
                continue; 
            }
            req_builder = req_builder.header(k, v);
        }
    }

    req_builder = req_builder.header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
    req_builder = req_builder.header("Sec-Ch-Ua", "\"Not-A.Brand\";v=\"99\", \"Chromium\";v=\"124\", \"Google Chrome\";v=\"124\"");
    req_builder = req_builder.header("Sec-Ch-Ua-Mobile", "?0");
    req_builder = req_builder.header("Sec-Ch-Ua-Platform", "\"Windows\"");
    req_builder = req_builder.header("Accept-Language", "en-US,en;q=0.9");
    req_builder = req_builder.header("Sec-Fetch-Site", "same-origin");
    req_builder = req_builder.header("Sec-Fetch-Mode", "cors");
    req_builder = req_builder.header("Sec-Fetch-Dest", "empty");
    req_builder = req_builder.header("Priority", "u=1, i");

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
    debug!("upstream response status: {} for {}", status, target_url);

    if !status.is_success() {
         let mut error_headers = HeaderMap::new();
         if let Some(ct) = upstream_res.headers().get("content-type") {
             error_headers.insert("content-type", ct.clone());
         } else {
             error_headers.insert("content-type", HeaderValue::from_static("text/html; charset=utf-8"));
         }
         
         let bytes = upstream_res.bytes().await.unwrap_or_default();
         let error_body = String::from_utf8_lossy(&bytes);
         error!("upstream error body for {}: {}", target_url, error_body);
         
         return (status, error_headers, error_body.to_string()).into_response();
    }

    let res_headers_ref = upstream_res.headers();
    
    let mut safe_headers = HeaderMap::new();
    safe_headers.reserve(res_headers_ref.len());

    for (k, v) in res_headers_ref.iter() {
        let key_str = k.as_str();
        if !is_blacklisted_res_header(key_str) {
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
        
        let html_permit = match tokio::time::timeout(
            Duration::from_secs(5),
            state.html_rewrite_permit.clone().acquire_owned(),
        ).await {
            Ok(Ok(permit)) => permit,
            _ => {
                return (StatusCode::SERVICE_UNAVAILABLE, "server busy, try again").into_response();
            }
        };

        let (tx_in, mut rx_in) = mpsc::channel::<Bytes>(512);
        let (tx_out, rx_out) = mpsc::channel::<Result<Bytes, axum::Error>>(512);

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
            let _permit = html_permit;
            let base_url_str = target_url_clone.to_string();
            let client_disconnected = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let client_disconnected_clone = client_disconnected.clone();
            
            let current_base = Arc::new(RwLock::new(target_url_clone.clone()));
            let base_for_updater = current_base.clone();
            let target_url_clone_for_base = target_url_clone.clone();

            let rewrite_url = {
                let current_base = current_base.clone();
                std::sync::Arc::new(move |url: &str| -> Option<String> {
                    if url.is_empty() || url.starts_with("data:") || url.starts_with("blob:") || url.starts_with("javascript:") || url.starts_with("#") || url.starts_with(MOCHI_PREFIX) {
                        return None;
                    }
                    if url.starts_with("http://") || url.starts_with("https://") {
                        return Some(format!("{}{}", MOCHI_PREFIX, url));
                    }
                    if url.starts_with("//") {
                        return Some(format!("{}https:{}", MOCHI_PREFIX, url));
                    }
                    
                    if let Ok(lock) = current_base.read() {
                        let base = lock.clone();
                        if let Ok(resolved) = base.join(url) {
                            return Some(format!("{}{}", MOCHI_PREFIX, resolved.as_str()));
                        }
                    }
                    None
                })
            };

            let rw1 = rewrite_url.clone();
            let rw2 = rewrite_url.clone();
            let rw3 = rewrite_url.clone();
            let rw5 = rewrite_url.clone();
            let rw6 = rewrite_url.clone();
            let rw7 = rewrite_url.clone();

            let mut rewriter = HtmlRewriter::new(
                Settings {
                    element_content_handlers: vec![
                        element!("head", move |el| {
                            let full_script = format!("{}{}{}", SCRIPT_PART_1, base_url_str, SCRIPT_PART_2);
                            let _ = el.prepend(&full_script, ContentType::Html);
                            if base_url_str.contains("gn-math.dev") {
                                let gnmath_inject = r#"<style>
                                    .zone-header { display: none !important; }
                                    header { display: none !important; }
                                    main { display: none !important; }
                                    footer { display: none !important; }
                                    #zoneViewer { display: flex !important; position: fixed; inset: 0; z-index: 9999; background: #000; }
                                    #zoneFrame { flex: 1; width: 100%; height: 100%; border: none; }
                                    body { margin: 0; padding: 0; overflow: hidden; background: #000; }
                                </style>"#;
                                let _ = el.append(gnmath_inject, ContentType::Html);
                            }
                            Ok(())
                        }),
                        element!("base[href]", move |el| {
                             if let Some(href) = el.get_attribute("href") {
                                 if let Ok(parsed_base) = target_url_clone_for_base.join(&href) {
                                     if let Ok(mut lock) = base_for_updater.write() {
                                         *lock = parsed_base;
                                     }
                                 }

                                 let proxy_href = if href.starts_with("http://") || href.starts_with("https://") {
                                     format!("{}{}", MOCHI_PREFIX, href)
                                 } else if href.starts_with("//") {
                                     format!("{}https:{}", MOCHI_PREFIX, href)
                                 } else {
                                     if let Ok(parsed_base) = target_url_clone_for_base.join(&href) {
                                         format!("{}{}", MOCHI_PREFIX, parsed_base.as_str())
                                     } else {
                                         href.to_string()
                                     }
                                 };

                                 let final_href = proxy_href;
                                     
                                 let _ = el.set_attribute("href", &final_href);
                             }
                             Ok(())
                        }),
                        element!("link[href]", move |el| {
                            if let Some(val) = el.get_attribute("href") {
                                if let Some(rewritten) = rw1(&val) {
                                    let _ = el.set_attribute("href", &rewritten);
                                }
                            }
                            Ok(())
                        }),
                        element!("script[src]", move |el| {
                            if let Some(val) = el.get_attribute("src") {
                                if let Some(rewritten) = rw2(&val) {
                                    let _ = el.set_attribute("src", &rewritten);
                                }
                            }
                            Ok(())
                        }),
                        element!("img[src]", move |el| {
                            if let Some(val) = el.get_attribute("src") {
                                if let Some(rewritten) = rw3(&val) {
                                    let _ = el.set_attribute("src", &rewritten);
                                }
                            }
                            Ok(())
                        }),
                        element!("source[src], video[src], audio[src], video[poster]", move |el| {
                            if let Some(val) = el.get_attribute("src") {
                                if let Some(rewritten) = rw5(&val) {
                                    let _ = el.set_attribute("src", &rewritten);
                                }
                            }
                            if let Some(val) = el.get_attribute("poster") {
                                if let Some(rewritten) = rw5(&val) {
                                    let _ = el.set_attribute("poster", &rewritten);
                                }
                            }
                            Ok(())
                        }),
                        element!("a[href], area[href]", move |el| {
                            if let Some(val) = el.get_attribute("href") {
                                if let Some(rewritten) = rw6(&val) {
                                    let _ = el.set_attribute("href", &rewritten);
                                }
                            }
                            Ok(())
                        }),
                        element!("iframe[src], embed[src], form[action]", move |el| {
                            let attr = if el.tag_name() == "form" { "action" } else { "src" };
                            if let Some(val) = el.get_attribute(attr) {
                                if let Some(rewritten) = rw7(&val) {
                                    let _ = el.set_attribute(attr, &rewritten);
                                }
                            }
                            Ok(())
                        }),
                    ],
                    ..Settings::default()
                },
                move |c: &[u8]| {
                    if !c.is_empty() {
                        if tx_out.blocking_send(Ok(Bytes::copy_from_slice(c))).is_err() {
                            client_disconnected_clone.store(true, std::sync::atomic::Ordering::Relaxed);
                        }
                    }
                },
            );

            while let Some(chunk) = rx_in.blocking_recv() {
                if client_disconnected.load(std::sync::atomic::Ordering::Relaxed) { break; }
                if rewriter.write(&chunk).is_err() { break; }
            }
            if !client_disconnected.load(std::sync::atomic::Ordering::Relaxed) {
                let _ = rewriter.end();
            }
        });

        return (status, safe_headers, Body::from_stream(ReceiverStream::new(rx_out))).into_response();
    }

    let is_image = content_type.starts_with("image/");
    let is_json = content_type.contains("json");
    let is_favicon_heuristic = target_url_str.contains("favicons?");
    let is_css = content_type.contains("text/css");
    let is_js = content_type.contains("javascript");
    let is_font = content_type.starts_with("font/") || content_type.contains("font");
    let is_wasm = content_type.contains("wasm");
    let should_cache = (is_likely_asset || is_image || is_json || is_favicon_heuristic || is_css || is_js || is_font || is_wasm) 
        && status.is_success()
        && method == Method::GET
        && !headers.contains_key("upgrade");

    if should_cache {
        let (sender_tx, sender_rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(512);
        let target_url_str_owned = target_url_str.to_string();
        let state_clone = state.clone();
        let safe_headers_clone = safe_headers.clone();
        let status_u16 = status.as_u16();
        let cc = get_cdn_cache_control(&target_url_string);
        safe_headers.insert("Cache-Control", HeaderValue::from_static(cc));

        tokio::spawn(async move {
            let mut stream = upstream_res.bytes_stream();
            let mut accumulator = Vec::new();
            let mut total_size = 0usize;
            let mut aborted = false;

            while let Some(item) = stream.next().await {
                match item {
                    Ok(chunk) => {
                        total_size += chunk.len();
                        if total_size < MAX_CACHE_SIZE_BYTES {
                            accumulator.extend_from_slice(&chunk);
                        }
                        if sender_tx.send_timeout(
                            Ok(chunk),
                            Duration::from_secs(10),
                        ).await.is_err() {
                            aborted = true;
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = sender_tx.send(Err(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))).await;
                        aborted = true;
                        break;
                    }
                }
            }

            if !aborted {
                if total_size < MAX_CACHE_SIZE_BYTES && total_size > 0 {
                    let body_bytes = Bytes::from(accumulator);
                    let cached = Arc::new(CachedResponse {
                        status: status_u16,
                        headers: safe_headers_clone,
                        body: body_bytes,
                    });
                    state_clone.cache.insert(target_url_str_owned, cached).await;
                }
            }
        });

        let stream_body = Body::from_stream(ReceiverStream::new(sender_rx));
        return (status, safe_headers, stream_body).into_response();
    }

    let stream = Body::from_stream(upstream_res.bytes_stream());
    return (status, safe_headers, stream).into_response();
}

fn get_cache_path(url: &str) -> String {
    let cache_key = if is_likely_static_asset(url) && !url.contains("favicons?") {
        url.split('?').next().unwrap_or(url)
    } else {
        url
    };
    
    let mut hasher = DefaultHasher::new();
    cache_key.hash(&mut hasher);
    let hash = hasher.finish();
    format!("./cache/{:x}.bin", hash)
}

async fn load_from_disk(url: &str) -> Option<(Response, bool)> {
    let path = get_cache_path(url);
    let mut file = match File::open(&path).await {
        Ok(f) => f,
        Err(_) => return None,
    };

    let _metadata = file.metadata().await.ok()?;

    let mut buf_u16 = [0u8; 2];
    if file.read_exact(&mut buf_u16).await.is_err() { return None; }
    let status_code = u16::from_le_bytes(buf_u16);

    if file.read_exact(&mut buf_u16).await.is_err() { return None; }
    let header_count = u16::from_le_bytes(buf_u16);

    let mut headers = HeaderMap::new();

    for _ in 0..header_count {
        if file.read_exact(&mut buf_u16).await.is_err() { return None; }
        let k_len = u16::from_le_bytes(buf_u16) as usize;
        let mut k_buf = vec![0u8; k_len];
        if file.read_exact(&mut k_buf).await.is_err() { return None; }
        let key_str = String::from_utf8(k_buf).ok()?;
        
        let mut buf_u32 = [0u8; 4];
        if file.read_exact(&mut buf_u32).await.is_err() { return None; }
        let v_len = u32::from_le_bytes(buf_u32) as usize;
        let mut v_buf = vec![0u8; v_len];
        if file.read_exact(&mut v_buf).await.is_err() { return None; }
        
        let Ok(h_name) = axum::http::header::HeaderName::from_bytes(key_str.as_bytes()) else { continue };
        let Ok(h_val) = axum::http::header::HeaderValue::from_bytes(&v_buf) else { continue };
        headers.insert(h_name, h_val);
    }
    
    headers.insert("X-Cache", HeaderValue::from_static("DISK"));
    
    fix_game_content_type(url, &mut headers);

    let status = StatusCode::from_u16(status_code).unwrap_or(StatusCode::OK);


    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);
    
    Some(((status, headers, body).into_response(), false))
}

async fn fetch_and_cache(
    state: &Arc<AppState>,
    target_url: &Url,
    _target_url_string: &str,
    target_url_str: &str,
    method: &Method,
    headers: &HeaderMap,
    req_body: &Bytes,
    is_likely_asset: bool,
) -> Result<Response, Response> {
    let force_refresh = headers.get("cache-control")
        .and_then(|h| h.to_str().ok())
        .map(|v| v.contains("no-cache"))
        .unwrap_or(false);

    if method == &Method::GET && !force_refresh {
        if let Some(cached) = state.cache.get(target_url_str).await {
            let mut res_headers = cached.headers.clone();
            res_headers.insert("X-Cache", HeaderValue::from_static("HIT"));
            fix_game_content_type(_target_url_string, &mut res_headers);
            let status = StatusCode::from_u16(cached.status).unwrap_or(StatusCode::OK);
            return Ok((status, res_headers, cached.body.clone()).into_response());
        }
    }

    if method == &Method::GET && !force_refresh {
        if let Some(disk_response) = load_from_disk(target_url_str).await {
            debug!("disk cache hit for {}", target_url_str);
            let (mut response, _) = disk_response;
            fix_game_content_type(_target_url_string, response.headers_mut());
            return Ok(response);
        }
    }

    if method == &Method::GET {
        if let Some(entry) = state.coalesce.get(target_url_str) {
            let mut rx = entry.subscribe();
            drop(entry);
            debug!("coalescing request for {}", target_url_str);

            match tokio::time::timeout(Duration::from_secs(30), rx.recv()).await {
                Ok(Ok(cached)) => {
                    let mut res_headers = cached.headers.clone();
                    res_headers.insert("X-Cache", HeaderValue::from_static("COALESCED"));
                    fix_game_content_type(_target_url_string, &mut res_headers);
                    let status = StatusCode::from_u16(cached.status).unwrap_or(StatusCode::OK);
                    return Ok((status, res_headers, cached.body.clone()).into_response());
                }
                _ => {
                    debug!("coalesce wait failed for {}, becoming leader", target_url_str);
                }
            }
        }
    }

    let (coalesce_tx, _) = broadcast::channel::<Arc<CachedResponse>>(1);
    let coalesce_tx_clone = coalesce_tx.clone();
    state.coalesce.insert(target_url_str.to_string(), coalesce_tx);
    let _permit = match state.request_permit.acquire().await {
        Ok(p) => p,
        Err(_) => {
            state.coalesce.remove(target_url_str);
            return Err((StatusCode::SERVICE_UNAVAILABLE, "too many requests").into_response());
        }
    };

    let client = if is_likely_asset {
        &state.asset_client
    } else {
        &state.html_client
    };

    let mut req_builder = client.request(method.clone(), target_url.clone());

    for (k, v) in headers.iter() {
        let key_str = k.as_str();
        if !is_blacklisted_header(key_str) && !key_str.starts_with("cf-") && !key_str.starts_with("x-") {
            if !is_likely_asset && key_str == "accept-encoding" {
                continue;
            }
            req_builder = req_builder.header(k, v);
        }
    }

    req_builder = req_builder.header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
    req_builder = req_builder.header("Sec-Ch-Ua", "\"Not-A.Brand\";v=\"99\", \"Chromium\";v=\"124\", \"Google Chrome\";v=\"124\"");
    req_builder = req_builder.header("Sec-Ch-Ua-Mobile", "?0");
    req_builder = req_builder.header("Sec-Ch-Ua-Platform", "\"Windows\"");
    req_builder = req_builder.header("Accept-Language", "en-US,en;q=0.9");
    req_builder = req_builder.header("Sec-Fetch-Site", "same-origin");
    req_builder = req_builder.header("Sec-Fetch-Mode", "cors");
    req_builder = req_builder.header("Sec-Fetch-Dest", "empty");
    req_builder = req_builder.header("Priority", "u=1, i");
    let origin = target_url.origin().ascii_serialization();
    req_builder = req_builder.header("Referer", format!("{}/", origin));
    req_builder = req_builder.header("Origin", &origin);

    if !req_body.is_empty() {
        req_builder = req_builder.body(req_body.clone());
    }

    let upstream_res = match req_builder.send().await {
        Ok(res) => res,
        Err(e) => {
            error!("upstream error for {}: {}", target_url_str, e);
            state.coalesce.remove(target_url_str);
            return Err((StatusCode::BAD_GATEWAY, format!("upstream error: {}", e)).into_response());
        }
    };

    let status = upstream_res.status();
    let res_headers_ref = upstream_res.headers();

    let mut safe_headers = HeaderMap::new();
    safe_headers.reserve(res_headers_ref.len());

    for (k, v) in res_headers_ref.iter() {
        let key_str = k.as_str();
        if !is_blacklisted_res_header(key_str) {
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
    
    if is_likely_asset && status.is_success() {
        let is_unstable = target_url_str.contains("/main/") || target_url_str.contains("/master/");
        let cc_value = if is_unstable {
            "public, max-age=300, stale-while-revalidate=60"
        } else {
            get_cdn_cache_control(_target_url_string)
        };
        safe_headers.insert("Cache-Control", HeaderValue::from_static(cc_value));
    }

    fix_game_content_type(_target_url_string, &mut safe_headers);
    safe_headers.insert("Access-Control-Allow-Origin", HeaderValue::from_static("*"));
    safe_headers.insert("X-Cache", HeaderValue::from_static("MISS"));

    let should_cache = is_likely_asset && status.is_success() && method == &Method::GET;

    let actually_cache = if should_cache {
        if state.caching_inflight.contains_key(target_url_str) {
            false
        } else {
            state.caching_inflight.insert(target_url_str.to_string(), ());
            true
        }
    } else {
        false
    };

    if !actually_cache {
        state.coalesce.remove(target_url_str);
    }

    if actually_cache {
        let (sender_tx, sender_rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(512);
        let target_url_str_owned = target_url_str.to_string();
        let state_clone = state.clone();
        let safe_headers_clone = safe_headers.clone();
        
        tokio::spawn(async move {
            let cache_path = get_cache_path(&target_url_str_owned);
            let temp_path = format!("{}.{}.tmp", cache_path, uuid::Uuid::new_v4());

            let mut file = match File::create(&temp_path).await {
                Ok(f) => Some(f),
                Err(e) => {
                    warn!("failed to create temp file {}: {}", temp_path, e);
                    None
                }
            };

            if let Some(ref mut f) = file {
                let status_bytes = status.as_u16().to_le_bytes();
                if f.write_all(&status_bytes).await.is_err() { file = None; }
                else {
                    let header_count = safe_headers_clone.len() as u16;
                    if f.write_all(&header_count.to_le_bytes()).await.is_err() { file = None; }
                    else {
                        for (k, v) in safe_headers_clone.iter() {
                            let k_bytes = k.as_str().as_bytes();
                            let k_len = k_bytes.len() as u16;
                            if f.write_all(&k_len.to_le_bytes()).await.is_err() { file = None; break; }
                            if f.write_all(k_bytes).await.is_err() { file = None; break; }

                            let v_bytes = v.as_bytes();
                            let v_len = v_bytes.len() as u32;
                            if f.write_all(&v_len.to_le_bytes()).await.is_err() { file = None; break; }
                            if f.write_all(v_bytes).await.is_err() { file = None; break; }
                        }
                    }
                }
            }

            let mut stream = upstream_res.bytes_stream();
            let mut accumulator = Vec::new();
            let mut total_size = 0;
            let mut aborted = false;
            let mut is_too_large_for_ram = false;

            while let Some(item) = stream.next().await {
                match item {
                    Ok(chunk) => {
                        let chunk_len = chunk.len();
                        total_size += chunk_len;
                        
                        if let Some(ref mut f) = file {
                            if f.write_all(&chunk).await.is_err() {
                                file = None;
                                let _ = fs::remove_file(&temp_path).await;
                            }
                        }

                        if !is_too_large_for_ram {
                            if total_size < RAM_CACHE_LIMIT {
                                accumulator.extend_from_slice(&chunk);
                            } else {
                                is_too_large_for_ram = true;
                                accumulator.clear();
                            }
                        }
                        
                        if sender_tx.send_timeout(
                            Ok(chunk),
                            Duration::from_secs(10),
                        ).await.is_err() {
                            aborted = true;
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = sender_tx.send(Err(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))).await;
                        aborted = true;
                        break;
                    }
                }
            }
            
            if !aborted && file.is_some() {
                 let _ = fs::rename(&temp_path, &cache_path).await;

                 if !is_too_large_for_ram && total_size < RAM_CACHE_LIMIT {
                     let body_bytes = Bytes::from(accumulator);
                     let cached = Arc::new(CachedResponse {
                         status: status.as_u16(),
                         headers: safe_headers_clone,
                         body: body_bytes,
                     });
                     state_clone.cache.insert(target_url_str_owned.clone(), cached.clone()).await;
                     let _ = coalesce_tx_clone.send(cached);
                 }
            } else {
                let _ = fs::remove_file(&temp_path).await;
            }
            
            state_clone.caching_inflight.remove(&target_url_str_owned);
            state_clone.coalesce.remove(&target_url_str_owned);
        });

        let stream_body = Body::from_stream(ReceiverStream::new(sender_rx));
        let response = (status, safe_headers, stream_body).into_response();

        return Ok(response);
    }


    let stream = Body::from_stream(upstream_res.bytes_stream());
    let response = (status, safe_headers, stream).into_response();
    Ok(response)
}

async fn handle_socket(client_socket: WebSocket, target_url: String, headers: HeaderMap) {
    let (mut client_sender, mut client_receiver) = client_socket.split();

    let mut request = Request::builder().uri(&target_url);
    
    request = request.header("Sec-WebSocket-Key", generate_key());
    request = request.header("Sec-WebSocket-Version", "13");
    request = request.header("Connection", "Upgrade");
    request = request.header("Upgrade", "websocket");

    if let Ok(u) = Url::parse(&target_url) {
         if let Some(host) = u.host_str() {
             request = request.header("Host", host);
         }
         let origin = u.origin().ascii_serialization();
         request = request.header("Origin", origin);
    }
    
    for (k, v) in headers.iter() {
        let key = k.as_str();
        if key.eq_ignore_ascii_case("sec-websocket-protocol") 
           || key.eq_ignore_ascii_case("cookie") 
           || key.eq_ignore_ascii_case("authorization") {
             request = request.header(k, v);
        }
    }

    let request = request.body(()).unwrap();

    let (ws_stream, _) = match connect_async(request).await {
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
    let url_without_query = url.split('?').next().unwrap_or(url);
    let path = Path::new(url_without_query);
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
            "gif" => "image/gif",
            "webp" => "image/webp",
            "mp4" => "video/mp4",
            "webm" => "video/webm",
            "mp3" => "audio/mpeg",
            "ogg" => "audio/ogg",
            "wav" => "audio/wav",
            "woff" => "font/woff",
            "woff2" => "font/woff2",
            "ttf" => "font/ttf",
            "otf" => "font/otf",
            s if s.starts_with("part") => "application/octet-stream",
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
        ".atlas", ".fnt", ".png", ".jpg", ".jpeg", ".mp3", ".ogg", ".wav", ".css", ".svg",
        ".gif", ".webp", ".mp4", ".webm", ".woff", ".woff2", ".ttf", ".otf", ".eot",
        ".ico", ".aac", ".flac", ".m3u8",
    ];
    
    if url.contains("favicons?") {
        return true;
    }

    let url_without_query = url.split('?').next().unwrap_or(url);
    if exts.iter().any(|ext| url_without_query.ends_with(ext)) {
        return true;
    }
    
    if let Some(idx) = url_without_query.rfind(".part") {
        let suffix = &url_without_query[idx + 5..];
        if !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()) {
            return true;
        }
    }

    false
}

fn is_cdn_url(url: &str) -> bool {
    CDN_DOMAINS.iter().any(|domain| url.contains(domain))
}

fn get_cdn_cache_control(url: &str) -> &'static str {
    if is_cdn_url(url) {
        let has_version = url.contains("/v") || url.contains("@") || url.contains("/releases/");
        if has_version {
            "public, max-age=31536000, immutable"
        } else {
            "public, max-age=604800, stale-while-revalidate=86400"
        }
    } else {
        "public, max-age=86400, stale-while-revalidate=3600"
    }
}

fn is_blacklisted_header(name: &str) -> bool {
    matches!(name, "host" | "connection" | "content-length" | "transfer-encoding" | "upgrade" | "sec-websocket-key" | "sec-websocket-version" | "sec-websocket-extensions")
}

fn is_blacklisted_res_header(name: &str) -> bool {
    matches!(name, "connection" | "content-length" | "transfer-encoding" | "content-encoding" | "content-security-policy" | "strict-transport-security" | "access-control-allow-origin" | "x-frame-options" | "x-content-type-options")
}