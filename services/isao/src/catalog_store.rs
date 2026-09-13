use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;
use std::{path::Path, sync::Arc, time::{Duration, SystemTime, UNIX_EPOCH}};
use tokio::sync::Semaphore;

pub fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

#[derive(Clone)]
pub struct Store {
    pool: Pool<SqliteConnectionManager>,
    admission: Arc<Semaphore>,
}

#[derive(Debug, Clone)]
pub struct Job {
    pub key: String,
    pub kind: String,
    pub arg: String,
    pub token: i64,
    pub attempts: i64,
}

pub type Result<T> = std::result::Result<T, ()>;

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(|_| ())?;
        }
        let manager = SqliteConnectionManager::file(path).with_init(|conn| {
            conn.busy_timeout(Duration::from_secs(2))?;
            conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-4096;")
        });
        let pool = Pool::builder().max_size(4).min_idle(Some(1))
            .connection_timeout(Duration::from_secs(2)).build(manager).map_err(|_| ())?;
        pool.get().map_err(|_| ())?.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS anime (
               id INTEGER PRIMARY KEY, mal_id INTEGER, body TEXT NOT NULL,
               search_text TEXT NOT NULL, adult INTEGER NOT NULL,
               popularity INTEGER NOT NULL, trending INTEGER NOT NULL, updated INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS anime_mal ON anime(mal_id);
             CREATE INDEX IF NOT EXISTS anime_popularity ON anime(adult,popularity DESC);
             CREATE INDEX IF NOT EXISTS anime_trending ON anime(adult,trending DESC);
             CREATE VIRTUAL TABLE IF NOT EXISTS anime_search USING fts5(search_text, content='anime', content_rowid='id');
             CREATE TRIGGER IF NOT EXISTS anime_ai AFTER INSERT ON anime BEGIN
               INSERT INTO anime_search(rowid,search_text) VALUES(new.id,new.search_text); END;
             CREATE TRIGGER IF NOT EXISTS anime_ad AFTER DELETE ON anime BEGIN
               INSERT INTO anime_search(anime_search,rowid,search_text) VALUES('delete',old.id,old.search_text); END;
             CREATE TRIGGER IF NOT EXISTS anime_au AFTER UPDATE ON anime BEGIN
               INSERT INTO anime_search(anime_search,rowid,search_text) VALUES('delete',old.id,old.search_text);
               INSERT INTO anime_search(rowid,search_text) VALUES(new.id,new.search_text); END;
             CREATE TABLE IF NOT EXISTS snapshots (key TEXT PRIMARY KEY, body TEXT NOT NULL, updated INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS jobs (
               key TEXT PRIMARY KEY, kind TEXT NOT NULL, arg TEXT NOT NULL, priority INTEGER NOT NULL,
               due INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0,
               token INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0
             );
             CREATE INDEX IF NOT EXISTS jobs_due ON jobs(due,lease_until);
             CREATE TABLE IF NOT EXISTS providers (
               name TEXT PRIMARY KEY, next_at INTEGER NOT NULL DEFAULT 0,
               blocked_until INTEGER NOT NULL DEFAULT 0,
               requests INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0
             );"
        ).map_err(|_| ())?;
        Ok(Self { pool, admission: Arc::new(Semaphore::new(32)) })
    }

    pub async fn run<T: Send + 'static>(&self, f: impl FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static) -> Result<T> {
        let permit = self.admission.clone().try_acquire_owned().map_err(|_| ())?;
        let pool = self.pool.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let mut conn = pool.get().map_err(|_| ())?;
            f(&mut conn).map_err(|_| ())
        }).await.map_err(|_| ())?
    }

    pub async fn enqueue(&self, kind: &str, arg: &str, priority: i32) -> Result<()> {
        let (kind, arg) = (kind.to_owned(), arg.to_owned());
        self.run(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let key = format!("{kind}:{arg}");
            tx.execute("INSERT OR IGNORE INTO jobs(key,kind,arg,priority,due)
                SELECT ?1,?2,?3,?4,?5 WHERE (SELECT count(*) FROM jobs)<256",
                params![key, kind, arg, priority, now()])?;
            tx.commit()
        }).await
    }

    pub async fn claim(&self) -> Result<Option<Job>> {
        self.run(|conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let time = now();
            let job = tx.query_row("SELECT key,kind,arg,token,attempts FROM jobs
                WHERE due<=?1 AND lease_until<=?1 ORDER BY priority DESC,due ASC LIMIT 1", [time], |row| {
                Ok(Job { key: row.get(0)?, kind: row.get(1)?, arg: row.get(2)?, token: row.get::<_, i64>(3)? + 1, attempts: row.get(4)? })
            }).optional()?;
            if let Some(job) = &job {
                tx.execute("UPDATE jobs SET lease_until=?2,token=?3 WHERE key=?1", params![job.key, time + 180_000, job.token])?;
            }
            tx.commit()?;
            Ok(job)
        }).await
    }

    pub async fn fail(&self, job: Job) -> Result<()> {
        self.run(move |conn| {
            let delay = (30_000_i64.saturating_mul(1_i64 << job.attempts.min(7))).min(3_600_000);
            conn.execute("UPDATE jobs SET due=?3,lease_until=0,attempts=attempts+1 WHERE key=?1 AND token=?2",
                params![job.key, job.token, now() + delay])?;
            Ok(())
        }).await
    }

    pub async fn complete(&self, job: Job, media: Vec<Value>, snapshot: Option<Value>) -> Result<()> {
        self.run(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let owns = tx.query_row("SELECT 1 FROM jobs WHERE key=?1 AND token=?2 AND lease_until>?3",
                params![job.key, job.token, now()], |_| Ok(true)).optional()?.unwrap_or(false);
            if !owns { return Ok(()); }
            for item in media {
                let Some(id) = item["id"].as_i64().filter(|id| *id > 0) else { continue; };
                let titles = item["title"].as_object().map(|titles| titles.values().filter_map(Value::as_str).collect::<Vec<_>>()).unwrap_or_default();
                let aliases = item["synonyms"].as_array().map(|values| values.iter().filter_map(Value::as_str).collect::<Vec<_>>()).unwrap_or_default();
                let search = [titles.join(" "), aliases.join(" ")].join(" ");
                tx.execute("INSERT INTO anime(id,mal_id,body,search_text,adult,popularity,trending,updated)
                    VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET
                    mal_id=excluded.mal_id,body=excluded.body,search_text=excluded.search_text,
                    adult=excluded.adult,popularity=excluded.popularity,trending=excluded.trending,updated=excluded.updated",
                    params![id, item["idMal"].as_i64(), item.to_string(), search,
                        item["isAdult"].as_bool().unwrap_or(true), item["popularity"].as_i64().unwrap_or(0), item["trending"].as_i64().unwrap_or(0), now()])?;
            }
            if let Some(snapshot) = snapshot {
                tx.execute("INSERT INTO snapshots(key,body,updated) VALUES(?1,?2,?3)
                    ON CONFLICT(key) DO UPDATE SET body=excluded.body,updated=excluded.updated",
                    params![job.key, snapshot.to_string(), now()])?;
            }
            tx.execute("DELETE FROM jobs WHERE key=?1 AND token=?2", params![job.key, job.token])?;
            tx.execute("DELETE FROM anime WHERE id IN (SELECT id FROM anime ORDER BY updated DESC LIMIT -1 OFFSET 10000)", [])?;
            tx.execute("DELETE FROM snapshots WHERE key IN (SELECT key FROM snapshots ORDER BY updated DESC LIMIT -1 OFFSET 2000)", [])?;
            tx.commit()
        }).await
    }

    pub async fn snapshot(&self, key: String) -> Result<Option<(Value, i64)>> {
        self.run(move |conn| snapshot(conn, &key)).await
    }

    pub async fn reserve(&self, provider: &'static str, interval: i64) -> Result<i64> {
        self.run(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute("INSERT OR IGNORE INTO providers(name) VALUES(?1)", [provider])?;
            let ready: i64 = tx.query_row("SELECT max(next_at,blocked_until) FROM providers WHERE name=?1", [provider], |row| row.get(0))?;
            let time = now();
            if ready <= time {
                tx.execute("UPDATE providers SET next_at=?2,requests=requests+1 WHERE name=?1", params![provider, time + interval])?;
            }
            tx.commit()?;
            Ok((ready - time).max(0))
        }).await
    }

    pub async fn cooldown(&self, provider: &'static str, until: i64, failed: bool) -> Result<()> {
        self.run(move |conn| {
            conn.execute("INSERT INTO providers(name,blocked_until,failures) VALUES(?1,?2,?3)
                ON CONFLICT(name) DO UPDATE SET blocked_until=max(blocked_until,excluded.blocked_until),failures=failures+excluded.failures",
                params![provider, until, i64::from(failed)])?;
            Ok(())
        }).await
    }
}

pub fn snapshot(conn: &Connection, key: &str) -> rusqlite::Result<Option<(Value, i64)>> {
    conn.query_row("SELECT body,updated FROM snapshots WHERE key=?1", [key], |row| {
        let body: String = row.get(0)?;
        Ok((serde_json::from_str(&body).unwrap_or(Value::Null), row.get(1)?))
    }).optional()
}

pub fn media(conn: &Connection, column: &str, id: i64) -> rusqlite::Result<Option<(Value, i64)>> {
    let sql = if column == "mal_id" { "SELECT body,updated FROM anime WHERE mal_id=?1" } else { "SELECT body,updated FROM anime WHERE id=?1" };
    conn.query_row(sql, [id], |row| {
        let body: String = row.get(0)?;
        Ok((serde_json::from_str(&body).unwrap_or(Value::Null), row.get(1)?))
    }).optional()
}
