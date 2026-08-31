use crate::auth::{get_current_user, AppState};
use aes_gcm::{
    aead::{Aead, AeadCore, Payload},
    Aes256Gcm, Nonce,
};
use axum::{
    body::Bytes,
    extract::{rejection::BytesRejection, Json, State},
    http::{
        header::{CONTENT_ENCODING, CONTENT_TYPE},
        HeaderMap, StatusCode,
    },
    response::{IntoResponse, Response},
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use dashmap::DashMap;
use rand::rngs::OsRng;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    sync::{Arc, OnceLock},
    time::Instant,
};
use tower_cookies::Cookies;

const SCHEMA_VERSION: u64 = 3;
const LEGACY_STRUCTURED_SCHEMA_VERSION: u64 = 2;
const IV_LENGTH: usize = 12;
const BLOB_MAGIC: &[u8; 4] = b"wcs1";
const MAX_JSON_DEPTH: usize = 120;
const MAX_RAW_SIZE: usize = 80 * 1024 * 1024;
const MAX_BLOB_SIZE: usize = 80 * 1024 * 1024;
const MAX_DECOMPRESSED_SIZE: usize = 80 * 1024 * 1024;
const META_CACHE_TTL_SECS: u64 = 60;
const META_CACHE_MAX_ENTRIES: usize = 10_000;
const NEGATIVE: &str = "... /ᐠ - ˕ -マ";

static META_CACHE: OnceLock<DashMap<i64, (String, Instant)>> = OnceLock::new();

#[derive(Serialize)]
struct SyncResponse {
    success: bool,
    data: Option<Value>,
    updated_at: Option<String>,
    code: Option<&'static str>,
    error: Option<String>,
}

#[derive(Serialize)]
struct DownloadResponse {
    success: bool,
    data: Snapshot,
    updated_at: String,
    code: Option<&'static str>,
    error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SyncError {
    Unauthorized,
    InvalidPayload,
    UnsupportedMediaType,
    UnsupportedEncoding,
    Unprocessable,
    TooDeep,
    TooLarge,
    Missing,
    Corrupt,
    Busy,
    Internal,
}

impl SyncError {
    fn status(self) -> StatusCode {
        match self {
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::InvalidPayload | Self::TooDeep => StatusCode::BAD_REQUEST,
            Self::UnsupportedMediaType | Self::UnsupportedEncoding => {
                StatusCode::UNSUPPORTED_MEDIA_TYPE
            }
            Self::Unprocessable => StatusCode::UNPROCESSABLE_ENTITY,
            Self::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::Missing => StatusCode::NOT_FOUND,
            Self::Busy => StatusCode::SERVICE_UNAVAILABLE,
            Self::Corrupt | Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    fn code(self) -> &'static str {
        match self {
            Self::Unauthorized => "unauthorized",
            Self::InvalidPayload => "invalid_sync_payload",
            Self::UnsupportedMediaType => "invalid_sync_content_type",
            Self::UnsupportedEncoding => "invalid_sync_content_encoding",
            Self::Unprocessable => "invalid_sync_payload",
            Self::TooDeep => "sync_payload_too_deep",
            Self::TooLarge => "sync_payload_too_large",
            Self::Missing => "sync_data_not_found",
            Self::Corrupt => "sync_data_unavailable",
            Self::Busy => "sync_service_busy",
            Self::Internal => "sync_service_unavailable",
        }
    }

    fn message(self) -> String {
        let message = match self {
            Self::Unauthorized => "unauthorized",
            Self::InvalidPayload => "invalid sync payload",
            Self::UnsupportedMediaType => "sync content type is unsupported",
            Self::UnsupportedEncoding => "sync content encoding is unsupported",
            Self::Unprocessable => "invalid sync payload",
            Self::TooDeep => "sync payload is too deeply nested",
            Self::TooLarge => "sync payload is too large",
            Self::Missing => "no synced data found",
            Self::Corrupt => "synced data is unavailable",
            Self::Busy => "sync service is busy",
            Self::Internal => "sync service is unavailable",
        };
        format!("{message}{NEGATIVE}")
    }
}

type SyncResult<T> = Result<T, SyncError>;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Snapshot {
    schema_version: u64,
    local_storage: HashMap<String, String>,
    session_storage: HashMap<String, String>,
    cookies: CookiePayload,
    #[serde(rename = "indexedDB")]
    indexed_db: HashMap<String, Database>,
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum CookiePayload {
    Legacy(HashMap<String, String>),
    Current(Vec<SyncCookie>),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncCookie {
    name: String,
    value: String,
    domain: Option<String>,
    path: String,
    expires: Option<f64>,
    same_site: String,
    secure: bool,
    partitioned: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Database {
    stores: HashMap<String, Store>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Store {
    key_path: Value,
    auto_increment: bool,
    indexes: HashMap<String, Index>,
    records: Vec<Record>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Index {
    key_path: Value,
    unique: bool,
    multi_entry: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    key: Value,
    value: Value,
}

fn response(
    success: bool,
    data: Option<Value>,
    updated_at: Option<String>,
    error: Option<SyncError>,
) -> Response {
    let status = error.map_or(StatusCode::OK, SyncError::status);
    (
        status,
        Json(SyncResponse {
            success,
            data,
            updated_at,
            code: error.map(SyncError::code),
            error: error.map(SyncError::message),
        }),
    )
        .into_response()
}

fn get_meta_cache() -> &'static DashMap<i64, (String, Instant)> {
    META_CACHE.get_or_init(DashMap::new)
}

fn cached_meta_get(user_id: i64) -> Option<String> {
    let cache = get_meta_cache();
    if let Some(entry) = cache.get(&user_id) {
        let (updated_at, created_at) = entry.value();
        if created_at.elapsed().as_secs() < META_CACHE_TTL_SECS {
            return Some(updated_at.clone());
        }
        drop(entry);
        cache.remove(&user_id);
    }
    None
}

fn cached_meta_set(user_id: i64, updated_at: String) {
    let cache = get_meta_cache();
    if cache.len() >= META_CACHE_MAX_ENTRIES {
        let evicted = cache.iter().next().map(|entry| *entry.key());
        if let Some(user_id) = evicted {
            cache.remove(&user_id);
        }
    }
    cache.insert(user_id, (updated_at, Instant::now()));
}

pub fn cached_meta_invalidate(user_id: i64) {
    get_meta_cache().remove(&user_id);
}

fn check_json_depth(value: &Value, depth: usize) -> bool {
    if depth > MAX_JSON_DEPTH {
        return false;
    }
    match value {
        Value::Object(map) => map.values().all(|entry| check_json_depth(entry, depth + 1)),
        Value::Array(entries) => entries
            .iter()
            .all(|entry| check_json_depth(entry, depth + 1)),
        _ => true,
    }
}

fn normalized_parts(name: &str) -> Vec<String> {
    let mut separated = String::with_capacity(name.len());
    let mut previous = None;
    for character in name.chars() {
        if character.is_ascii_uppercase()
            && previous
                .is_some_and(|value: char| value.is_ascii_lowercase() || value.is_ascii_digit())
        {
            separated.push('_');
        }
        if character.is_ascii_alphanumeric() {
            separated.push(character.to_ascii_lowercase());
        } else {
            separated.push('_');
        }
        previous = Some(character);
    }
    separated
        .split('_')
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect()
}

fn sensitive_name(name: &str) -> bool {
    let trimmed = name.trim();
    let normalized = trimmed.to_ascii_lowercase();
    if normalized.is_empty() {
        return false;
    }
    let leaf = normalized.rsplit('@').next().unwrap_or(&normalized);
    let original_leaf = trimmed.rsplit('@').next().unwrap_or(trimmed);
    if matches!(
        leaf,
        "auth_user" | "auth_token" | "lyra-sync-meta" | "__lyra_folio_session"
    ) {
        return true;
    }
    let compact = leaf.replace(['-', '_'], "");
    if [
        "accesstoken",
        "refreshtoken",
        "identitytoken",
        "idtoken",
        "authtoken",
        "sessiontoken",
        "apitoken",
        "apikey",
        "privatekey",
        "csrftoken",
        "xsrftoken",
        "oauthtoken",
    ]
    .iter()
    .any(|part| compact.contains(part))
    {
        return true;
    }
    normalized_parts(original_leaf).into_iter().any(|part| {
        matches!(
            part.as_str(),
            "password"
                | "passwd"
                | "secret"
                | "credential"
                | "credentials"
                | "auth"
                | "authorization"
                | "bearer"
                | "cookie"
                | "csrf"
                | "oauth"
                | "token"
                | "jwt"
                | "session"
                | "sessionid"
                | "xsrf"
        )
    })
}

fn site_storage_name(name: &str) -> bool {
    name.rsplit_once('@')
        .is_some_and(|(scope, key)| !scope.is_empty() && !key.is_empty())
}

fn site_database_name(name: &str) -> bool {
    name.rsplit_once('@').is_some_and(|(origin, database)| {
        !database.is_empty()
            && (origin
                .get(..8)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
                || origin
                    .get(..7)
                    .is_some_and(|prefix| prefix.eq_ignore_ascii_case("http://")))
    })
}

fn allows_sensitive_database(name: &str) -> bool {
    matches!(name, "__folio_controller" | "rivet_extensions") || site_database_name(name)
}

fn looks_like_jwt(value: &str) -> bool {
    let mut parts = value.trim().split('.');
    let (Some(header), Some(payload), Some(signature)) = (parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    parts.next().is_none()
        && header.starts_with("eyJ")
        && payload.starts_with("eyJ")
        && [header, payload, signature].iter().all(|part| {
            part.len() >= 8
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        })
}

fn looks_like_provider_credential(value: &str) -> bool {
    let trimmed = value.trim();
    let lower = trimmed.to_ascii_lowercase();
    let authorization = ["bearer ", "basic "].iter().any(|prefix| {
        lower
            .strip_prefix(prefix)
            .is_some_and(|token| token.len() >= 8)
    });
    let private_key = lower.contains("-----begin ") && lower.contains("private key-----");
    let password_hash = trimmed.starts_with("$2") || trimmed.starts_with("$argon2");
    let provider_prefix = [
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "github_pat_",
        "xoxb-",
        "xoxa-",
        "xoxp-",
        "xoxr-",
        "xoxs-",
        "sk_live_",
        "sk_test_",
    ]
    .iter()
    .any(|prefix| trimmed.starts_with(prefix) && trimmed.len() >= prefix.len() + 12);
    let aws_key = trimmed.len() == 20
        && trimmed.starts_with("AKIA")
        && trimmed
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit());
    authorization || private_key || password_hash || provider_prefix || aws_key
}

fn contains_credential_text(value: &str) -> bool {
    if looks_like_jwt(value) || looks_like_provider_credential(value) {
        return true;
    }
    let lower = value.to_ascii_lowercase();
    if lower.contains("-----begin ") && lower.contains("private key-----") {
        return true;
    }
    if [
        "$2a$",
        "$2b$",
        "$2y$",
        "$argon2id$",
        "$argon2i$",
        "$argon2d$",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        return true;
    }
    if [
        "\"access_token\"",
        "\"accesstoken\"",
        "\"refresh_token\"",
        "\"refreshtoken\"",
        "\"auth_token\"",
        "\"authtoken\"",
        "\"session_token\"",
        "\"sessiontoken\"",
        "\"api_key\"",
        "\"apikey\"",
        "\"private_key\"",
        "\"privatekey\"",
        "\"password\"",
        "\"passwd\"",
        "\"secret\"",
        "\"authorization\"",
        "\"credential\"",
        "\"jwt\"",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        return true;
    }
    if ["bearer ", "basic "].iter().any(|prefix| {
        lower.match_indices(prefix).any(|(index, _)| {
            lower[index + prefix.len()..]
                .chars()
                .take_while(|character| {
                    character.is_ascii_alphanumeric()
                        || matches!(character, '+' | '/' | '_' | '-' | '=')
                })
                .count()
                >= 8
        })
    }) {
        return true;
    }
    if [
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "github_pat_",
        "xoxb-",
        "xoxa-",
        "xoxp-",
        "xoxr-",
        "xoxs-",
        "sk_live_",
        "sk_test_",
        "akia",
    ]
    .iter()
    .any(|prefix| {
        lower.match_indices(prefix).any(|(index, _)| {
            lower[index..]
                .chars()
                .take_while(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
                })
                .count()
                >= prefix.len() + 12
        })
    }) {
        return true;
    }
    value
        .split(|character: char| {
            !(character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'))
        })
        .any(looks_like_jwt)
}

fn safe_encoded_bytes(value: &str) -> bool {
    const CHUNK_SIZE: usize = 64 * 1024;
    const OVERLAP: usize = 512;
    if !value.len().is_multiple_of(4)
        || value
            .find('=')
            .is_some_and(|index| index < value.len().saturating_sub(2))
    {
        return false;
    }
    let mut carry = Vec::new();
    for chunk in value.as_bytes().chunks(CHUNK_SIZE) {
        let Ok(decoded) = STANDARD.decode(chunk) else {
            return false;
        };
        let mut scanned = Vec::with_capacity(carry.len() + decoded.len());
        scanned.extend_from_slice(&carry);
        scanned.extend_from_slice(&decoded);
        if contains_credential_text(String::from_utf8_lossy(&scanned).as_ref()) {
            return false;
        }
        carry = scanned[scanned.len().saturating_sub(OVERLAP)..].to_vec();
    }
    true
}

fn contains_sensitive_json(value: &Value) -> bool {
    match value {
        Value::String(value) => sensitive_text(value, false),
        Value::Array(values) => values.iter().any(contains_sensitive_json),
        Value::Object(values) => values
            .iter()
            .any(|(key, value)| sensitive_name(key) || contains_sensitive_json(value)),
        _ => false,
    }
}

fn sensitive_text(value: &str, inspect_json: bool) -> bool {
    if contains_credential_text(value) {
        return true;
    }
    if !inspect_json || value.len() > 1024 * 1024 {
        return false;
    }
    let trimmed = value.trim();
    if !((trimmed.starts_with('{') && trimmed.ends_with('}'))
        || (trimmed.starts_with('[') && trimmed.ends_with(']')))
    {
        return false;
    }
    serde_json::from_str::<Value>(trimmed)
        .ok()
        .is_some_and(|parsed| contains_sensitive_json(&parsed))
}

fn valid_cookie_text(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| (0x21..=0x7e).contains(&byte) && !matches!(byte, b'"' | b';' | b',' | b'\\'))
}

fn valid_cookie(cookie: &SyncCookie) -> bool {
    let valid_name = !cookie.name.is_empty()
        && cookie.name.len() <= 256
        && cookie.name.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        });
    let valid_domain = cookie.domain.as_ref().is_none_or(|domain| {
        !domain.is_empty()
            && domain.len() <= 253
            && !domain.contains("..")
            && domain
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
    });
    let valid_path = cookie.path.starts_with('/')
        && cookie.path.len() <= 1024
        && !cookie
            .path
            .bytes()
            .any(|byte| byte == b';' || byte < 0x20 || byte == 0x7f);
    let valid_expiry = cookie
        .expires
        .is_none_or(|expires| expires.is_finite() && (0.0..=8.64e15).contains(&expires));
    valid_name
        && !sensitive_name(&cookie.name)
        && !cookie.name.starts_with("__Http-")
        && !cookie.name.starts_with("__Host-Http-")
        && cookie.value.len() <= 4096
        && valid_cookie_text(&cookie.value)
        && !sensitive_text(&cookie.value, true)
        && valid_domain
        && valid_path
        && valid_expiry
        && matches!(cookie.same_site.as_str(), "strict" | "lax" | "none")
        && (cookie.same_site != "none" || cookie.secure)
        && (!cookie.partitioned || cookie.secure)
        && (!cookie.name.starts_with("__Secure-") || cookie.secure)
        && (!cookie.name.starts_with("__Host-")
            || (cookie.secure && cookie.domain.is_none() && cookie.path == "/"))
}

fn exact_fields(map: &serde_json::Map<String, Value>, fields: &[&str]) -> bool {
    map.len() == fields.len() && fields.iter().all(|field| map.contains_key(*field))
}

fn take_id(map: &serde_json::Map<String, Value>, ids: &mut HashSet<u64>) -> Option<u64> {
    let id = map.get("id")?.as_u64()?;
    if id == 0 || !ids.insert(id) {
        return None;
    }
    Some(id)
}

fn valid_key_path(value: &Value) -> bool {
    value.is_null()
        || value.is_string()
        || value
            .as_array()
            .is_some_and(|entries| entries.iter().all(Value::is_string))
}

fn valid_encoded(value: &Value, ids: &mut HashSet<u64>, allow_sensitive: bool) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    let Some(kind) = map.get("type").and_then(Value::as_str) else {
        return false;
    };
    match kind {
        "null" | "undefined" => exact_fields(map, &["type"]),
        "boolean" => {
            exact_fields(map, &["type", "value"]) && map.get("value").is_some_and(Value::is_boolean)
        }
        "string" => {
            exact_fields(map, &["type", "value"])
                && map
                    .get("value")
                    .and_then(Value::as_str)
                    .is_some_and(|value| allow_sensitive || !sensitive_text(value, true))
        }
        "bigint" => {
            exact_fields(map, &["type", "value"])
                && map
                    .get("value")
                    .and_then(Value::as_str)
                    .is_some_and(|number| {
                        let digits = number.strip_prefix('-').unwrap_or(number);
                        !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
                    })
        }
        "number" => {
            exact_fields(map, &["type", "value"])
                && map.get("value").is_some_and(|number| {
                    number.is_number()
                        || matches!(
                            number.as_str(),
                            Some("nan" | "infinity" | "-infinity" | "-0")
                        )
                })
        }
        "reference" => {
            exact_fields(map, &["type", "value"])
                && map
                    .get("value")
                    .and_then(Value::as_u64)
                    .is_some_and(|id| ids.contains(&id))
        }
        "date" => {
            exact_fields(map, &["type", "id", "value"])
                && take_id(map, ids).is_some()
                && map.get("value").is_some_and(Value::is_string)
        }
        "array_buffer" => {
            exact_fields(map, &["type", "id", "value"])
                && take_id(map, ids).is_some()
                && map
                    .get("value")
                    .and_then(Value::as_str)
                    .is_some_and(|value| allow_sensitive || safe_encoded_bytes(value))
        }
        "regexp" => {
            if !exact_fields(map, &["type", "id", "value"]) || take_id(map, ids).is_none() {
                return false;
            }
            map.get("value")
                .and_then(Value::as_object)
                .is_some_and(|regexp| {
                    exact_fields(regexp, &["source", "flags"])
                        && regexp.get("source").is_some_and(Value::is_string)
                        && regexp.get("flags").is_some_and(Value::is_string)
                })
        }
        "array" | "set" => {
            if !exact_fields(map, &["type", "id", "value"]) || take_id(map, ids).is_none() {
                return false;
            }
            map.get("value")
                .and_then(Value::as_array)
                .is_some_and(|entries| {
                    entries
                        .iter()
                        .all(|entry| valid_encoded(entry, ids, allow_sensitive))
                })
        }
        "object" => {
            if !exact_fields(map, &["type", "id", "value"]) || take_id(map, ids).is_none() {
                return false;
            }
            map.get("value")
                .and_then(Value::as_object)
                .is_some_and(|entries| {
                    entries.iter().all(|(key, entry)| {
                        (allow_sensitive || !sensitive_name(key))
                            && valid_encoded(entry, ids, allow_sensitive)
                    })
                })
        }
        "map" => {
            if !exact_fields(map, &["type", "id", "value"]) || take_id(map, ids).is_none() {
                return false;
            }
            map.get("value")
                .and_then(Value::as_array)
                .is_some_and(|entries| {
                    entries.iter().all(|entry| {
                        entry.as_array().is_some_and(|pair| {
                            pair.len() == 2
                                && encoded_string(&pair[0])
                                    .is_none_or(|key| allow_sensitive || !sensitive_name(key))
                                && valid_encoded(&pair[0], ids, allow_sensitive)
                                && valid_encoded(&pair[1], ids, allow_sensitive)
                        })
                    })
                })
        }
        "typed_array" => {
            if !exact_fields(map, &["type", "id", "value"]) || take_id(map, ids).is_none() {
                return false;
            }
            map.get("value")
                .and_then(Value::as_object)
                .is_some_and(|typed| {
                    exact_fields(typed, &["name", "buffer", "byteOffset", "length"])
                        && typed
                            .get("name")
                            .and_then(Value::as_str)
                            .is_some_and(|name| {
                                matches!(
                                    name,
                                    "DataView"
                                        | "Int8Array"
                                        | "Uint8Array"
                                        | "Uint8ClampedArray"
                                        | "Int16Array"
                                        | "Uint16Array"
                                        | "Int32Array"
                                        | "Uint32Array"
                                        | "Float32Array"
                                        | "Float64Array"
                                        | "BigInt64Array"
                                        | "BigUint64Array"
                                )
                            })
                        && typed.get("byteOffset").and_then(Value::as_u64).is_some()
                        && typed.get("length").and_then(Value::as_u64).is_some()
                        && typed
                            .get("buffer")
                            .is_some_and(|buffer| valid_encoded(buffer, ids, allow_sensitive))
                })
        }
        "blob" => {
            if !exact_fields(map, &["type", "id", "value"]) || take_id(map, ids).is_none() {
                return false;
            }
            map.get("value")
                .and_then(Value::as_object)
                .is_some_and(|blob| {
                    exact_fields(blob, &["mediaType", "bytes"])
                        && blob.get("mediaType").is_some_and(Value::is_string)
                        && blob
                            .get("bytes")
                            .and_then(Value::as_str)
                            .is_some_and(|value| allow_sensitive || safe_encoded_bytes(value))
                })
        }
        "file" => {
            if !exact_fields(map, &["type", "id", "value"]) || take_id(map, ids).is_none() {
                return false;
            }
            map.get("value")
                .and_then(Value::as_object)
                .is_some_and(|file| {
                    exact_fields(file, &["name", "mediaType", "lastModified", "bytes"])
                        && file.get("name").is_some_and(Value::is_string)
                        && file.get("mediaType").is_some_and(Value::is_string)
                        && file.get("lastModified").and_then(Value::as_u64).is_some()
                        && file
                            .get("bytes")
                            .and_then(Value::as_str)
                            .is_some_and(|value| allow_sensitive || safe_encoded_bytes(value))
                })
        }
        _ => false,
    }
}

fn encoded_string(value: &Value) -> Option<&str> {
    let map = value.as_object()?;
    (map.get("type")?.as_str()? == "string")
        .then(|| map.get("value")?.as_str())
        .flatten()
}

fn valid_folio_cookie(cookie: &Value, allow_sensitive: bool) -> bool {
    let Some(cookie) = cookie.as_object() else {
        return false;
    };
    let Some(name) = cookie.get("name").and_then(Value::as_str) else {
        return false;
    };
    let Some(value) = cookie.get("value").and_then(Value::as_str) else {
        return false;
    };
    if name.len() > 256 || value.len() > 4096 || cookie.len() > 32 {
        return false;
    }
    if cookie
        .get("domain")
        .is_none_or(|domain| domain.as_str().is_some_and(|value| value.len() <= 253))
        && cookie.get("path").is_none_or(|path| {
            path.as_str()
                .is_some_and(|value| value.starts_with('/') && value.len() <= 1024)
        })
        && cookie
            .get("sameSite")
            .is_none_or(|same_site| same_site.as_str().is_some_and(|value| value.len() <= 64))
        && ["hostOnly", "secure", "httpOnly", "partitioned"]
            .iter()
            .all(|field| cookie.get(*field).is_none_or(Value::is_boolean))
        && ["expires", "maxAge"]
            .iter()
            .all(|field| cookie.get(*field).is_none_or(Value::is_number))
        && cookie.iter().all(|(key, value)| {
            key.len() <= 256
                && (value.is_null() || value.is_string() || value.is_boolean() || value.is_number())
        })
        && (allow_sensitive
            || (cookie.get("httpOnly").and_then(Value::as_bool) != Some(true)
                && !sensitive_name(name)
                && !sensitive_text(value, true)))
    {
        return true;
    }
    false
}

fn validate_folio_cookies(record: &Record, allow_sensitive: bool) -> bool {
    if encoded_string(&record.key) != Some("cookies") {
        return true;
    }
    let Some(value) = record.value.as_object() else {
        return false;
    };
    let Some(fields) = value.get("value").and_then(Value::as_object) else {
        return false;
    };
    let Some(cookie_dump) = fields.get("cookies").and_then(encoded_string) else {
        return false;
    };
    let Ok(cookies) = serde_json::from_str::<HashMap<String, Value>>(cookie_dump) else {
        return false;
    };
    cookies.len() <= 20_000
        && cookies
            .iter()
            .all(|(id, cookie)| id.len() <= 2048 && valid_folio_cookie(cookie, allow_sensitive))
}

fn validate_raw_size(size: usize) -> SyncResult<()> {
    (size <= MAX_RAW_SIZE)
        .then_some(())
        .ok_or(SyncError::TooLarge)
}

fn decode_upload_payload(headers: &HeaderMap, payload: &[u8]) -> SyncResult<Snapshot> {
    let encoding = headers
        .get(CONTENT_ENCODING)
        .map(|value| value.to_str().map_err(|_| SyncError::UnsupportedEncoding))
        .transpose()?
        .unwrap_or("identity")
        .trim();
    let decoded;
    let payload = if encoding.eq_ignore_ascii_case("identity") || encoding.is_empty() {
        validate_raw_size(payload.len())?;
        payload
    } else if encoding.eq_ignore_ascii_case("gzip") {
        let decoder = flate2::read::GzDecoder::new(payload);
        let mut limited = decoder.take((MAX_RAW_SIZE + 1) as u64);
        decoded = {
            let mut bytes = Vec::new();
            limited
                .read_to_end(&mut bytes)
                .map_err(|_| SyncError::Unprocessable)?;
            validate_raw_size(bytes.len())?;
            bytes
        };
        decoded.as_slice()
    } else {
        return Err(SyncError::UnsupportedEncoding);
    };
    let snapshot =
        serde_json::from_slice::<Snapshot>(payload).map_err(|_| SyncError::Unprocessable)?;
    validate_decoded_snapshot(&snapshot)?;
    Ok(snapshot)
}

fn validate_decoded_snapshot(snapshot: &Snapshot) -> SyncResult<()> {
    let include_sensitive = snapshot.schema_version == SCHEMA_VERSION;
    for values in [&snapshot.local_storage, &snapshot.session_storage] {
        if values.iter().any(|(key, value)| {
            let allow_sensitive = include_sensitive && site_storage_name(key);
            !allow_sensitive && (sensitive_name(key) || sensitive_text(value, true))
        }) {
            return Err(SyncError::InvalidPayload);
        }
    }
    match (snapshot.schema_version, &snapshot.cookies) {
        (1, CookiePayload::Legacy(cookies)) => {
            if cookies.iter().any(|(name, value)| {
                sensitive_name(name) || sensitive_text(value, true) || !valid_cookie_text(value)
            }) {
                return Err(SyncError::InvalidPayload);
            }
        }
        (LEGACY_STRUCTURED_SCHEMA_VERSION | SCHEMA_VERSION, CookiePayload::Current(cookies)) => {
            if cookies.len() > 1024 || cookies.iter().any(|cookie| !valid_cookie(cookie)) {
                return Err(SyncError::InvalidPayload);
            }
            let mut identities = HashSet::new();
            for cookie in cookies {
                let identity = (
                    cookie.name.clone(),
                    cookie
                        .domain
                        .as_ref()
                        .map(|domain| domain.to_ascii_lowercase()),
                    cookie.path.clone(),
                    cookie.partitioned,
                );
                if !identities.insert(identity) {
                    return Err(SyncError::InvalidPayload);
                }
            }
        }
        _ => return Err(SyncError::InvalidPayload),
    }
    for (database_name, database) in &snapshot.indexed_db {
        let allow_sensitive = include_sensitive && allows_sensitive_database(database_name);
        if !allow_sensitive && sensitive_name(database_name) {
            return Err(SyncError::InvalidPayload);
        }
        for (store_name, store) in &database.stores {
            if (!allow_sensitive && sensitive_name(store_name))
                || !valid_key_path(&store.key_path)
                || (store.auto_increment && store.key_path.is_array())
            {
                return Err(SyncError::InvalidPayload);
            }
            for (index_name, index) in &store.indexes {
                if (!allow_sensitive && sensitive_name(index_name))
                    || !valid_key_path(&index.key_path)
                    || index.key_path.is_null()
                    || (index.multi_entry && index.key_path.is_array())
                {
                    return Err(SyncError::InvalidPayload);
                }
                let _ = index.unique;
            }
            for record in &store.records {
                if !check_json_depth(&record.key, 6) || !check_json_depth(&record.value, 6) {
                    return Err(SyncError::TooDeep);
                }
                let mut key_ids = HashSet::new();
                let mut value_ids = HashSet::new();
                if !valid_encoded(&record.key, &mut key_ids, allow_sensitive)
                    || !valid_encoded(&record.value, &mut value_ids, allow_sensitive)
                    || (!allow_sensitive && encoded_string(&record.key).is_some_and(sensitive_name))
                    || (database_name == "__folio_controller"
                        && store_name == "state"
                        && !validate_folio_cookies(record, allow_sensitive))
                {
                    return Err(SyncError::InvalidPayload);
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
fn validate_snapshot(payload: &Value) -> SyncResult<()> {
    validate_raw_size(payload.to_string().len())?;
    if !check_json_depth(payload, 0) {
        return Err(SyncError::TooDeep);
    }
    let snapshot: Snapshot =
        serde_json::from_value(payload.clone()).map_err(|_| SyncError::InvalidPayload)?;
    validate_decoded_snapshot(&snapshot)
}

struct LimitedWriter<W> {
    inner: W,
    written: usize,
    too_large: bool,
}

impl<W: Write> Write for LimitedWriter<W> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        if buffer.len() > MAX_RAW_SIZE.saturating_sub(self.written) {
            self.too_large = true;
            return Err(std::io::Error::other(
                "sync payload is too large... /ᐠ - ˕ -マ",
            ));
        }
        let written = self.inner.write(buffer)?;
        self.written += written;
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

fn compress_payload<T: Serialize + ?Sized>(payload: &T) -> SyncResult<Vec<u8>> {
    let compressor = brotli::CompressorWriter::new(Vec::new(), 64 * 1024, 3, 22);
    let mut writer = LimitedWriter {
        inner: compressor,
        written: 0,
        too_large: false,
    };
    if serde_json::to_writer(&mut writer, payload).is_err() {
        return Err(if writer.too_large {
            SyncError::TooLarge
        } else {
            SyncError::InvalidPayload
        });
    }
    writer.flush().map_err(|_| SyncError::Internal)?;
    Ok(writer.inner.into_inner())
}

fn decompress_payload(compressed: &[u8]) -> SyncResult<Snapshot> {
    let decoder = brotli::Decompressor::new(compressed, 64 * 1024);
    let mut limited = decoder.take((MAX_DECOMPRESSED_SIZE + 1) as u64);
    let snapshot = serde_json::from_reader::<_, Snapshot>(&mut limited);
    if limited.limit() == 0 {
        return Err(SyncError::TooLarge);
    }
    let snapshot = snapshot.map_err(|_| SyncError::Corrupt)?;
    validate_decoded_snapshot(&snapshot).map_err(|_| SyncError::Corrupt)?;
    Ok(snapshot)
}

fn encrypt_blob(cipher: &Aes256Gcm, user_id: i64, compressed: &[u8]) -> SyncResult<Vec<u8>> {
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let aad = user_id.to_be_bytes();
    let encrypted = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: compressed,
                aad: &aad,
            },
        )
        .map_err(|_| SyncError::Internal)?;
    let mut blob = Vec::with_capacity(BLOB_MAGIC.len() + IV_LENGTH + encrypted.len());
    blob.extend_from_slice(BLOB_MAGIC);
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&encrypted);
    (blob.len() <= MAX_BLOB_SIZE)
        .then_some(blob)
        .ok_or(SyncError::TooLarge)
}

fn decrypt_blob(cipher: &Aes256Gcm, user_id: i64, blob: &[u8]) -> SyncResult<(Vec<u8>, bool)> {
    if blob.starts_with(BLOB_MAGIC) {
        if blob.len() < BLOB_MAGIC.len() + IV_LENGTH {
            return Err(SyncError::Corrupt);
        }
        let nonce_start = BLOB_MAGIC.len();
        let ciphertext_start = nonce_start + IV_LENGTH;
        let nonce = Nonce::from_slice(&blob[nonce_start..ciphertext_start]);
        let aad = user_id.to_be_bytes();
        return cipher
            .decrypt(
                nonce,
                Payload {
                    msg: &blob[ciphertext_start..],
                    aad: &aad,
                },
            )
            .map(|plaintext| (plaintext, false))
            .map_err(|_| SyncError::Corrupt);
    }
    if blob.len() < IV_LENGTH {
        return Err(SyncError::Corrupt);
    }
    let nonce = Nonce::from_slice(&blob[..IV_LENGTH]);
    cipher
        .decrypt(nonce, &blob[IV_LENGTH..])
        .map(|plaintext| (plaintext, true))
        .map_err(|_| SyncError::Corrupt)
}

async fn store_payload_for_user<T: Serialize + Send + 'static>(
    state: &AppState,
    user_id: i64,
    payload: T,
) -> SyncResult<String> {
    let cipher = state.aes_cipher.clone();
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || -> SyncResult<String> {
        let compressed = compress_payload(&payload)?;
        let blob = encrypt_blob(&cipher, user_id, &compressed)?;
        let connection = pool.get().map_err(|_| SyncError::Internal)?;
        connection
            .execute(
                "INSERT INTO sync_data (user_id, data_blob, updated_at)
                 VALUES (?, ?, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') || '-' || LOWER(HEX(RANDOMBLOB(8))))
                 ON CONFLICT(user_id) DO UPDATE SET
                    data_blob = excluded.data_blob,
                    updated_at = excluded.updated_at",
                params![user_id, blob],
            )
            .map_err(|error| {
                tracing::error!("sync database write failed: {error}{NEGATIVE}");
                SyncError::Internal
            })?;
        connection
            .query_row(
                "SELECT updated_at FROM sync_data WHERE user_id = ?",
                params![user_id],
                |row| row.get(0),
            )
            .map_err(|_| SyncError::Internal)
    })
    .await
    .map_err(|_| SyncError::Internal)?
}

async fn load_payload_for_user(state: &AppState, user_id: i64) -> SyncResult<(Snapshot, String)> {
    let pool = state.pool.clone();
    let cipher = state.aes_cipher.clone();
    tokio::task::spawn_blocking(move || {
        let connection = pool.get().map_err(|_| SyncError::Internal)?;
        let result: Result<(Vec<u8>, String), rusqlite::Error> = connection.query_row(
            "SELECT data_blob, updated_at FROM sync_data WHERE user_id = ?",
            params![user_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        );
        let (blob, updated_at) = match result {
            Ok(row) => row,
            Err(rusqlite::Error::QueryReturnedNoRows) => return Err(SyncError::Missing),
            Err(_) => return Err(SyncError::Internal),
        };
        if blob.len() < IV_LENGTH || blob.len() > MAX_BLOB_SIZE {
            return Err(SyncError::Corrupt);
        }
        let (compressed, legacy) = decrypt_blob(&cipher, user_id, &blob)?;
        if legacy {
            let migrated = encrypt_blob(&cipher, user_id, &compressed)?;
            connection
                .execute(
                    "UPDATE sync_data SET data_blob = ? WHERE user_id = ? AND data_blob = ?",
                    params![migrated, user_id, blob],
                )
                .map_err(|error| {
                    tracing::error!("sync encryption migration failed: {error}{NEGATIVE}");
                    SyncError::Internal
                })?;
        }
        drop(connection);
        Ok((decompress_payload(&compressed)?, updated_at))
    })
    .await
    .map_err(|_| SyncError::Internal)?
}

pub async fn meta(State(state): State<Arc<AppState>>, cookies: Cookies) -> impl IntoResponse {
    let (user_id, _) = match get_current_user(&state, &cookies).await {
        Ok(user) => user,
        Err(()) => return response(false, None, None, Some(SyncError::Unauthorized)),
    };
    if let Some(updated_at) = cached_meta_get(user_id) {
        return response(true, None, Some(updated_at), None);
    }
    let pool = state.pool.clone();
    let result = tokio::task::spawn_blocking(move || {
        let connection = pool.get().map_err(|_| SyncError::Internal)?;
        let updated_at = connection
            .query_row(
                "SELECT updated_at FROM sync_data WHERE user_id = ?",
                params![user_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap_or_default();
        Ok::<_, SyncError>(updated_at)
    })
    .await;
    match result {
        Ok(Ok(updated_at)) => {
            if !updated_at.is_empty() {
                cached_meta_set(user_id, updated_at.clone());
            }
            response(true, None, Some(updated_at), None)
        }
        _ => response(false, None, None, Some(SyncError::Internal)),
    }
}

pub async fn upload(
    State(state): State<Arc<AppState>>,
    cookies: Cookies,
    headers: HeaderMap,
    payload: Result<Bytes, BytesRejection>,
) -> impl IntoResponse {
    let (user_id, _) = match get_current_user(&state, &cookies).await {
        Ok(user) => user,
        Err(()) => return response(false, None, None, Some(SyncError::Unauthorized)),
    };
    let content_type_valid = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value.split(';').next().is_some_and(|media_type| {
                media_type.trim().eq_ignore_ascii_case("application/json")
            })
        });
    if !content_type_valid {
        return response(false, None, None, Some(SyncError::UnsupportedMediaType));
    }
    let payload = match payload {
        Ok(payload) => payload,
        Err(rejection) => {
            let error = if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
                SyncError::TooLarge
            } else {
                SyncError::InvalidPayload
            };
            return response(false, None, None, Some(error));
        }
    };
    let permit = match state.sync_work.try_acquire() {
        Some(permit) => permit,
        None => return response(false, None, None, Some(SyncError::Busy)),
    };
    let payload = match tokio::task::spawn_blocking(move || {
        decode_upload_payload(&headers, &payload)
    })
    .await
    {
        Ok(Ok(payload)) => payload,
        Ok(Err(error)) => return response(false, None, None, Some(error)),
        Err(_) => return response(false, None, None, Some(SyncError::Internal)),
    };
    let result = store_payload_for_user(&state, user_id, payload).await;
    drop(permit);
    match result {
        Ok(updated_at) => {
            cached_meta_set(user_id, updated_at.clone());
            response(true, None, Some(updated_at), None)
        }
        Err(error) => response(false, None, None, Some(error)),
    }
}

pub async fn download(State(state): State<Arc<AppState>>, cookies: Cookies) -> impl IntoResponse {
    let (user_id, _) = match get_current_user(&state, &cookies).await {
        Ok(user) => user,
        Err(()) => return response(false, None, None, Some(SyncError::Unauthorized)),
    };
    let permit = match state.sync_work.try_acquire() {
        Some(permit) => permit,
        None => return response(false, None, None, Some(SyncError::Busy)),
    };
    let result = load_payload_for_user(&state, user_id).await;
    drop(permit);
    match result {
        Ok((data, updated_at)) => Json(DownloadResponse {
            success: true,
            data,
            updated_at,
            code: None,
            error: None,
        })
        .into_response(),
        Err(error) => response(false, None, None, Some(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::KeyInit;
    use r2d2::Pool;
    use r2d2_sqlite::SqliteConnectionManager;
    use serde_json::json;

    fn value(value: Value) -> Value {
        json!({ "type": "object", "id": 1, "value": { "payload": value } })
    }

    fn snapshot() -> Value {
        json!({
            "schemaVersion": SCHEMA_VERSION,
            "localStorage": {
                "gameSource": "gn-math",
                "lyra-bookmarks": "[]",
                "lyra-resume-anikoto-1-1-sub": "{\"currentTime\":12}",
                "lyra-history-v1": "{\"version\":1,\"entries\":[]}"
            },
            "sessionStorage": { "lyra-anime-search-build-safe-a": "[]" },
            "cookies": [{
                "name": "theme_hint",
                "value": "dark",
                "domain": null,
                "path": "/",
                "expires": null,
                "sameSite": "lax",
                "secure": false,
                "partitioned": false
            }],
            "indexedDB": {
                "lyra_test": {
                    "stores": {
                        "inline": {
                            "keyPath": "id",
                            "autoIncrement": false,
                            "indexes": {},
                            "records": [{
                                "key": { "type": "number", "value": 1 },
                                "value": value(json!({ "type": "string", "value": "first" }))
                            }]
                        },
                        "out_of_line": {
                            "keyPath": null,
                            "autoIncrement": false,
                            "indexes": {},
                            "records": [{
                                "key": { "type": "string", "value": "alpha" },
                                "value": { "type": "array", "id": 1, "value": [
                                    { "type": "boolean", "value": true },
                                    { "type": "null" }
                                ] }
                            }]
                        }
                    }
                }
            }
        })
    }

    fn state() -> AppState {
        let manager = SqliteConnectionManager::memory();
        let pool = Pool::builder().max_size(1).build(manager).unwrap();
        let connection = pool.get().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE users (
                    id INTEGER PRIMARY KEY,
                    username TEXT NOT NULL,
                    password_hash TEXT NOT NULL,
                    token_version INTEGER NOT NULL
                );
                CREATE TABLE sync_data (
                    user_id INTEGER PRIMARY KEY,
                    data_blob BLOB NOT NULL,
                    updated_at TEXT NOT NULL
                );
                INSERT INTO users VALUES (1, 'one', 'unused', 1);
                INSERT INTO users VALUES (2, 'two', 'unused', 1);",
            )
            .unwrap();
        drop(connection);
        let key = aes_gcm::Key::<Aes256Gcm>::from_slice(&[7_u8; 32]);
        AppState {
            jwt_secret: String::from("test-secret").into(),
            pool,
            aes_cipher: Arc::new(Aes256Gcm::new(key)),
            auth_work: adaptive_capacity::AdaptiveGate::new(1, 1, 2),
            sync_work: adaptive_capacity::AdaptiveGate::new(1, 1, 2),
        }
    }

    async fn loaded_value(state: &AppState, user_id: i64) -> Value {
        serde_json::to_value(load_payload_for_user(state, user_id).await.unwrap().0).unwrap()
    }

    #[test]
    fn accepts_the_versioned_schema_without_changing_json_types_or_keys() {
        let payload = snapshot();
        assert_eq!(validate_snapshot(&payload), Ok(()));
        assert_eq!(
            payload["indexedDB"]["lyra_test"]["stores"]["out_of_line"]["records"][0]["key"]
                ["value"],
            "alpha"
        );
        assert_eq!(
            payload["indexedDB"]["lyra_test"]["stores"]["out_of_line"]["records"][0]["value"]
                ["value"][0]["value"],
            true
        );
        assert!(
            payload["indexedDB"]["lyra_test"]["stores"]["out_of_line"]["records"][0]["value"]
                ["value"][1]["type"]
                .is_string()
        );

        let mut structured_legacy = snapshot();
        structured_legacy["schemaVersion"] = Value::Number(LEGACY_STRUCTURED_SCHEMA_VERSION.into());
        assert_eq!(validate_snapshot(&structured_legacy), Ok(()));

        let mut legacy = snapshot();
        legacy["schemaVersion"] = Value::Number(1.into());
        legacy["cookies"] = json!({ "theme_hint": "dark" });
        assert_eq!(validate_snapshot(&legacy), Ok(()));
    }

    #[test]
    fn accepts_gzip_uploads_and_rejects_unknown_content_encodings() {
        let payload = snapshot();
        let raw = serde_json::to_vec(&payload).unwrap();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&raw).unwrap();
        let compressed = encoder.finish().unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_ENCODING, "gzip".parse().unwrap());
        assert_eq!(
            decode_upload_payload(&headers, &compressed)
                .unwrap()
                .schema_version,
            SCHEMA_VERSION
        );

        headers.insert(CONTENT_ENCODING, "br".parse().unwrap());
        assert!(matches!(
            decode_upload_payload(&headers, &compressed),
            Err(SyncError::UnsupportedEncoding)
        ));
    }

    #[tokio::test]
    async fn new_account_can_upload_and_download_a_compressed_snapshot() {
        let state = Arc::new(state());
        let cookies = Cookies::default();
        let registration = crate::auth::register(
            State(state.clone()),
            cookies.clone(),
            Ok(Json(crate::auth::RegisterRequest {
                username: "fresh_user".into(),
                password: "not a real cloudsync password".into(),
            })),
        )
        .await
        .into_response();
        assert_eq!(registration.status(), StatusCode::CREATED);

        let payload = snapshot();
        let raw = serde_json::to_vec(&payload).unwrap();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&raw).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, "application/json".parse().unwrap());
        headers.insert(CONTENT_ENCODING, "gzip".parse().unwrap());
        let uploaded = upload(
            State(state.clone()),
            cookies.clone(),
            headers,
            Ok(Bytes::from(encoder.finish().unwrap())),
        )
        .await
        .into_response();
        assert_eq!(uploaded.status(), StatusCode::OK);

        let downloaded = download(State(state), cookies).await.into_response();
        assert_eq!(downloaded.status(), StatusCode::OK);
        let body = axum::body::to_bytes(downloaded.into_body(), MAX_RAW_SIZE)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["data"]["schemaVersion"], SCHEMA_VERSION);
        assert_eq!(body["data"]["localStorage"]["gameSource"], "gn-math");
    }

    #[test]
    fn rejects_malformed_deep_and_invalid_payloads() {
        assert_eq!(
            validate_snapshot(&json!({})),
            Err(SyncError::InvalidPayload)
        );
        let mut delta = snapshot();
        delta
            .as_object_mut()
            .unwrap()
            .insert("_delta".into(), Value::Bool(true));
        assert_eq!(validate_snapshot(&delta), Err(SyncError::InvalidPayload));

        let mut nested = json!({ "type": "null" });
        for id in 1..=MAX_JSON_DEPTH + 1 {
            nested = json!({ "type": "array", "id": id, "value": [nested] });
        }
        let mut deep = snapshot();
        deep["indexedDB"]["lyra_test"]["stores"]["inline"]["records"][0]["value"] = nested;
        assert_eq!(validate_snapshot(&deep), Err(SyncError::TooDeep));

        let mut invalid_reference = snapshot();
        invalid_reference["indexedDB"]["lyra_test"]["stores"]["inline"]["records"][0]["value"] =
            json!({ "type": "reference", "value": 99 });
        assert_eq!(
            validate_snapshot(&invalid_reference),
            Err(SyncError::InvalidPayload)
        );
        assert_eq!(
            validate_raw_size(MAX_RAW_SIZE + 1),
            Err(SyncError::TooLarge)
        );
    }

    #[test]
    fn rejects_credentials_and_secrets_in_every_named_payload_path() {
        for field in ["localStorage", "sessionStorage"] {
            for key in [
                "auth_token",
                "providerAccessToken",
                "clientSecret",
                "Authorization",
                "csrfToken",
            ] {
                let mut payload = snapshot();
                payload[field][key] = Value::String("secret".into());
                assert_eq!(validate_snapshot(&payload), Err(SyncError::InvalidPayload));
            }
        }
        for name in [
            "auth_token",
            "providerAccessToken",
            "clientSecret",
            "Authorization",
            "csrfToken",
        ] {
            let mut payload = snapshot();
            payload["cookies"][0]["name"] = Value::String(name.into());
            assert_eq!(validate_snapshot(&payload), Err(SyncError::InvalidPayload));
        }
        let mut embedded_secret = snapshot();
        embedded_secret["localStorage"]["provider"] =
            Value::String("{\"access_token\":\"opaque-secret\"}".into());
        assert_eq!(
            validate_snapshot(&embedded_secret),
            Err(SyncError::InvalidPayload)
        );
        let mut cookie_injection = snapshot();
        cookie_injection["cookies"][0]["value"] = Value::String("safe; domain=.example.com".into());
        assert_eq!(
            validate_snapshot(&cookie_injection),
            Err(SyncError::InvalidPayload)
        );
        let mut constructor = snapshot();
        constructor["indexedDB"]["lyra_test"]["stores"]["inline"]["records"][0]["value"] = json!({
            "type": "typed_array",
            "id": 1,
            "value": {
                "name": "Function",
                "buffer": { "type": "array_buffer", "id": 2, "value": "" },
                "byteOffset": 0,
                "length": 0
            }
        });
        assert_eq!(
            validate_snapshot(&constructor),
            Err(SyncError::InvalidPayload)
        );
        let mut record_secret = snapshot();
        record_secret["indexedDB"]["lyra_test"]["stores"]["inline"]["records"][0]["value"] = json!({
            "type": "object",
            "id": 1,
            "value": { "password": { "type": "string", "value": "secret" } }
        });
        assert_eq!(
            validate_snapshot(&record_secret),
            Err(SyncError::InvalidPayload)
        );
        let mut binary_secret = snapshot();
        binary_secret["indexedDB"]["lyra_test"]["stores"]["inline"]["records"][0]["value"] = json!({
            "type": "array_buffer",
            "id": 1,
            "value": STANDARD.encode(br#"{"apiKey":"never-upload"}"#)
        });
        assert_eq!(
            validate_snapshot(&binary_secret),
            Err(SyncError::InvalidPayload)
        );
    }

    #[test]
    fn accepts_credentials_only_in_browser_scoped_containers() {
        let mut payload = snapshot();
        payload["localStorage"]["example.com@password"] =
            Value::String("correct horse battery staple".into());
        payload["sessionStorage"]["example.com@auth_token"] =
            Value::String("eyJabcdefgh.eyJabcdefgh.abcdefghijk".into());
        payload["indexedDB"] = json!({
            "https://example.com@auth": { "stores": { "credentials": {
                "keyPath": null,
                "autoIncrement": false,
                "indexes": {},
                "records": [{
                    "key": { "type": "string", "value": "password" },
                    "value": { "type": "object", "id": 1, "value": {
                        "access_token": { "type": "string", "value": "eyJabcdefgh.eyJabcdefgh.abcdefghijk" }
                    } }
                }]
            } } },
            "__folio_controller": { "stores": { "state": {
                "keyPath": null,
                "autoIncrement": false,
                "indexes": {},
                "records": [{
                    "key": { "type": "string", "value": "cookies" },
                    "value": { "type": "object", "id": 1, "value": {
                        "updatedAt": { "type": "number", "value": 0 },
                        "cookies": { "type": "string", "value": "{\".example.com@/@session\":{\"name\":\"session\",\"value\":\"opaque-login-cookie\",\"domain\":\".example.com\",\"path\":\"/\",\"hostOnly\":false,\"secure\":true,\"httpOnly\":true,\"sameSite\":\"lax\"}}" }
                    } }
                }]
            } } }
        });
        assert_eq!(validate_snapshot(&payload), Ok(()));

        let mut legacy = payload.clone();
        legacy["schemaVersion"] = Value::Number(LEGACY_STRUCTURED_SCHEMA_VERSION.into());
        assert_eq!(validate_snapshot(&legacy), Err(SyncError::InvalidPayload));

        payload["cookies"][0]["name"] = Value::String("session".into());
        assert_eq!(validate_snapshot(&payload), Err(SyncError::InvalidPayload));
    }

    #[test]
    fn public_errors_are_lowercase_provider_neutral_and_suffixed_once() {
        for error in [
            SyncError::Unauthorized,
            SyncError::InvalidPayload,
            SyncError::UnsupportedMediaType,
            SyncError::UnsupportedEncoding,
            SyncError::Unprocessable,
            SyncError::TooDeep,
            SyncError::TooLarge,
            SyncError::Missing,
            SyncError::Corrupt,
            SyncError::Busy,
            SyncError::Internal,
        ] {
            let message = error.message();
            assert_eq!(message, message.to_lowercase());
            assert!(message.ends_with(NEGATIVE));
            assert_eq!(message.matches(NEGATIVE).count(), 1);
            assert!(!message.contains("sqlite"));
            assert!(!message.contains("aes"));
            assert!(!message.contains("brotli"));
        }
        assert_eq!(
            SyncError::UnsupportedEncoding.status(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
        assert_eq!(
            SyncError::UnsupportedEncoding.code(),
            "invalid_sync_content_encoding"
        );
    }

    #[tokio::test]
    async fn full_snapshots_replace_values_and_deletions_without_delta_merging() {
        let state = state();
        let first = snapshot();
        store_payload_for_user(&state, 1, first).await.unwrap();
        let mut second = snapshot();
        second["localStorage"]
            .as_object_mut()
            .unwrap()
            .remove("gameSource");
        second["sessionStorage"].as_object_mut().unwrap().clear();
        second["cookies"].as_array_mut().unwrap().clear();
        second["indexedDB"]["lyra_test"]["stores"]["inline"]["records"][0]["value"] =
            value(json!({ "type": "string", "value": "replacement" }));
        store_payload_for_user(&state, 1, second.clone())
            .await
            .unwrap();
        let loaded = loaded_value(&state, 1).await;
        assert_eq!(loaded, second);
        assert_eq!(
            loaded["indexedDB"]["lyra_test"]["stores"]["inline"]["records"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn stored_snapshots_are_isolated_by_authenticated_user_id() {
        let state = state();
        let first = snapshot();
        let mut second = snapshot();
        second["localStorage"]["gameSource"] = Value::String("other-source".into());
        store_payload_for_user(&state, 1, first.clone())
            .await
            .unwrap();
        store_payload_for_user(&state, 2, second.clone())
            .await
            .unwrap();
        assert_eq!(loaded_value(&state, 1).await, first);
        assert_eq!(loaded_value(&state, 2).await, second);
        assert_ne!(loaded_value(&state, 1).await, loaded_value(&state, 2).await);
    }

    #[tokio::test]
    async fn stored_snapshots_are_revalidated_before_download() {
        let state = state();
        let mut unsafe_payload = snapshot();
        unsafe_payload["localStorage"]["auth_token"] = Value::String("never-download".into());
        store_payload_for_user(&state, 1, unsafe_payload)
            .await
            .unwrap();
        assert_eq!(
            load_payload_for_user(&state, 1).await.err().unwrap(),
            SyncError::Corrupt
        );
    }

    #[tokio::test]
    async fn encrypted_snapshots_use_unique_nonces_and_are_bound_to_the_user() {
        let state = state();
        let payload = snapshot();
        store_payload_for_user(&state, 1, payload.clone())
            .await
            .unwrap();
        let first_blob: Vec<u8> = state
            .pool
            .get()
            .unwrap()
            .query_row(
                "SELECT data_blob FROM sync_data WHERE user_id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        store_payload_for_user(&state, 1, payload).await.unwrap();
        let connection = state.pool.get().unwrap();
        let second_blob: Vec<u8> = connection
            .query_row(
                "SELECT data_blob FROM sync_data WHERE user_id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(first_blob.starts_with(BLOB_MAGIC));
        assert!(second_blob.starts_with(BLOB_MAGIC));
        assert_ne!(first_blob, second_blob);
        assert!(!second_blob
            .windows(b"gameSource".len())
            .any(|window| window == b"gameSource"));

        connection
            .execute("UPDATE sync_data SET user_id = 2 WHERE user_id = 1", [])
            .unwrap();
        drop(connection);
        assert_eq!(
            load_payload_for_user(&state, 2).await.err().unwrap(),
            SyncError::Corrupt
        );
    }

    #[tokio::test]
    async fn legacy_encryption_remains_readable_during_migration() {
        let state = state();
        let payload = snapshot();
        let compressed = compress_payload(&payload).unwrap();
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let encrypted = state
            .aes_cipher
            .encrypt(&nonce, compressed.as_ref())
            .unwrap();
        let mut blob = nonce.to_vec();
        blob.extend_from_slice(&encrypted);
        state
            .pool
            .get()
            .unwrap()
            .execute(
                "INSERT INTO sync_data (user_id, data_blob, updated_at) VALUES (1, ?, 'legacy')",
                params![blob],
            )
            .unwrap();
        assert_eq!(loaded_value(&state, 1).await, payload);
        let migrated: Vec<u8> = state
            .pool
            .get()
            .unwrap()
            .query_row(
                "SELECT data_blob FROM sync_data WHERE user_id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(migrated.starts_with(BLOB_MAGIC));
    }
}
