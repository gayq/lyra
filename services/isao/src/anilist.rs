use serde::Deserialize;
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const ANILIST_URL: &str = "https://graphql.anilist.co";

static LAST_ANILIST_REQUEST: LazyLock<Mutex<Instant>> =
    LazyLock::new(|| Mutex::new(Instant::now() - Duration::from_secs(2)));

pub async fn wait_for_slot() {
    let mut last = LAST_ANILIST_REQUEST.lock().await;
    let elapsed = last.elapsed();
    if elapsed < Duration::from_secs(1) {
        tokio::time::sleep(Duration::from_secs(1) - elapsed).await;
    }
    *last = Instant::now();
}

#[derive(Debug, Deserialize)]
struct AniListResponse {
    data: Option<AniListData>,
}

#[derive(Debug, Deserialize)]
struct AniListData {
    #[serde(rename = "Media")]
    media: Option<AniListMedia>,
}

#[derive(Debug, Deserialize)]
struct AniListMedia {
    title: Option<AniListTitle>,
    synonyms: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct AniListTitle {
    romaji: Option<String>,
    english: Option<String>,
    native: Option<String>,
}

pub async fn fetch_alt_titles(client: &reqwest::Client, anilist_id: i64) -> Vec<String> {
    wait_for_slot().await;

    let query = r#"
        query($id:Int) {
            Media(id:$id) {
                title { romaji english native }
                synonyms
            }
        }
    "#;

    let body = serde_json::json!({
        "query": query,
        "variables": { "id": anilist_id }
    });

    let response = match client
        .post(ANILIST_URL)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return vec![],
    };
    if !response.status().is_success() {
        return vec![];
    }

    let payload: AniListResponse = match response.json().await {
        Ok(payload) => payload,
        Err(_) => return vec![],
    };

    let media = match payload.data.and_then(|payload| payload.media) {
        Some(media) => media,
        None => return vec![],
    };

    let mut titles: Vec<String> = Vec::new();
    if let Some(title) = &media.title {
        if let Some(value) = &title.romaji {
            titles.push(value.clone());
        }
        if let Some(value) = &title.english {
            titles.push(value.clone());
        }
        if let Some(value) = &title.native {
            titles.push(value.clone());
        }
    }
    if let Some(synonyms) = media.synonyms {
        titles.extend(synonyms);
    }
    titles.retain(|t| !t.is_empty());
    titles.dedup();
    titles
}
