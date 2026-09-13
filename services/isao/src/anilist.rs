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
    if elapsed < Duration::from_secs(2) {
        tokio::time::sleep(Duration::from_secs(2) - elapsed).await;
    }
    *last = Instant::now();
}

#[derive(Debug, Deserialize)]
struct AniListResponse {
    data: Option<AniListData>,
    errors: Option<Vec<serde_json::Value>>,
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
    #[serde(rename = "idMal")]
    mal_id: Option<i64>,
    #[serde(rename = "type")]
    media_type: Option<String>,
    format: Option<String>,
    episodes: Option<i32>,
    #[serde(rename = "nextAiringEpisode")]
    next_airing_episode: Option<AniListAiringEpisode>,
    #[serde(rename = "startDate")]
    start_date: Option<AniListDate>,
    relations: Option<AniListRelations>,
}

#[derive(Debug, Deserialize)]
struct AniListAiringEpisode {
    episode: i32,
}

fn episode_count(media: &AniListMedia, mal_id: i64) -> Option<i32> {
    if media.mal_id != Some(mal_id) {
        return None;
    }
    media.episodes.filter(|count| *count > 0).or_else(|| {
        media
            .next_airing_episode
            .as_ref()
            .map(|airing| airing.episode - 1)
            .filter(|count| *count > 0)
    })
}

pub async fn fetch_episode_count(client: &reqwest::Client, mal_id: i64) -> Option<i32> {
    wait_for_slot().await;
    let response = client.post(ANILIST_URL).json(&serde_json::json!({
        "query": "query($id: Int) { Media(idMal: $id, type: ANIME) { idMal episodes nextAiringEpisode { episode } } }",
        "variables": {"id": mal_id}
    })).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let payload: AniListResponse = response.json().await.ok()?;
    if payload.errors.is_some_and(|errors| !errors.is_empty()) {
        return None;
    }
    episode_count(&payload.data?.media?, mal_id)
}

#[derive(Debug, Deserialize)]
struct AniListDate {
    year: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct AniListRelations {
    edges: Vec<AniListRelation>,
}

#[derive(Debug, Deserialize)]
struct AniListRelation {
    #[serde(rename = "relationType")]
    relation_type: String,
    node: AniListMedia,
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

pub async fn fetch_relations(
    client: &reqwest::Client,
    mal_id: i64,
) -> Option<Vec<crate::models::AnimeRelation>> {
    wait_for_slot().await;
    let response = client
        .post(ANILIST_URL)
        .json(&serde_json::json!({
            "query": r#"query($id: Int) {
            Media(idMal: $id, type: ANIME) {
                idMal type title { romaji english native } format episodes startDate { year }
                relations { edges { relationType node {
                    idMal type title { romaji english native } format episodes startDate { year }
                } } }
            }
        }"#,
            "variables": {"id": mal_id}
        }))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let payload: AniListResponse = response.json().await.ok()?;
    if payload.errors.is_some_and(|errors| !errors.is_empty()) {
        return None;
    }
    relations_from_media(payload.data?.media?, mal_id)
}

fn relation_from_media(
    media: &AniListMedia,
    relation: &str,
) -> Option<crate::models::AnimeRelation> {
    let title = media.title.as_ref()?;
    Some(crate::models::AnimeRelation {
        mal_id: media.mal_id?,
        name: title
            .romaji
            .as_ref()
            .or(title.english.as_ref())
            .or(title.native.as_ref())?
            .clone(),
        relation: relation.into(),
        format: media.format.clone(),
        year: media.start_date.as_ref().and_then(|date| date.year),
        episode_count: media.episodes.filter(|count| *count > 0),
        source: Some("anilist".into()),
    })
}

fn relations_from_media(
    media: AniListMedia,
    mal_id: i64,
) -> Option<Vec<crate::models::AnimeRelation>> {
    if media.mal_id != Some(mal_id) {
        return None;
    }
    let mut result = vec![relation_from_media(&media, "Self")?];
    for edge in media.relations?.edges {
        if !["PREQUEL", "SEQUEL"].contains(&edge.relation_type.as_str())
            || edge.node.media_type.as_deref() != Some("ANIME")
        {
            continue;
        }
        result.push(relation_from_media(&edge.node, &edge.relation_type)?);
    }
    Some(result)
}