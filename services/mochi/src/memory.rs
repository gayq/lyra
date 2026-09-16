use crate::state::AppState;
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use sysinfo::System;

#[derive(Default)]
pub struct MemoryPressure {
    shedding: AtomicBool,
    budget: AtomicU64,
    available: AtomicU64,
    rejected: AtomicU64,
}

impl MemoryPressure {
    fn update(&self, budget: u64, available: u64) -> bool {
        self.budget.store(budget, Ordering::Relaxed);
        self.available.store(available, Ordering::Relaxed);
        let was_shedding = self.shedding.load(Ordering::Relaxed);
        let threshold = if was_shedding {
            budget / 5
        } else {
            budget / 10
        };
        let shedding = available <= threshold;
        self.shedding.store(shedding, Ordering::Relaxed);
        shedding
    }

    fn reject(&self, path: &str) -> Option<Response> {
        if !self.shedding.load(Ordering::Relaxed)
            || matches!(
                path,
                "/health" | "/metrics" | "/stream/metrics" | "/!!folio/metrics"
            )
        {
            return None;
        }
        self.rejected.fetch_add(1, Ordering::Relaxed);
        Some(
            (
                StatusCode::SERVICE_UNAVAILABLE,
                [("retry-after", "2"), ("cache-control", "no-store")],
                "proxy is busy, try again shortly... /ᐠ - ˕ -マ",
            )
                .into_response(),
        )
    }

    pub fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "budget_bytes": self.budget.load(Ordering::Relaxed),
            "available_bytes": self.available.load(Ordering::Relaxed),
            "shedding": self.shedding.load(Ordering::Relaxed),
            "rejected": self.rejected.load(Ordering::Relaxed),
        })
    }
}

pub async fn admit(
    State(pressure): State<Arc<MemoryPressure>>,
    request: Request,
    next: Next,
) -> Response {
    match pressure.reject(request.uri().path()) {
        Some(response) => response,
        None => next.run(request).await,
    }
}

pub fn spawn_monitor(state: Arc<AppState>) {
    tokio::spawn(async move {
        let mut system = System::new();
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            system.refresh_memory();
            let (budget, available) =
                adaptive_capacity::memory_budget(system.total_memory(), system.available_memory());
            if state.memory_pressure.update(budget, available) {
                state.cache.invalidate_all();
                state.stream_cache.invalidate_all();
                state.folio_cache.invalidate_all();
                tokio::join!(
                    state.cache.run_pending_tasks(),
                    state.stream_cache.run_pending_tasks(),
                    state.folio_cache.run_pending_tasks(),
                );
            }
        }
    });
}