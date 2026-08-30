use adaptive_capacity::AdaptiveGate;
use aho_corasick::AhoCorasick;
use axum::http::HeaderMap;
use bytes::Bytes;
use dashmap::DashMap;
use moka::future::Cache;
use reqwest::Client;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};

#[derive(Clone)]
pub struct CachedResponse {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Bytes,
}

#[derive(Clone)]
pub struct FolioCachedResponse {
    pub status: u16,
    pub status_text: String,
    pub url: String,
    pub raw_headers: Vec<(String, String)>,
    pub body: Bytes,
    pub fresh_until_ms: u64,
}

#[derive(Default)]
pub struct FolioMetrics {
    pub active_requests: AtomicU64,
    pub requests: AtomicU64,
    pub cache_hits: AtomicU64,
    pub cache_misses: AtomicU64,
    pub cache_revalidations: AtomicU64,
    pub rejected_targets: AtomicU64,
    pub upstream_errors: AtomicU64,
}

pub struct AppState {
    pub html_client: Client,
    pub asset_client: Client,
    pub raw_client: Client,
    pub cache: Cache<String, Arc<CachedResponse>>,
    pub stream_cache: Cache<String, Arc<CachedResponse>>,
    pub stream_fills: Cache<String, Arc<Mutex<Option<bool>>>>,
    pub folio_cache: Cache<String, Arc<FolioCachedResponse>>,
    pub folio_metrics: FolioMetrics,
    pub blocklist_matcher: Arc<AhoCorasick>,
    pub caching_inflight: DashMap<String, ()>,
    pub coalesce: DashMap<String, broadcast::Sender<Arc<CachedResponse>>>,
    pub request_permit: Arc<AdaptiveGate>,
    pub stream_upstream_permit: Arc<AdaptiveGate>,
    pub html_rewrite_permit: Arc<AdaptiveGate>,
    pub max_cache_entry_size: usize,
    pub disk_cache_max_age_secs: u64,
    pub folio_cache_max_entry_size: usize,
    pub folio_cache_max_ttl_secs: u64,
    pub stream_max_entry_size: usize,
    pub ram_cache_limit: usize,
    pub channel_buffer: usize,
}

pub const CDN_DOMAINS: &[&str] = &[
    "site-assets.fontawesome.com",
    "ka-f.fontawesome.com",
    "kit.fontawesome.com",
    "cdn.cloudflare.com",
    "ajax.googleapis.com",
    "cdn.jsdelivr.net",
    "raw.githubusercontent.com",
    "gn-math.dev",
    "fonts.googleapis.com",
    "fonts.gstatic.com",
];
