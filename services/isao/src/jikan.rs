use crate::models::{AnimeEpisode, AnimeRelation};
use serde::Deserialize;
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const JIKAN_BASE: &str = "https://api.jikan.moe/v4";

static LAST_REQUEST: LazyLock<Mutex<Instant>> =
    LazyLock::new(|| Mutex::new(Instant::now() - Duration::from_secs(1)));

async fn wait_for_slot() {
    let mut last = LAST_REQUEST.lock().await;
    let interval = Duration::from_secs(1);
    if last.elapsed() < interval {
        tokio::time::sleep(interval - last.elapsed()).await;
    }
    *last = Instant::now();
}

#[derive(Debug, Deserialize)]
struct JikanEpisodeResponse {
    data: Option<Vec<JikanEpisode>>,
    pagination: Option<JikanPagination>,
}

#[derive(Debug, Deserialize)]
struct JikanEpisode {
    mal_id: i64,
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JikanPagination {
    has_next_page: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct JikanFullResponse {
    data: Option<JikanFullData>,
}

#[derive(Debug, Deserialize)]
struct JikanFullData {
    episodes: Option<i32>,
    mal_id: Option<i64>,
    title: Option<String>,
    #[serde(rename = "type")]
    format: Option<String>,
    aired: Option<JikanAired>,
    relations: Option<Vec<JikanRelationGroup>>,
}

#[derive(Debug, Deserialize)]
struct JikanAired {
    prop: Option<JikanDateParts>,
}

#[derive(Debug, Deserialize)]
struct JikanDateParts {
    from: Option<JikanDate>,
}

#[derive(Debug, Deserialize)]
struct JikanDate {
    year: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct JikanRelationGroup {
    relation: String,
    entry: Option<Vec<JikanRelationEntry>>,
}

#[derive(Debug, Deserialize)]
struct JikanRelationEntry {
    mal_id: i64,
    name: String,
    #[serde(rename = "type")]
    entry_type: String,
}

pub async fn fetch_episode_count(client: &reqwest::Client, mal_id: i64) -> i32 {
    wait_for_slot().await;
    let url = format!("{}/anime/{}/full", JIKAN_BASE, mal_id);
    let response = match client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0")
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return 0,
    };
    if !response.status().is_success() {
        return 0;
    }

    let payload: JikanFullResponse = match response.json().await {
        Ok(payload) => payload,
        Err(_) => return 0,
    };
    payload.data.and_then(|anime| anime.episodes).unwrap_or(0)
}

pub async fn fetch_episodes(client: &reqwest::Client, mal_id: i64) -> Option<Vec<AnimeEpisode>> {
    let mut episodes: Vec<AnimeEpisode> = Vec::new();
    let mut page = 1;
    let mut has_next = true;

    while has_next && episodes.len() < 2000 {
        wait_for_slot().await;
        let url = format!("{}/anime/{}/episodes?page={}", JIKAN_BASE, mal_id, page);
        let response = match client
            .get(&url)
            .header("User-Agent", "Mozilla/5.0")
            .send()
            .await
        {
            Ok(response) => response,
            Err(_) => return None,
        };
        if !response.status().is_success() {
            return None;
        }

        let payload: JikanEpisodeResponse = match response.json().await {
            Ok(payload) => payload,
            Err(_) => return None,
        };

        let items = payload.data?;
        if items.is_empty() {
            break;
        }

        for episode in items {
            episodes.push(AnimeEpisode {
                mal_id: episode.mal_id,
                number: episode.mal_id as i32,
                title: episode.title,
            });
        }

        has_next = payload
            .pagination
            .and_then(|pagination| pagination.has_next_page)
            .unwrap_or(false);
        page += 1;
    }

    if has_next {
        None
    } else {
        Some(episodes)
    }
}

pub async fn fetch_relations(client: &reqwest::Client, mal_id: i64) -> Option<Vec<AnimeRelation>> {
    wait_for_slot().await;
    let url = format!("{}/anime/{}/full", JIKAN_BASE, mal_id);
    let response = match client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0")
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return None,
    };
    if !response.status().is_success() {
        return None;
    }

    let payload: JikanFullResponse = match response.json().await {
        Ok(payload) => payload,
        Err(_) => return None,
    };

    relations_from_full(payload.data?, mal_id)
}

fn relations_from_full(anime: JikanFullData, mal_id: i64) -> Option<Vec<AnimeRelation>> {
    if anime.mal_id? != mal_id {
        return None;
    }
    let mut relations = vec![AnimeRelation {
        mal_id,
        name: anime.title?,
        relation: "Self".into(),
        format: anime.format,
        year: anime
            .aired
            .and_then(|aired| aired.prop)
            .and_then(|prop| prop.from)
            .and_then(|date| date.year),
        episode_count: anime.episodes.filter(|count| *count > 0),
        source: Some("jikan".into()),
    }];

    for group in anime.relations? {
        if !["Sequel", "Prequel"].contains(&group.relation.as_str()) {
            continue;
        }
        for entry in group.entry.unwrap_or_default() {
            if entry.entry_type == "anime" {
                relations.push(AnimeRelation {
                    mal_id: entry.mal_id,
                    name: entry.name,
                    relation: group.relation.clone(),
                    format: None,
                    year: None,
                    episode_count: None,
                    source: None,
                });
            }
        }
    }

    relations.sort_by(|a, b| {
        if a.relation == b.relation {
            std::cmp::Ordering::Equal
        } else if a.relation == "Prequel" {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });

    Some(relations)
}