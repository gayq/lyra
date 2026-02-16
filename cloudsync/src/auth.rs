use axum::{
    extract::State,
    http::StatusCode,
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

const COOKIE_NAME: &str = "auth_token";

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

    let pool = state.pool.clone();
    let username = payload.username.clone();
    let password = payload.password.clone();

    let result = tokio::task::spawn_blocking(move || {
        let conn = pool.get().map_err(|_| "db pool error")?;

        let exists: bool = conn.query_row("SELECT 1 FROM users WHERE username = ?", params![username], |_row: &rusqlite::Row| Ok(true)).unwrap_or(false);
        if exists {
            return Err("username taken!");
        }

        let hashed = hash(&password, 12).map_err(|_| "hash error")?;

        conn.execute(
            "INSERT INTO users (username, password_hash, token_version) VALUES (?, ?, 1)",
            params![username, hashed],
        ).map_err(|_| "db insert error")?;
        
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
                Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(AuthResponse { success: false, user: None, error: Some("jwt error".into()) })),
            };
        
            let cookie = Cookie::build((COOKIE_NAME, token))
                .path("/")
                .http_only(true)
                .secure(true)
                .same_site(SameSite::Strict)
                .max_age(Duration::days(7));
            
            cookies.add(cookie.into());
        
            (StatusCode::CREATED, Json(AuthResponse { success: true, user: Some(UserResponse { id: user_id, username: payload.username }), error: None }))
        },
        Ok(Err(e)) => {
            let status = if e == "username taken" { StatusCode::CONFLICT } else { StatusCode::INTERNAL_SERVER_ERROR };
            (status, Json(AuthResponse { success: false, user: None, error: Some(e.into()) }))
        },
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(AuthResponse { success: false, user: None, error: Some("mt error".into()) })),
    }
}

pub async fn login(
    State(state): State<Arc<AppState>>,
    cookies: Cookies,
    Json(payload): Json<LoginRequest>,
) -> impl IntoResponse {
    let pool = state.pool.clone();
    let username = payload.username.clone();
    let password = payload.password.clone();

    let result = tokio::task::spawn_blocking(move || {
        let conn = pool.get().map_err(|_| "db pool error")?;

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
                Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(AuthResponse { success: false, user: None, error: Some("jwt error".into()) })),
            };
        
            let cookie = Cookie::build((COOKIE_NAME, token))
                .path("/")
                .http_only(true)
                .secure(true)
                .same_site(SameSite::Strict)
                .max_age(Duration::days(7));
        
            cookies.add(cookie.into());
        
            (StatusCode::OK, Json(AuthResponse { success: true, user: Some(UserResponse { id, username: payload.username }), error: None }))
        },
        Ok(Err(e)) => (StatusCode::UNAUTHORIZED, Json(AuthResponse { success: false, user: None, error: Some(e.into()) })),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(AuthResponse { success: false, user: None, error: Some("mt error".into()) })),
    }
}

pub async fn logout(
    State(_state): State<Arc<AppState>>,
    cookies: Cookies
) -> impl IntoResponse {
    let cookie = Cookie::build((COOKIE_NAME, ""))
        .path("/")
        .http_only(true)
        .secure(true)
        .same_site(SameSite::Strict)
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
        .secure(true)
        .same_site(SameSite::Strict)
        .max_age(Duration::seconds(0));

    cookies.add(cookie.into());

    (StatusCode::OK, Json(AuthResponse { success: true, user: None, error: Some("account deleted!".into()) }))
}


pub async fn get_current_user(state: &AppState, cookies: &Cookies) -> Result<(i64, String), ()> {
    let token = cookies.get(COOKIE_NAME).map(|c| c.value().to_string()).ok_or(())?;
    
    let token_data = decode::<Claims>(
        &token,
        &DecodingKey::from_secret(state.jwt_secret.as_bytes()),
        &Validation::default(),
    ).map_err(|_| ())?;

    let pool = state.pool.clone();
    let db_v = tokio::task::spawn_blocking(move || {
        let conn = pool.get().map_err(|_| ())?;
        let (db_version,): (i64,) = conn.query_row(
            "SELECT token_version FROM users WHERE id = ?",
            params![token_data.claims.id],
            |row: &rusqlite::Row| Ok((row.get(0)?,)),
        ).map_err(|_| ())?;
        Ok(db_version)
    }).await.map_err(|_| ())??;

    if db_v != token_data.claims.v {
        return Err(());
    }

    Ok((token_data.claims.id, token_data.claims.username))
}