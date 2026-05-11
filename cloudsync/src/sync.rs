use axum::{extract::{State, Json}, http::StatusCode, response::IntoResponse};
use tower_cookies::Cookies;
use rusqlite::params;
use serde::Serialize;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Instant;
use dashmap::DashMap;
use aes_gcm::{aead::Aead, Nonce};
use rand::rngs::OsRng;
use rand::RngCore;
use async_compression::Level;
use async_compression::tokio::write::BrotliEncoder;
use async_compression::tokio::bufread::BrotliDecoder;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;
use crate::auth::{get_current_user, AppState};

const IV_LENGTH: usize = 12;
const MAX_JSON_DEPTH: usize = 120;
const MAX_RAW_SIZE: usize = 80 * 1024 * 1024;
const MAX_BLOB_SIZE: usize = 80 * 1024 * 1024;
const MAX_DECOMPRESSED_SIZE: usize = 80 * 1024 * 1024;

static META_CACHE: OnceLock<DashMap<i64, (String, Instant)>> = OnceLock::new();

fn get_meta_cache() -> &'static DashMap<i64, (String, Instant)> {
    META_CACHE.get_or_init(|| DashMap::new())
}

const META_CACHE_TTL_SECS: u64 = 60;

fn cached_meta_get(user_id: i64) -> Option<String> {
    let cache = get_meta_cache();
    if let Some(entry) = cache.get(&user_id) {
        let (updated_at, at) = entry.value();
        if at.elapsed().as_secs() < META_CACHE_TTL_SECS {
            return Some(updated_at.clone());
        }
        drop(entry);
        cache.remove(&user_id);
    }
    None
}

fn cached_meta_set(user_id: i64, updated_at: String) {
    get_meta_cache().insert(user_id, (updated_at, Instant::now()));
}

pub fn cached_meta_invalidate(user_id: i64) {
    get_meta_cache().remove(&user_id);
}

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

fn merge_delta(existing: &mut serde_json::Value, delta: &serde_json::Value) {
    if let Some(delta_ls) = delta.get("localStorage").and_then(|v| v.as_object()) {
        if let Some(existing_ls) = existing.get_mut("localStorage").and_then(|v| v.as_object_mut()) {
            for (key, value) in delta_ls {
                if value.is_null() {
                    existing_ls.remove(key);
                } else {
                    existing_ls.insert(key.clone(), value.clone());
                }
            }
        } else {
            let mut obj = serde_json::Map::new();
            for (key, value) in delta_ls {
                if !value.is_null() {
                    obj.insert(key.clone(), value.clone());
                }
            }
            existing["localStorage"] = serde_json::Value::Object(obj);
        }
    }

    if let Some(delta_idb) = delta.get("indexedDB").and_then(|v| v.as_object()) {
        if let Some(existing_idb) = existing.get_mut("indexedDB").and_then(|v| v.as_object_mut()) {
            for (db_name, db_data) in delta_idb {
                existing_idb.insert(db_name.clone(), db_data.clone());
            }
        } else {
            existing["indexedDB"] = serde_json::to_value(delta_idb).unwrap_or_default();
        }
    }

    if let Some(delta_cookies) = delta.get("cookies").and_then(|v| v.as_str()) {
        existing["cookies"] = serde_json::Value::String(delta_cookies.to_string());
    }
}

pub async fn meta(
    State(state): State<Arc<AppState>>,
    cookies: Cookies,
) -> impl IntoResponse {
    let (user_id, _) = match get_current_user(&state, &cookies).await {
        Ok(u) => u,
        Err(_) => return (StatusCode::UNAUTHORIZED, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("unauthorized".into()) })),
    };

    if let Some(updated_at) = cached_meta_get(user_id) {
        return (StatusCode::OK, Json(SyncResponse { success: true, data: None, updated_at: Some(updated_at), error: None }));
    }

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
        Ok(Ok(updated_at)) => {
            if !updated_at.is_empty() {
                cached_meta_set(user_id, updated_at.clone());
            }
            (StatusCode::OK, Json(SyncResponse { success: true, data: None, updated_at: Some(updated_at), error: None }))
        },
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

    let is_delta = payload.get("_delta").and_then(|v| v.as_bool()).unwrap_or(false);
    let final_payload = if is_delta {
        match merge_delta_with_existing(user_id, &state, &payload).await {
            Ok(merged) => merged,
            Err(resp) => return resp,
        }
    } else {
        if payload.as_object().is_none() {
            return (StatusCode::BAD_REQUEST, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("invalid json".into()) }));
        }
        if !check_json_depth(&payload, 0) {
            return (StatusCode::BAD_REQUEST, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("json too deeply nested".into()) }));
        }
        payload
    };

    let json_str = final_payload.to_string();
    let json_bytes = json_str.as_bytes();
    if json_bytes.len() > MAX_RAW_SIZE {
        return (StatusCode::PAYLOAD_TOO_LARGE, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("payload too large".into()) }));
    }

    let mut compressor = BrotliEncoder::with_quality(Vec::new(), Level::Precise(3));
    if let Err(_) = compressor.write_all(json_bytes).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("compression failed".into()) }));
    }
    if let Err(_) = compressor.shutdown().await {
         return (StatusCode::INTERNAL_SERVER_ERROR, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("compression failed".into()) }));
    }
    let compressed_data = compressor.into_inner();

    let cipher = state.aes_cipher.clone();
    let pool = state.pool.clone();

    let permit = match crate::WRITE_SEMAPHORE.get().expect("semaphore not initialized").acquire().await {
        Ok(p) => p,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("internal error".into()) })),
    };

    let result = tokio::task::spawn_blocking(move || -> Result<String, &'static str> {
        let _permit = permit;
        let mut iv = [0u8; IV_LENGTH];
        OsRng.fill_bytes(&mut iv);
        let nonce = Nonce::from_slice(&iv);
        let encrypted_data = cipher.encrypt(nonce, compressed_data.as_ref())
            .map_err(|_| "encryption failed")?;
        let mut final_blob = Vec::with_capacity(IV_LENGTH + encrypted_data.len());
        final_blob.extend_from_slice(&iv);
        final_blob.extend_from_slice(&encrypted_data);

        if final_blob.len() > MAX_BLOB_SIZE {
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
        Ok(Ok(updated_at)) => {
            cached_meta_set(user_id, updated_at.clone());
            (StatusCode::OK, Json(SyncResponse { success: true, data: None, updated_at: Some(updated_at), error: None }))
        },
        Ok(Err(e)) => {
            let status = if e == "blob too large" { StatusCode::PAYLOAD_TOO_LARGE } else { StatusCode::INTERNAL_SERVER_ERROR };
            (status, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some(e.into()) }))
        },
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("internal error".into()) })),
    }
}

async fn merge_delta_with_existing(
    user_id: i64,
    state: &AppState,
    delta: &serde_json::Value,
) -> Result<serde_json::Value, (StatusCode, Json<SyncResponse>)> {
    let pool = state.pool.clone();
    let cipher = state.aes_cipher.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<Option<(Vec<u8>, String)>, &'static str> {
        let conn = pool.get().map_err(|_| "db pool error")?;
        let row_result: Result<(Vec<u8>, String), _> = conn.query_row(
            "SELECT data_blob, updated_at FROM sync_data WHERE user_id = ?",
            params![user_id],
            |row: &rusqlite::Row| Ok((row.get(0)?, row.get(1)?)),
        );
        match row_result {
            Ok(row) => Ok(Some(row)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(_) => Err("db error"),
        }
    }).await.map_err(|_| "task error");

    let existing_data = match result {
        Ok(Ok(Some((blob, _)))) => {
            if blob.len() < IV_LENGTH {
                return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("corrupted data".into()) })));
            }
            let iv = &blob[..IV_LENGTH];
            let ciphertext = &blob[IV_LENGTH..];
            let nonce = Nonce::from_slice(iv);
            let compressed_data = match cipher.decrypt(nonce, ciphertext) {
                Ok(d) => d,
                Err(_) => return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("decryption failed".into()) }))),
            };

            let mut decoder = BrotliDecoder::new(BufReader::new(&compressed_data[..]));
            let mut json_bytes = Vec::new();
            if decoder.read_to_end(&mut json_bytes).await.is_err() {
                return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("decompression failed".into()) })));
            }
            if json_bytes.len() > MAX_DECOMPRESSED_SIZE {
                return Err((StatusCode::PAYLOAD_TOO_LARGE, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("payload too large".into()) })));
            }
            match serde_json::from_slice::<serde_json::Value>(&json_bytes) {
                Ok(v) => Some(v),
                Err(_) => return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("invalid json".into()) }))),
            }
        },
        Ok(Ok(None)) => {
            None
        },
        Ok(Err(_)) => {
            return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("db error".into()) })));
        },
        Err(_) => {
            return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("internal error".into()) })));
        },
    };

    let mut merged = existing_data.unwrap_or_else(|| {
        let mut map = serde_json::Map::new();
        map.insert("localStorage".to_string(), serde_json::Value::Object(serde_json::Map::new()));
        map.insert("sessionStorage".to_string(), serde_json::Value::Object(serde_json::Map::new()));
        map.insert("indexedDB".to_string(), serde_json::Value::Object(serde_json::Map::new()));
        map.insert("cookies".to_string(), serde_json::Value::String(String::new()));
        serde_json::Value::Object(map)
    });

    merge_delta(&mut merged, delta);

    if !check_json_depth(&merged, 0) {
        return Err((StatusCode::BAD_REQUEST, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("merged json too deeply nested".into()) })));
    }

    Ok(merged)
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
    let cipher = state.aes_cipher.clone();

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
            if json_bytes.len() > MAX_DECOMPRESSED_SIZE {
                return (StatusCode::PAYLOAD_TOO_LARGE, Json(SyncResponse { success: false, data: None, updated_at: None, error: Some("payload too large".into()) }));
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