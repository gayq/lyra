use super::*;
use axum::extract::{
    rejection::{JsonRejection, PathRejection},
    Path,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use std::io::Cursor;

pub const CHUNK_SIZE: usize = 1024 * 1024;
const MANIFEST_MAGIC: &[u8] = b"wcs2";

pub(super) fn manifest_id(blob: &[u8]) -> Option<&str> {
    let id = std::str::from_utf8(blob.strip_prefix(MANIFEST_MAGIC)?).ok()?;
    (id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit())).then_some(id)
}

impl From<rusqlite::Error> for SyncError {
    fn from(_: rusqlite::Error) -> Self {
        Self::Internal
    }
}

pub fn cleanup(connection: &Connection) -> rusqlite::Result<usize> {
    connection.execute(
        "DELETE FROM sync_uploads WHERE committed = 0 AND touched < unixepoch() - 86400",
        [],
    )
}

fn upload_info(connection: &Connection, user_id: i64, id: &str) -> SyncResult<(i64, bool)> {
    connection
        .query_row(
            "SELECT parts, committed FROM sync_uploads WHERE id = ? AND user_id = ?",
            params![id, user_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or(SyncError::Conflict)
}

fn begin_upload(connection: &mut Connection, user_id: i64, parts: i64) -> SyncResult<String> {
    if parts <= 0 {
        return Err(SyncError::InvalidPayload);
    }
    let transaction = connection.transaction()?;
    cleanup(&transaction)?;
    transaction.execute(
        "DELETE FROM sync_uploads WHERE user_id = ? AND committed = 0",
        [user_id],
    )?;
    let id = transaction.query_row(
        "INSERT INTO sync_uploads (id, user_id, parts) VALUES (lower(hex(randomblob(16))), ?, ?) RETURNING id",
        params![user_id, parts], |row| row.get(0),
    )?;
    transaction.commit()?;
    Ok(id)
}

fn chunk_aad(user_id: i64, id: &str, part: i64) -> String {
    format!("{user_id}:{id}:{part}")
}

fn read_chunk(
    connection: &Connection,
    cipher: &Aes256Gcm,
    user_id: i64,
    id: &str,
    part: i64,
) -> SyncResult<Vec<u8>> {
    let blob: Vec<u8> = connection
        .query_row(
            "SELECT data_blob FROM sync_chunks WHERE upload_id = ? AND part = ?",
            params![id, part],
            |row| row.get(0),
        )
        .optional()?
        .ok_or(SyncError::Conflict)?;
    if blob.len() < IV_LENGTH {
        return Err(SyncError::Corrupt);
    }
    let compressed = cipher
        .decrypt(
            Nonce::from_slice(&blob[..IV_LENGTH]),
            Payload {
                msg: &blob[IV_LENGTH..],
                aad: chunk_aad(user_id, id, part).as_bytes(),
            },
        )
        .map_err(|_| SyncError::Corrupt)?;
    let mut bytes = Vec::new();
    brotli::Decompressor::new(compressed.as_slice(), 64 * 1024)
        .take((CHUNK_SIZE + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| SyncError::Corrupt)?;
    if bytes.is_empty() || bytes.len() > CHUNK_SIZE {
        return Err(SyncError::Corrupt);
    }
    Ok(bytes)
}

fn write_chunk(
    connection: &mut Connection,
    cipher: &Aes256Gcm,
    user_id: i64,
    id: &str,
    part: i64,
    bytes: &[u8],
) -> SyncResult<()> {
    if bytes.is_empty() || bytes.len() > CHUNK_SIZE {
        return Err(SyncError::TooLarge);
    }
    let (parts, _) = upload_info(connection, user_id, id)?;
    if part < 0 || part >= parts {
        return Err(SyncError::InvalidPayload);
    }
    let mut compressor = brotli::CompressorWriter::new(Vec::new(), 64 * 1024, 3, 22);
    compressor
        .write_all(bytes)
        .map_err(|_| SyncError::Internal)?;
    let compressed = compressor.into_inner();
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let encrypted = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: &compressed,
                aad: chunk_aad(user_id, id, part).as_bytes(),
            },
        )
        .map_err(|_| SyncError::Internal)?;
    let mut blob = nonce.to_vec();
    blob.extend_from_slice(&encrypted);

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (_, committed) = upload_info(&transaction, user_id, id)?;
    let exists: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM sync_chunks WHERE upload_id = ? AND part = ?)",
        params![id, part],
        |row| row.get(0),
    )?;
    if exists {
        if read_chunk(&transaction, cipher, user_id, id, part)? != bytes {
            return Err(SyncError::Conflict);
        }
    } else {
        if committed {
            return Err(SyncError::Conflict);
        }
        transaction.execute(
            "INSERT INTO sync_chunks VALUES (?, ?, ?)",
            params![id, part, blob],
        )?;
    }
    transaction.execute(
        "UPDATE sync_uploads SET touched = unixepoch() WHERE id = ?",
        [id],
    )?;
    transaction.commit()?;
    Ok(())
}

struct ChunkReader<'a> {
    connection: &'a Connection,
    cipher: &'a Aes256Gcm,
    user_id: i64,
    id: &'a str,
    next: i64,
    parts: i64,
    current: Cursor<Vec<u8>>,
}

impl Read for ChunkReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        if self.current.position() == self.current.get_ref().len() as u64 && self.next < self.parts
        {
            self.current = Cursor::new(
                read_chunk(
                    self.connection,
                    self.cipher,
                    self.user_id,
                    self.id,
                    self.next,
                )
                .map_err(|_| std::io::Error::other("sync chunk is unavailable... /ᐠ - ˕ -マ"))?,
            );
            self.next += 1;
        }
        self.current.read(buffer)
    }
}

pub(super) fn load_snapshot(
    connection: &Connection,
    cipher: &Aes256Gcm,
    user_id: i64,
    id: &str,
) -> SyncResult<Snapshot> {
    let (parts, _) = upload_info(connection, user_id, id)?;
    let count: i64 = connection.query_row(
        "SELECT count(*) FROM sync_chunks WHERE upload_id = ?",
        [id],
        |row| row.get(0),
    )?;
    if count != parts {
        return Err(SyncError::Conflict);
    }
    let reader = ChunkReader {
        connection,
        cipher,
        user_id,
        id,
        next: 0,
        parts,
        current: Cursor::new(Vec::new()),
    };
    let snapshot: Snapshot = serde_json::from_reader(std::io::BufReader::new(reader))
        .map_err(|_| SyncError::Unprocessable)?;
    validate_decoded_snapshot(&snapshot)?;
    Ok(snapshot)
}

fn commit_upload(
    connection: &mut Connection,
    cipher: &Aes256Gcm,
    user_id: i64,
    id: &str,
) -> SyncResult<String> {
    let (_, committed) = upload_info(connection, user_id, id)?;
    if !committed {
        drop(load_snapshot(connection, cipher, user_id, id)?);
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (_, committed) = upload_info(&transaction, user_id, id)?;
    if !committed {
        let mut manifest = MANIFEST_MAGIC.to_vec();
        manifest.extend_from_slice(id.as_bytes());
        transaction.execute(
            "INSERT INTO sync_data (user_id, data_blob, updated_at)
             VALUES (?, ?, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') || '-' || LOWER(HEX(RANDOMBLOB(8))))
             ON CONFLICT(user_id) DO UPDATE SET data_blob = excluded.data_blob, updated_at = excluded.updated_at",
            params![user_id, manifest],
        )?;
        transaction.execute("UPDATE sync_uploads SET committed = 1 WHERE id = ?", [id])?;
        transaction.execute(
            "DELETE FROM sync_uploads WHERE user_id = ? AND id != ?",
            params![user_id, id],
        )?;
    }
    let updated_at = transaction.query_row(
        "SELECT updated_at FROM sync_data WHERE user_id = ?",
        [user_id],
        |row| row.get(0),
    )?;
    transaction.commit()?;
    Ok(updated_at)
}

async fn run(
    state: Arc<AppState>,
    cookies: Cookies,
    work: impl FnOnce(&mut Connection, &Aes256Gcm, i64) -> SyncResult<Response> + Send + 'static,
) -> Response {
    let (user_id, _) = match get_current_user(&state, &cookies).await {
        Ok(user) => user,
        Err(()) => return response(false, None, None, Some(SyncError::Unauthorized)),
    };
    let Some(permit) = state.sync_work.try_acquire() else {
        return response(false, None, None, Some(SyncError::Busy));
    };
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut connection = state.pool.get().map_err(|_| SyncError::Internal)?;
        work(&mut connection, &state.aes_cipher, user_id)
    })
    .await
    .unwrap_or(Err(SyncError::Internal));
    result.unwrap_or_else(|error| response(false, None, None, Some(error)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Start {
    parts: i64,
}

pub async fn begin(
    State(state): State<Arc<AppState>>,
    cookies: Cookies,
    request: Result<Json<Start>, JsonRejection>,
) -> Response {
    run(state, cookies, move |connection, _, user_id| {
        let Json(request) = request.map_err(|_| SyncError::InvalidPayload)?;
        let id = begin_upload(connection, user_id, request.parts)?;
        Ok(Json(serde_json::json!({ "id": id, "chunk_size": CHUNK_SIZE })).into_response())
    })
    .await
}

pub async fn put(
    State(state): State<Arc<AppState>>,
    cookies: Cookies,
    path: Result<Path<(String, i64)>, PathRejection>,
    headers: HeaderMap,
    payload: Result<Bytes, BytesRejection>,
) -> Response {
    run(state, cookies, move |connection, cipher, user_id| {
        let Path((id, part)) = path.map_err(|_| SyncError::InvalidPayload)?;
        let bytes = payload.map_err(|rejection| {
            if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
                SyncError::TooLarge
            } else {
                SyncError::InvalidPayload
            }
        })?;
        let encoding = headers
            .get(CONTENT_ENCODING)
            .map(|value| value.to_str().map_err(|_| SyncError::UnsupportedEncoding))
            .transpose()?
            .unwrap_or("identity");
        let decoded;
        let bytes = if encoding.eq_ignore_ascii_case("gzip") {
            let mut buffer = Vec::new();
            flate2::read::GzDecoder::new(bytes.as_ref())
                .take((CHUNK_SIZE + 1) as u64)
                .read_to_end(&mut buffer)
                .map_err(|_| SyncError::Unprocessable)?;
            decoded = buffer;
            decoded.as_slice()
        } else if encoding.eq_ignore_ascii_case("identity") {
            bytes.as_ref()
        } else {
            return Err(SyncError::UnsupportedEncoding);
        };
        write_chunk(connection, cipher, user_id, &id, part, bytes)?;
        Ok(response(true, None, None, None))
    })
    .await
}

pub async fn commit(
    State(state): State<Arc<AppState>>,
    cookies: Cookies,
    path: Result<Path<String>, PathRejection>,
) -> Response {
    run(state, cookies, move |connection, cipher, user_id| {
        let Path(id) = path.map_err(|_| SyncError::InvalidPayload)?;
        let updated_at = commit_upload(connection, cipher, user_id, &id)?;
        cached_meta_set(user_id, updated_at.clone());
        Ok(response(true, None, Some(updated_at), None))
    })
    .await
}

pub async fn manifest(State(state): State<Arc<AppState>>, cookies: Cookies) -> Response {
    run(state, cookies, |connection, _, user_id| {
        let row: Option<(Vec<u8>, String)> = connection
            .query_row(
                "SELECT substr(data_blob, 1, 36), updated_at FROM sync_data WHERE user_id = ?",
                [user_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (blob, updated_at) = row.ok_or(SyncError::Missing)?;
        let Some(id) = manifest_id(&blob) else {
            return Ok(Json(serde_json::json!({ "legacy": true })).into_response());
        };
        let (parts, committed) = upload_info(connection, user_id, id)?;
        if !committed {
            return Err(SyncError::Corrupt);
        }
        Ok(
            Json(serde_json::json!({ "id": id, "parts": parts, "updated_at": updated_at }))
                .into_response(),
        )
    })
    .await
}

pub async fn get(
    State(state): State<Arc<AppState>>,
    cookies: Cookies,
    path: Result<Path<(String, i64)>, PathRejection>,
) -> Response {
    run(state, cookies, move |connection, cipher, user_id| {
        let Path((id, part)) = path.map_err(|_| SyncError::InvalidPayload)?;
        let (parts, committed) = upload_info(connection, user_id, &id)?;
        if !committed || part < 0 || part >= parts {
            return Err(SyncError::Conflict);
        }
        Ok((
            [(CONTENT_TYPE, "application/octet-stream")],
            read_chunk(connection, cipher, user_id, &id, part)?,
        )
            .into_response())
    })
    .await
}

