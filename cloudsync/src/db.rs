use std::path::PathBuf;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;

pub type DbPool = Pool<SqliteConnectionManager>;

fn db_path() -> PathBuf {
    let path = std::env::var("CLOUDSYNC_DB_PATH").unwrap_or_else(|_| ".db".to_string());
    PathBuf::from(path)
}

pub fn init_pool(
    pool_max: u32,
    pool_min_idle: u32,
    cache_size_kb: i64,
    mmap_size: i64,
) -> Result<DbPool, Box<dyn std::error::Error>> {
    let db_file = db_path();
    let manager = SqliteConnectionManager::file(&db_file).with_init(move |conn| {
        conn.execute_batch(&format!(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 30000;
             PRAGMA cache_size = -{};
             PRAGMA mmap_size = {};
             PRAGMA temp_store = MEMORY;
             PRAGMA auto_vacuum = INCREMENTAL;
             PRAGMA wal_autocheckpoint = 2000;",
            cache_size_kb, mmap_size
        ))
    });
    let pool = Pool::builder()
        .max_size(pool_max)
        .min_idle(Some(pool_min_idle))
        .connection_timeout(std::time::Duration::from_secs(10))
        .build(manager)?;
    let conn = pool.get()?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            token_version INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )", [],
    )?;

    {
        let mut stmt = conn.prepare("PRAGMA table_info(users)")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        let mut has_token_version = false;
        for name in rows {
            if let Ok(n) = name {
                if n == "token_version" { has_token_version = true; break; }
            }
        }
        if !has_token_version {
            let _ = conn.execute("ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 1", []);
        }
    }

    conn.execute(
        "CREATE TABLE IF NOT EXISTS sync_data (
            user_id INTEGER PRIMARY KEY,
            data_blob BLOB NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )", [],
    )?;

    conn.execute("CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)", [])?;

    Ok(pool)
}