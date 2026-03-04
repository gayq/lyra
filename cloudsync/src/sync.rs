use axum::{
    extract::{State, Json},
    http::StatusCode,
    response::IntoResponse,
};
use tower_cookies::Cookies;
use rusqlite::params;
use serde::Serialize;
use std::sync::Arc;
use tokio::io::AsyncReadExt;
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use rand::rngs::OsRng;
use rand::RngCore;
use async_compression::Level;
use async_compression::tokio::write::BrotliEncoder;
use async_compression::tokio::bufread::BrotliDecoder;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;

use crate::auth::{get_current_user, AppState};

const IV_LENGTH: usize = 12;
const MAX_JSON_DEPTH: usize = 10;
const MAX_RAW_SIZE: usize = 10 * 1024 * 1024;

fn check_json_depth(val: &serde_json::Value, depth: usize) -> bool {
    if depth > MAX_JSON_DEPTH {
        return false;
    }
    match val {
        serde_json::Value::Object(map) => map.values().all(|v| check_json_depth(v, depth + 1)),
        serde_json::Value::Array(arr) => arr.iter().all(|v| check_json_depth(v, depth + 1)),
        _ => true,
    }
}

#[derive(Serialize)]
struct SyncResponse {
    success: bool,
    data: Option<serde_json::Value>,
    updated_at: Option<String>,
    error: Option<String>,
}

pub async fn meta(
    State(state): State<Arc<AppState>>,
    cookies: Cookies,
) -> impl IntoResponse {
    let (user_id, _) = match get_current_user(&state, &cookies).await {
        Ok(u) => u,
        Err(_) => return (StatusCode::UNAUTHORIZED, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("unauthorized".into()) })),
    };

    let pool = state.pool.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<String, &'static str> {
        let conn = pool.get().map_err(|_| "db pool error")?;
        let updated_at: String = conn.query_row(
            "SELECT updated_at FROM sync_data WHERE user_id = ?",
            params![user_id],
            |row: &rusqlite::Row| row.get(0),
        ).unwrap_or("".to_string());
        
        Ok(updated_at)
    }).await.map_err(|_| "task error");

    match result {
        Ok(Ok(updated_at)) => (StatusCode::OK, Json(SyncResponse { success: true, data: None, updated_at: Some(updated_at), error: None })),
        Ok(Err(e)) => (StatusCode::INTERNAL_SERVER_ERROR, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some(e.into()) })),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("internal error".into()) })),
    }
}

pub async fn upload(
    State(state): State<Arc<AppState>>,
    cookies: Cookies,
    Json(payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    let (user_id, _) = match get_current_user(&state, &cookies).await {
        Ok(u) => u,
        Err(_) => return (StatusCode::UNAUTHORIZED, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("unauthorized".into()) })),
    };
    if let Some(obj) = payload.as_object() {
         if obj.len() > 20 {
             return (StatusCode::BAD_REQUEST, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("too many root keys".into()) }));
         }
    } else {
        return (StatusCode::BAD_REQUEST, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("invalid json".into()) }));
    }
    if !check_json_depth(&payload, 0) {
        return (StatusCode::BAD_REQUEST, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("json too deeply nested".into()) }));
    }
    let json_bytes = serde_json::to_vec(&payload).unwrap();
    if json_bytes.len() > MAX_RAW_SIZE {
        return (StatusCode::PAYLOAD_TOO_LARGE, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("payload too large".into()) }));
    }
    let mut compressor = BrotliEncoder::with_quality(Vec::new(), Level::Precise(4));
    if let Err(_) = compressor.write_all(&json_bytes).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("compression failed".into()) }));
    }
    if let Err(_) = compressor.shutdown().await {
         return (StatusCode::INTERNAL_SERVER_ERROR, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("compression failed".into()) }));
    }
    let compressed_data = compressor.into_inner();
    let sync_secret = state.sync_secret.clone();
    let pool = state.pool.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<String, &'static str> {
        use sha2::{Sha256, Digest};
        let mut hasher = Sha256::new();
        hasher.update(sync_secret.as_bytes());
        let key_bytes = hasher.finalize();
        let key = aes_gcm::Key::<Aes256Gcm>::from_slice(&key_bytes);
        let cipher = Aes256Gcm::new(key);
        let mut iv = [0u8; IV_LENGTH];
        OsRng.fill_bytes(&mut iv);
        let nonce = Nonce::from_slice(&iv);
        let encrypted_data = cipher.encrypt(nonce, compressed_data.as_ref())
            .map_err(|_| "encryption failed")?;
        let mut final_blob = Vec::with_capacity(IV_LENGTH + encrypted_data.len());
        final_blob.extend_from_slice(&iv);
        final_blob.extend_from_slice(&encrypted_data);

        if final_blob.len() > 50 * 1024 * 1024 {
            return Err("blob too large");
        }
        let conn = pool.get().map_err(|_| "db pool error")?;
        conn.execute(
            "INSERT OR REPLACE INTO sync_data (user_id, data_blob, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
            params![user_id, final_blob],
        ).map_err(|e| {
            tracing::error!("db error: {}", e); 
            "db error"
        })?;

        let updated_at: String = conn.query_row(
            "SELECT updated_at FROM sync_data WHERE user_id = ?",
            params![user_id],
            |row: &rusqlite::Row| row.get(0),
        ).unwrap_or_default();
        
        Ok(updated_at)
    }).await.map_err(|_| "task error");

    match result {
        Ok(Ok(updated_at)) => (StatusCode::OK, Json(SyncResponse { success: true, data: None, updated_at: Some(updated_at), error: None })),
        Ok(Err(e)) => {
            let status = if e == "blob too large" { StatusCode::PAYLOAD_TOO_LARGE } else { StatusCode::INTERNAL_SERVER_ERROR };
            (status, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some(e.into()) }))
        },
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("internal error".into()) })),
    }
}

pub async fn download(
    State(state): State<Arc<AppState>>,
    cookies: Cookies,
) -> impl IntoResponse {
    let (user_id, _) = match get_current_user(&state, &cookies).await {
        Ok(u) => u,
        Err(_) => return (StatusCode::UNAUTHORIZED, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("unauthorized".into()) })),
    };

    let pool = state.pool.clone();
    let sync_secret = state.sync_secret.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<(Vec<u8>, String), &'static str> {
        let conn = pool.get().map_err(|_| "db pool error")?;
        let row_result: Result<(Vec<u8>, String), _> = conn.query_row(
            "SELECT data_blob, updated_at FROM sync_data WHERE user_id = ?",
            params![user_id],
            |row: &rusqlite::Row| Ok((row.get(0)?, row.get(1)?)),
        );

        match row_result {
            Ok((blob, updated_at)) => {
                if blob.len() < IV_LENGTH {
                     return Err("corrupted data");
                }

                let iv = &blob[..IV_LENGTH];
                let ciphertext = &blob[IV_LENGTH..];
                use sha2::{Sha256, Digest};
                let mut hasher = Sha256::new();
                hasher.update(sync_secret.as_bytes());
                let key_bytes = hasher.finalize();
                let key = aes_gcm::Key::<Aes256Gcm>::from_slice(&key_bytes);
                let cipher = Aes256Gcm::new(key);
                let nonce = Nonce::from_slice(iv);
                let compressed_data = cipher.decrypt(nonce, ciphertext)
                    .map_err(|_| "decryption failed")?;
                
                Ok((compressed_data, updated_at))
            },
            Err(rusqlite::Error::QueryReturnedNoRows) => Err("no data found"),
            Err(_) => Err("db error"),
        }
    }).await.map_err(|_| "task error");

    match result {
        Ok(Ok((compressed_data, updated_at))) => {
            let mut decoder = BrotliDecoder::new(BufReader::new(&compressed_data[..]));
            let mut json_bytes = Vec::new();
            if let Err(_) = decoder.read_to_end(&mut json_bytes).await {
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("decompression failed".into()) }));
            }
            let json_data: serde_json::Value = match serde_json::from_slice(&json_bytes) {
                Ok(j) => j,
                Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("invalid json".into()) })),
            };
            (StatusCode::OK, Json(SyncResponse { success: true, data: Some(json_data), updated_at: Some(updated_at), error: None }))
        },
        Ok(Err("no data found")) => (StatusCode::NOT_FOUND, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("no data found".into()) })),
        Ok(Err(e)) => (StatusCode::INTERNAL_SERVER_ERROR, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some(e.into()) })),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("internal error".into()) })),
    }
}