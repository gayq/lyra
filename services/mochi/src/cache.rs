use crate::helpers::fix_game_content_type;
use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime};
use tokio::fs::{self, File};
use tokio::io::{
    self, AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWrite, AsyncWriteExt, BufReader, BufWriter,
};
use tokio_util::io::ReaderStream;

const MAX_CACHED_HEADERS: u16 = 256;
const MAX_HEADER_NAME_LEN: usize = 128;
const MAX_HEADER_VALUE_LEN: usize = 32 * 1024;

fn get_cache_path_in(directory: &str, url: &str) -> String {
    let hash = Sha256::digest(url.as_bytes());
    format!("{directory}/{}.bin", hex::encode(&hash[..16]))
}

pub fn get_cache_path(url: &str) -> String {
    get_cache_path_in("./cache", url)
}

pub fn get_stream_cache_path(url: &str) -> String {
    get_cache_path_in("./cache/stream", url)
}

async fn read_cache_header<R>(reader: &mut R) -> Option<(u16, HeaderMap)>
where
    R: AsyncRead + Unpin,
{
    let mut buf_u16 = [0u8; 2];
    reader.read_exact(&mut buf_u16).await.ok()?;
    let status_code = u16::from_le_bytes(buf_u16);

    reader.read_exact(&mut buf_u16).await.ok()?;
    let header_count = u16::from_le_bytes(buf_u16);
    if header_count > MAX_CACHED_HEADERS {
        return None;
    }

    let mut headers = HeaderMap::new();
    for _ in 0..header_count {
        reader.read_exact(&mut buf_u16).await.ok()?;
        let k_len = u16::from_le_bytes(buf_u16) as usize;
        if k_len == 0 || k_len > MAX_HEADER_NAME_LEN {
            return None;
        }
        let mut k_buf = vec![0u8; k_len];
        reader.read_exact(&mut k_buf).await.ok()?;
        let key_str = String::from_utf8(k_buf).ok()?;

        let mut buf_u32 = [0u8; 4];
        reader.read_exact(&mut buf_u32).await.ok()?;
        let v_len = u32::from_le_bytes(buf_u32) as usize;
        if v_len > MAX_HEADER_VALUE_LEN {
            return None;
        }
        let mut v_buf = vec![0u8; v_len];
        reader.read_exact(&mut v_buf).await.ok()?;

        let h_name = axum::http::header::HeaderName::from_bytes(key_str.as_bytes()).ok()?;
        let h_val = axum::http::header::HeaderValue::from_bytes(&v_buf).ok()?;
        headers.insert(h_name, h_val);
    }
    Some((status_code, headers))
}

pub async fn load_from_disk(
    url: &str,
    max_entry_size: usize,
    max_age_secs: u64,
) -> Option<(Response, bool)> {
    let path = get_cache_path(url);
    let file = File::open(&path).await.ok()?;
    let metadata = file.metadata().await.ok()?;
    if metadata.len() > max_entry_size.saturating_add(64 * 1024) as u64
        || metadata.modified().ok()?.elapsed().ok()?.as_secs() > max_age_secs
    {
        return None;
    }
    let mut reader = tokio::io::BufReader::new(file);

    let (status_code, mut headers) = read_cache_header(&mut reader).await?;

    headers.insert("X-Cache", HeaderValue::from_static("DISK"));
    fix_game_content_type(url, &mut headers);

    let status = StatusCode::from_u16(status_code).unwrap_or(StatusCode::OK);
    let stream = ReaderStream::new(reader);
    let body = Body::from_stream(stream);
    Some(((status, headers, body).into_response(), false))
}

pub struct StreamDiskEntry {
    pub status: u16,
    pub headers: HeaderMap,
    pub reader: BufReader<File>,
    pub body_offset: u64,
    pub body_len: u64,
}

pub async fn load_stream_from_disk(
    cache_key: &str,
    max_entry_size: usize,
    max_age_secs: u64,
) -> Option<StreamDiskEntry> {
    let path = get_stream_cache_path(cache_key);
    let file = File::open(path).await.ok()?;
    let metadata = file.metadata().await.ok()?;
    if metadata.len() > max_entry_size.saturating_add(64 * 1024) as u64
        || metadata.modified().ok()?.elapsed().ok()?.as_secs() > max_age_secs
    {
        return None;
    }
    let mut reader = BufReader::new(file);
    let (status, mut headers) = read_cache_header(&mut reader).await?;
    let body_offset = reader.stream_position().await.ok()?;
    let body_len = metadata.len().checked_sub(body_offset)?;
    if body_len > max_entry_size as u64 {
        return None;
    }

    if let Some(recorded_len) = headers.get(axum::http::header::CONTENT_LENGTH) {
        if recorded_len.to_str().ok()?.parse::<u64>().ok()? != body_len {
            return None;
        }
    } else {
        headers.insert(
            axum::http::header::CONTENT_LENGTH,
            HeaderValue::from_str(&body_len.to_string()).ok()?,
        );
    }

    Some(StreamDiskEntry {
        status,
        headers,
        reader,
        body_offset,
        body_len,
    })
}

pub async fn write_cache_header<W>(
    writer: &mut W,
    status: u16,
    headers: &HeaderMap,
) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let header_count = u16::try_from(headers.len()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "too many headers... /ᐠ - ˕ -マ",
        )
    })?;

    writer.write_all(&status.to_le_bytes()).await?;
    writer.write_all(&header_count.to_le_bytes()).await?;

    for (k, v) in headers.iter() {
        let k_bytes = k.as_str().as_bytes();
        let k_len = u16::try_from(k_bytes.len()).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "header name is too long... /ᐠ - ˕ -マ",
            )
        })?;
        writer.write_all(&k_len.to_le_bytes()).await?;
        writer.write_all(k_bytes).await?;

        let v_bytes = v.as_bytes();
        let v_len = u32::try_from(v_bytes.len()).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "header value is too long... /ᐠ - ˕ -マ",
            )
        })?;
        writer.write_all(&v_len.to_le_bytes()).await?;
        writer.write_all(v_bytes).await?;
    }

    Ok(())
}

async fn write_to_disk_path(cache_path: String, status: u16, headers: &HeaderMap, body: &Bytes) {
    let temp_path = format!("{}.{}.tmp", cache_path, uuid::Uuid::new_v4());
    let Ok(f) = File::create(&temp_path).await else {
        return;
    };
    let mut f = BufWriter::new(f);

    if write_cache_header(&mut f, status, headers).await.is_err() {
        let _ = fs::remove_file(&temp_path).await;
        return;
    }

    if f.write_all(body).await.is_err() {
        let _ = fs::remove_file(&temp_path).await;
        return;
    }
    if f.flush().await.is_err() {
        let _ = fs::remove_file(&temp_path).await;
        return;
    }
    drop(f);
    let _ = fs::rename(&temp_path, &cache_path).await;
}

pub async fn write_to_disk(cache_key: &str, status: u16, headers: &HeaderMap, body: &Bytes) {
    write_to_disk_path(get_cache_path(cache_key), status, headers, body).await;
}

pub struct StreamCacheWriter {
    cache_path: String,
    temp_path: String,
    writer: Option<BufWriter<File>>,
    published: bool,
}

impl StreamCacheWriter {
    pub async fn create(cache_key: &str, status: u16, headers: &HeaderMap) -> io::Result<Self> {
        let cache_path = get_stream_cache_path(cache_key);
        let temp_path = format!("{}.{}.tmp", cache_path, uuid::Uuid::new_v4());
        let file = File::create(&temp_path).await?;
        let mut writer = BufWriter::new(file);
        if let Err(error) = write_cache_header(&mut writer, status, headers).await {
            drop(writer);
            let _ = fs::remove_file(&temp_path).await;
            return Err(error);
        }
        Ok(Self {
            cache_path,
            temp_path,
            writer: Some(writer),
            published: false,
        })
    }

    pub async fn write(&mut self, chunk: &[u8]) -> io::Result<()> {
        let writer = self.writer.as_mut().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::BrokenPipe,
                "stream cache writer is closed... /ᐠ - ˕ -マ",
            )
        })?;
        writer.write_all(chunk).await
    }

    pub async fn commit(mut self) -> io::Result<()> {
        let mut writer = self.writer.take().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::BrokenPipe,
                "stream cache writer is closed... /ᐠ - ˕ -マ",
            )
        })?;
        writer.flush().await?;
        drop(writer);
        fs::rename(&self.temp_path, &self.cache_path).await?;
        self.published = true;
        Ok(())
    }
}

impl Drop for StreamCacheWriter {
    fn drop(&mut self) {
        if !self.published {
            self.writer.take();
            let _ = std::fs::remove_file(&self.temp_path);
        }
    }
}

pub async fn disk_cache_cleanup_task(
    max_bytes: u64,
    max_age_secs: u64,
    cleanup_interval_secs: u64,
) {
    let cache_dirs = ["./cache", "./cache/stream"];
    let base_interval = Duration::from_secs(cleanup_interval_secs.max(60));
    let mut next_interval = Duration::ZERO;
    loop {
        tokio::time::sleep(next_interval).await;
        let mut total_size = 0u64;
        let now = SystemTime::now();

        for cache_dir in &cache_dirs {
            let mut entries = match fs::read_dir(cache_dir).await {
                Ok(e) => e,
                Err(_) => continue,
            };

            while let Ok(Some(entry)) = entries.next_entry().await {
                if let Ok(metadata) = entry.metadata().await {
                    if metadata.is_file() {
                        let size = metadata.len();
                        let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                        let age_secs = now
                            .duration_since(modified)
                            .unwrap_or(Duration::from_secs(0))
                            .as_secs();

                        if age_secs > max_age_secs {
                            if fs::remove_file(entry.path()).await.is_ok() {
                                tracing::debug!(
                                    "deleted old cache entry {:?}{}",
                                    entry.path(),
                                    crate::POSITIVE
                                );
                            }
                            continue;
                        }
                        total_size += size;
                    }
                }
            }
        }

        if total_size <= max_bytes {
            next_interval = if total_size < max_bytes / 2 {
                base_interval.saturating_mul(2)
            } else {
                base_interval
            };
            continue;
        }

        let mut files = Vec::new();
        for cache_dir in &cache_dirs {
            let mut entries = match fs::read_dir(cache_dir).await {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            while let Ok(Some(entry)) = entries.next_entry().await {
                if let Ok(metadata) = entry.metadata().await {
                    if metadata.is_file() {
                        files.push((
                            entry.path(),
                            metadata.len(),
                            metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                        ));
                    }
                }
            }
        }
        files.sort_by_key(|&(_, _, modified)| modified);

        for (path, size, modified) in files {
            let age_secs = now
                .duration_since(modified)
                .unwrap_or(Duration::from_secs(0))
                .as_secs();
            if age_secs > max_age_secs || total_size > max_bytes {
                if fs::remove_file(&path).await.is_ok() {
                    total_size = total_size.saturating_sub(size);
                    tracing::debug!("deleted old cache entry {:?}{}", path, crate::POSITIVE);
                }
            } else if total_size <= max_bytes {
                break;
            }
        }
        next_interval = base_interval / 2;
    }
}

#[cfg(test)]
mod tests {
    use super::{get_stream_cache_path, load_stream_from_disk, StreamCacheWriter};
    use axum::http::{HeaderMap, HeaderValue, StatusCode};

    #[tokio::test]
    async fn dropped_stream_writers_leave_no_readable_or_temporary_entry() {
        tokio::fs::create_dir_all("./cache/stream").await.unwrap();
        let cache_key = format!("partial:{}", uuid::Uuid::new_v4());
        let cache_path = get_stream_cache_path(&cache_key);
        let mut headers = HeaderMap::new();
        headers.insert("Content-Length", HeaderValue::from_static("8"));
        let mut writer = StreamCacheWriter::create(&cache_key, StatusCode::OK.as_u16(), &headers)
            .await
            .unwrap();
        writer.write(b"part").await.unwrap();
        drop(writer);

        assert!(load_stream_from_disk(&cache_key, 1024, 60).await.is_none());
        assert!(!std::path::Path::new(&cache_path).exists());
        let temp_prefix = format!("{cache_path}.");
        let mut entries = tokio::fs::read_dir("./cache/stream").await.unwrap();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            assert!(!entry.path().to_string_lossy().starts_with(&temp_prefix));
        }
    }
}
