use axum::{extract::Request, middleware::Next, response::{IntoResponse, Response}, http::StatusCode};
use std::{sync::atomic::{AtomicU64, Ordering}, time::Duration};

static EXPIRED: AtomicU64 = AtomicU64::new(0);

pub fn expired() -> u64 { EXPIRED.load(Ordering::Relaxed) }
pub async fn headers(request: Request, next: Next) -> Response {
    let budget = if request.uri().path().starts_with(crate::constants::COVER_PREFIX) {
        Duration::from_secs(15)
    } else {
        Duration::from_secs(25)
    };
    match tokio::time::timeout(budget, next.run(request)).await {
        Ok(response) => response,
        Err(_) => {
            EXPIRED.fetch_add(1, Ordering::Relaxed);
            tracing::warn!(budget_ms = budget.as_millis() as u64, "upstream response deadline exceeded... /ᐠ - ˕ -マ");
            (StatusCode::GATEWAY_TIMEOUT,
                [("cache-control", "no-store"), ("x-lyra-error-class", "network-timeout")],
                crate::negative_message("the source took too long to respond")).into_response()
        }
    }
}

