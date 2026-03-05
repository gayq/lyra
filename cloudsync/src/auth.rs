use axum::{
    extract::State,
    http::{StatusCode},
    response::{IntoResponse, Json},
};
use tower_cookies::{Cookies, Cookie};
use tower_cookies::cookie::SameSite;
use bcrypt::{hash, verify};
use jsonwebtoken::{encode, decode, Header, Validation, EncodingKey, DecodingKey};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use time::Duration;
use std::sync::OnceLock;
use dashmap::DashMap;
use std::time::Instant;

const COOKIE_NAME: &str = "token";

fn is_cookie_secure() -> bool {
    std::env::var("COOKIE_SECURE").map(|v| v != "false" && v != "0").unwrap_or(true)
}

#[derive(Clone)]
pub struct AppState {
    pub jwt_secret: String,
    pub sync_secret: String,
    pub pool: crate::db::DbPool,
}

#[derive(Serialize, Deserialize)]
struct Claims {
    id: i64,
    username: String,
    v: i64,
    exp: usize,
}

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub password: String,
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct UserResponse {
    pub id: i64,
    pub username: String,
}

#[derive(Serialize)]
struct AuthResponse {
    success: bool,
    user: Option<UserResponse>,
    error: Option<String>,
}

pub async fn register(
    State(state): State<Arc<AppState>>,
    cookies: Cookies,
    Json(payload): Json<RegisterRequest>,
) -> impl IntoResponse {
    if payload.username.len() < 3 || payload.username.len() > 20 {
         return (StatusCode::BAD_REQUEST, Json(AuthResponse { success: false, user: None, error: Some("username must be 3-20 chars".into()) }));
    }
    if !payload.username.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return (StatusCode::BAD_REQUEST, Json(AuthResponse { success: false, user: None, error: Some("username must be alphanumeric".into()) }));
    }
    if payload.password.len() < 8 {
        return (StatusCode::BAD_REQUEST, Json(AuthResponse { success: false, user: None, error: Some("password too short".into()) }));
    }
    if payload.password.len() > 128 {
        return (StatusCode::BAD_REQUEST, Json(AuthResponse { success: false, user: None, error: Some("password too long".into()) }));
    }

    let pool = state.pool.clone();
    let username = payload.username.clone();
    let password = payload.password.clone();

    let result = tokio::task::spawn_blocking(move || {
        let conn = pool.get().map_err(|_| "internal error")?;

        let exists: bool = conn.query_row("SELECT 1 FROM users WHERE username = ?", params![username], |_row: &rusqlite::Row| Ok(true)).unwrap_or(false);
        if exists {
            return Err("username taken!");
        }

        let hashed = hash(&password, 10).map_err(|_| "internal error")?;

        conn.execute(
            "INSERT INTO users (username, password_hash, token_version) VALUES (?, ?, 1)",
            params![username, hashed],
        ).map_err(|_| "internal error")?;
        
        Ok(conn.last_insert_rowid())
    }).await.map_err(|_| "task error");

    match result {
        Ok(Ok(user_id)) => {
             let claims = Claims {
                id: user_id,
                username: payload.username.clone(),
                v: 1,
                exp: (time::OffsetDateTime::now_utc() + Duration::days(7)).unix_timestamp() as usize,
            };
        
            let token = match encode(&Header::default(), &claims, &EncodingKey::from_secret(state.jwt_secret.as_bytes())) {
                Ok(t) => t,
                Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(AuthResponse { success: false, user: None, error: Some("internal error".into()) })),
            };
        
            let cookie = Cookie::build((COOKIE_NAME, token))
                .path("/")
                .http_only(true)
                .secure(is_cookie_secure())
                .same_site(if is_cookie_secure() { SameSite::Strict } else { SameSite::Lax })
                .max_age(Duration::days(7));
            
            cookies.add(cookie.into());
        
            (StatusCode::CREATED, Json(AuthResponse { success: true, user: Some(UserResponse { id: user_id, username: payload.username }), error: None }))
        },
        Ok(Err(e)) => {
            let status = if e == "username taken!" { StatusCode::CONFLICT } else { StatusCode::INTERNAL_SERVER_ERROR };
            (status, Json(AuthResponse { success: false, user: None, error: Some(e.into()) }))
        },
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(AuthResponse { success: false, user: None, error: Some("internal error".into()) })),
    }
}

pub async fn login(
    State(state): State<Arc<AppState>>,
    cookies: Cookies,
    Json(payload): Json<LoginRequest>,
) -> impl IntoResponse {
    if payload.password.len() > 128 {
        return (StatusCode::BAD_REQUEST, Json(AuthResponse { success: false, user: None, error: Some("password too long".into()) }));
    }

    let pool = state.pool.clone();
    let username = payload.username.clone();
    let password = payload.password.clone();

    let result = tokio::task::spawn_blocking(move || {
        let conn = pool.get().map_err(|_| "internal error")?;

        let (id, password_hash, token_version): (i64, String, i64) = conn.query_row(
            "SELECT id, password_hash, token_version FROM users WHERE username = ?",
            params![username],
            |row: &rusqlite::Row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).map_err(|_| "invalid credentials!")?;

        if !verify(&password, &password_hash).unwrap_or(false) {
            return Err("invalid credentials!");
        }
        
        Ok((id, token_version))
    }).await.map_err(|_| "task error");

    match result {
        Ok(Ok((id, token_version))) => {
            let claims = Claims {
                id,
                username: payload.username.clone(),
                v: token_version,
                exp: (time::OffsetDateTime::now_utc() + Duration::days(7)).unix_timestamp() as usize,
            };
        
            let token = match encode(&Header::default(), &claims, &EncodingKey::from_secret(state.jwt_secret.as_bytes())) {
                Ok(t) => t,
                Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(AuthResponse { success: false, user: None, error: Some("internal error".into()) })),
            };
        
            let cookie = Cookie::build((COOKIE_NAME, token))
                .path("/")
                .http_only(true)
                .secure(is_cookie_secure())
                .same_site(if is_cookie_secure() { SameSite::Strict } else { SameSite::Lax })
                .max_age(Duration::days(7));
        
            cookies.add(cookie.into());
        
            (StatusCode::OK, Json(AuthResponse { success: true, user: Some(UserResponse { id, username: payload.username }), error: None }))
        },
        Ok(Err(e)) => (StatusCode::UNAUTHORIZED, Json(AuthResponse { success: false, user: None, error: Some(e.into()) })),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(AuthResponse { success: false, user: None, error: Some("internal error".into()) })),
    }
}

pub async fn logout(
    State(_state): State<Arc<AppState>>,
    cookies: Cookies
) -> impl IntoResponse {
    let cookie = Cookie::build((COOKIE_NAME, ""))
        .path("/")
        .http_only(true)
        .secure(is_cookie_secure())
        .same_site(if is_cookie_secure() { SameSite::Strict } else { SameSite::Lax })
        .max_age(Duration::seconds(0));
    
    cookies.add(cookie.into());

    (StatusCode::OK, Json(AuthResponse { success: true, user: None, error: None }))
}

pub async fn me(
    State(state): State<Arc<AppState>>,
    cookies: Cookies,
) -> impl IntoResponse {
    let (user_id, username) = match get_current_user(&state, &cookies).await {
        Ok(u) => u,
        Err(_) => return (StatusCode::UNAUTHORIZED, Json(AuthResponse { success: false, user: None, error: Some("unauthorized".into()) })),
    };

    (StatusCode::OK, Json(AuthResponse { success: true, user: Some(UserResponse { id: user_id, username }), error: None }))
}

pub async fn delete_account(
    State(state): State<Arc<AppState>>,
    cookies: Cookies,
) -> impl IntoResponse {
    let (user_id, _) = match get_current_user(&state, &cookies).await {
        Ok(u) => u,
        Err(_) => return (StatusCode::UNAUTHORIZED, Json(AuthResponse { success: false, user: None, error: Some("unauthorized".into()) })),
    };
    
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        if let Ok(conn) = pool.get() {
             let _ = conn.execute("DELETE FROM users WHERE id = ?", params![user_id]);
        }
    }).await.unwrap();

    let cookie = Cookie::build((COOKIE_NAME, ""))
        .path("/")
        .http_only(true)
        .secure(is_cookie_secure())
        .same_site(if is_cookie_secure() { SameSite::Strict } else { SameSite::Lax })
        .max_age(Duration::seconds(0));

    cookies.add(cookie.into());

    (StatusCode::OK, Json(AuthResponse { success: true, user: None, error: Some("account deleted!".into()) }))
}


static TOKEN_CACHE: OnceLock<DashMap<i64, (i64, Instant)>> = OnceLock::new();

fn get_token_cache() -> &'static DashMap<i64, (i64, Instant)> {
    TOKEN_CACHE.get_or_init(|| DashMap::new())
}

pub async fn get_current_user(state: &AppState, cookies: &Cookies) -> Result<(i64, String), ()> {
    let token = cookies.get(COOKIE_NAME).map(|c| c.value().to_string()).ok_or(())?;
    
    let token_data = decode::<Claims>(
        &token,
        &DecodingKey::from_secret(state.jwt_secret.as_bytes()),
        &Validation::default(),
    ).map_err(|_| ())?;

    let user_id = token_data.claims.id;
    let token_v = token_data.claims.v;

    let cache = get_token_cache();
    if let Some(entry) = cache.get(&user_id) {
        let (cached_v, cached_at) = *entry;
        if cached_at.elapsed().as_secs() < 60 {
            if cached_v != token_v {
                return Err(());
            }
            return Ok((user_id, token_data.claims.username));
        }
    }

    let pool = state.pool.clone();
    let db_v = tokio::task::spawn_blocking(move || {
        let conn = pool.get().map_err(|_| ())?;
        let (db_version,): (i64,) = conn.query_row(
            "SELECT token_version FROM users WHERE id = ?",
            params![user_id],
            |row: &rusqlite::Row| Ok((row.get(0)?,)),
        ).map_err(|_| ())?;
        Ok(db_version)
    }).await.map_err(|_| ())??;

    cache.insert(user_id, (db_v, Instant::now()));

    if db_v != token_v {
        return Err(());
    }

    Ok((token_data.claims.id, token_data.claims.username))
}