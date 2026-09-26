use axum::{
    body::Body,
    extract::{ConnectInfo, Request, State},
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

struct Client {
    tokens: f64,
    updated: Instant,
    http: usize,
    websockets: usize,
}

pub struct Admission {
    clients: Mutex<HashMap<IpAddr, Client>>,
    last_cleanup: Mutex<Instant>,
    rate: usize,
    burst: usize,
    http: usize,
    websockets: usize,
    trusted_proxies: Vec<IpAddr>,
    metrics_token: Option<String>,
}

pub fn limit(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|v| *v > 0)
        .unwrap_or(default)
}

impl Admission {
    pub fn from_env() -> Arc<Self> {
        Arc::new(Self {
            clients: Mutex::new(HashMap::new()),
            last_cleanup: Mutex::new(Instant::now()),
            rate: limit("MOCHI_CLIENT_REQUESTS_PER_SECOND", 100),
            burst: limit("MOCHI_CLIENT_BURST", 400),
            http: limit("MOCHI_CLIENT_CONCURRENCY", 64),
            websockets: limit("MOCHI_CLIENT_WEBSOCKETS", 16),
            trusted_proxies: std::env::var("MOCHI_TRUSTED_PROXIES")
                .unwrap_or_default()
                .split(',')
                .filter_map(|v| v.trim().parse().ok())
                .collect(),
            metrics_token: std::env::var("MOCHI_METRICS_TOKEN")
                .ok()
                .filter(|v| !v.is_empty()),
        })
    }

    fn client_ip(&self, peer: IpAddr, headers: &HeaderMap) -> IpAddr {
        let mut ip = peer;
        if self.trusted_proxies.contains(&peer) {
            if let Some(chain) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
                for entry in chain.rsplit(',') {
                    if !self.trusted_proxies.contains(&ip) {
                        break;
                    }
                    let Ok(next) = entry.trim().parse() else {
                        return peer;
                    };
                    ip = next;
                }
            }
        }
        ip
    }

    fn metrics_allowed(&self, ip: IpAddr, headers: &HeaderMap) -> bool {
        if let Some(token) = &self.metrics_token {
            return headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer "))
                .is_some_and(|v| constant_time_eq(v.as_bytes(), token.as_bytes()));
        }
        ip.is_loopback()
            && !["forwarded", "x-forwarded-for", "x-real-ip"]
                .iter()
                .any(|name| headers.contains_key(*name))
    }

    fn acquire(self: &Arc<Self>, ip: IpAddr, websocket: bool) -> Option<Arc<ClientPermit>> {
        let now = Instant::now();
        let mut clients = self.clients.lock().unwrap_or_else(|e| e.into_inner());
        if !clients.contains_key(&ip) && clients.len() >= 16_384 {
            let mut last_cleanup = self.last_cleanup.lock().unwrap_or_else(|e| e.into_inner());
            if now.duration_since(*last_cleanup) < Duration::from_secs(1) {
                return None;
            }
            *last_cleanup = now;
            let retention =
                Duration::from_secs(60.max((self.burst as u64).div_ceil(self.rate as u64)));
            clients.retain(|_, c| {
                c.http > 0 || c.websockets > 0 || now.duration_since(c.updated) < retention
            });
            if clients.len() >= 16_384 {
                return None;
            }
        }
        let client = clients.entry(ip).or_insert(Client {
            tokens: self.burst as f64,
            updated: now,
            http: 0,
            websockets: 0,
        });
        client.tokens = (client.tokens
            + now.duration_since(client.updated).as_secs_f64() * self.rate as f64)
            .min(self.burst as f64);
        client.updated = now;
        let active = if websocket {
            &mut client.websockets
        } else {
            &mut client.http
        };
        let limit = if websocket {
            self.websockets
        } else {
            self.http
        };
        if client.tokens < 1.0 || *active >= limit {
            return None;
        }
        client.tokens -= 1.0;
        *active += 1;
        Some(Arc::new(ClientPermit {
            admission: self.clone(),
            ip,
            websocket,
        }))
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |diff, (a, b)| diff | (a ^ b)) == 0
}

pub struct ClientPermit {
    admission: Arc<Admission>,
    ip: IpAddr,
    websocket: bool,
}

impl Drop for ClientPermit {
    fn drop(&mut self) {
        let mut clients = self
            .admission
            .clients
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(client) = clients.get_mut(&self.ip) {
            let active = if self.websocket {
                &mut client.websockets
            } else {
                &mut client.http
            };
            *active = active.saturating_sub(1);
        }
    }
}

pub async fn admit(
    State(admission): State<Arc<Admission>>,
    mut request: Request,
    next: Next,
) -> Response {
    let Some(ConnectInfo(peer)) = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .copied()
    else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "client address unavailable... /ᐠ - ˕ -マ",
        )
            .into_response();
    };
    let ip = admission.client_ip(peer.ip(), request.headers());
    if matches!(
        request.uri().path(),
        "/metrics" | "/stream/metrics" | "/!!folio/metrics"
    ) {
        if !admission.metrics_allowed(ip, request.headers())
            || (admission.metrics_token.is_none()
                && admission.trusted_proxies.contains(&peer.ip())
                && ip == peer.ip())
        {
            return (
                StatusCode::FORBIDDEN,
                [("cache-control", "no-store")],
                "metrics access denied... /ᐠ - ˕ -マ",
            )
                .into_response();
        }
    }
    if request.uri().path() == "/health" {
        return next.run(request).await;
    }
    let websocket = request
        .headers()
        .get("upgrade")
        .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"));
    let Some(permit) = admission.acquire(ip, websocket) else {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [("retry-after", "1"), ("cache-control", "no-store")],
            "client request limit reached... /ᐠ - ˕ -マ",
        )
            .into_response();
    };
    request.extensions_mut().insert(permit.clone());
    let response = next.run(request).await;
    let (parts, body) = response.into_parts();
    Response::from_parts(
        parts,
        Body::from_stream(body.into_data_stream().map(move |chunk| {
            let _permit = &permit;
            chunk
        })),
    )
}