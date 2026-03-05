use r2d2_sqlite::SqliteConnectionManager;
use r2d2::Pool;


pub type DbPool = Pool<SqliteConnectionManager>;

pub fn init_pool() -> Result<DbPool, Box<dyn std::error::Error>> {
    let manager = SqliteConnectionManager::file(".db")
        .with_init(|conn| {
            conn.execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = NORMAL;
                 PRAGMA foreign_keys = ON;
                 PRAGMA busy_timeout = 5000;
                 PRAGMA cache_size = -20000;
                 PRAGMA mmap_size = 268435456;
                 PRAGMA temp_store = MEMORY;"
            )
        });
    let pool = Pool::builder()
        .max_size(400)
        .min_idle(Some(5))
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
        )",
        [],
    )?;
    
    {
        let mut stmt = conn.prepare("PRAGMA table_info(users)")?;
        let rows = stmt.query_map([], |row| {
            row.get::<_, String>(1)
        })?;
        
        let mut has_token_version = false;
        for name in rows {
            if let Ok(n) = name {
                if n == "token_version" {
                    has_token_version = true;
                    break;
                }
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
        )",
        [],
    )?;
    
    conn.execute("CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)", [])?;

    Ok(pool)
}

