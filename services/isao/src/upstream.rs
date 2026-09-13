use crate::catalog_store::{now, Store};
use reqwest::{header::HeaderMap, RequestBuilder, Response};
use std::{sync::OnceLock, time::Duration};

static STORE: OnceLock<Store> = OnceLock::new();

pub fn init(store: Store) { let _ = STORE.set(store); }

#[derive(Clone, Copy)]
pub enum Provider { Anilist, Jikan, Kitsu, Anikoto }

impl Provider {
    fn settings(self) -> (&'static str, i64) {
        match self {
            Self::Anilist => ("anilist", 3_000), // 20 min
            Self::Jikan => ("jikan", 1_100),
            Self::Kitsu => ("kitsu", 1_100),
            Self::Anikoto => ("anikoto", 1_100),
        }
    }
}

fn retry_at(headers: &HeaderMap, time: i64) -> i64 {
    let retry = headers.get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| {
        v.parse::<i64>().ok().filter(|v| *v >= 0).map(|secs| time.saturating_add(secs.saturating_mul(1000)))
            .or_else(|| httpdate::parse_http_date(v).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|t| t.as_millis() as i64))
    }).unwrap_or(time + 60_000);
    let reset = headers.get("x-ratelimit-reset").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<i64>().ok()).unwrap_or(0).saturating_mul(1000);
    retry.max(reset).max(time + 1000)
}

pub async fn send(provider: Provider, request: RequestBuilder) -> Option<Response> {
    send_with_store(STORE.get()?, provider, request).await
}

async fn send_with_store(store: &Store, provider: Provider, request: RequestBuilder) -> Option<Response> {
    let (name, interval) = provider.settings();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let wait = store.reserve(name, interval).await.ok()?;
            if wait == 0 { break; }
            tokio::time::sleep(Duration::from_millis(wait.min(1000) as u64)).await;
        }
        let response = match request.timeout(Duration::from_secs(10)).send().await {
            Ok(response) => response,
            Err(_) => { let _ = store.cooldown(name, now() + 30_000, true).await; return None; }
        };
        if response.status().as_u16() == 429 {
            let _ = store.cooldown(name, retry_at(response.headers(), now()), true).await;
        } else if response.status().is_server_error() || response.status().as_u16() == 403 {
            let _ = store.cooldown(name, now() + 30_000, true).await;
        } else if response.headers().get("x-ratelimit-remaining").and_then(|v| v.to_str().ok()) == Some("0") {
            let _ = store.cooldown(name, retry_at(response.headers(), now()), false).await;
        }
        Some(response)
    }).await.ok().flatten()
}