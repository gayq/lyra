use axum::body::Body;
use axum::http::{HeaderMap, StatusCode};
use futures_util::StreamExt;
use std::path::PathBuf;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio_util::io::ReaderStream;

pub const MAX_SPOOLED_BODY: u64 = 1024 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum SpoolError {
    TooLarge,
    Unreadable,
    Storage,
}

impl SpoolError {
    pub fn status(&self) -> StatusCode {
        match self {
            Self::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::Unreadable => StatusCode::BAD_REQUEST,
            Self::Storage => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn message(&self) -> &'static str {
        match self {
            Self::TooLarge => "request body is too large",
            Self::Unreadable => "request body could not be read",
            Self::Storage => "upload storage is unavailable",
        }
    }
}

struct SpoolFile(PathBuf);

impl Drop for SpoolFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub fn content_length(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
}

pub async fn spool(body: Body, max_size: u64) -> Result<(Body, u64), SpoolError> {
    if http_body::Body::is_end_stream(&body) {
        return Ok((Body::empty(), 0));
    }
    spool_in(&std::env::temp_dir(), body, max_size).await
}

async fn spool_in(
    dir: &std::path::Path,
    body: Body,
    max_size: u64,
) -> Result<(Body, u64), SpoolError> {
    let path = dir.join(format!("mochi-upload-{}", uuid::Uuid::new_v4()));
    let guard = SpoolFile(path.clone());
    let mut file = tokio::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&path)
        .await
        .map_err(|error| {
            tracing::warn!(%error, "upload spool file could not be created... /ᐠ - ˕ -マ");
            SpoolError::Storage
        })?;
    let mut length = 0u64;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| SpoolError::Unreadable)?;
        length += chunk.len() as u64;
        if length > max_size {
            return Err(SpoolError::TooLarge);
        }
        file.write_all(&chunk).await.map_err(|error| {
            tracing::warn!(%error, "upload spool write failed... /ᐠ - ˕ -マ");
            SpoolError::Storage
        })?;
    }
    file.flush().await.map_err(|_| SpoolError::Storage)?;
    file.rewind().await.map_err(|_| SpoolError::Storage)?;
    let spooled = ReaderStream::new(file).map(move |chunk| {
        let _ = &guard;
        chunk
    });
    Ok((Body::from_stream(spooled), length))
}

