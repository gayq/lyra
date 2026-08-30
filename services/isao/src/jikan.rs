use crate::models::{AnimeEpisode, AnimeRelation};
use serde::Deserialize;

const JIKAN_BASE: &str = "https://api.jikan.moe/v4";

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
}

#[derive(Debug, Deserialize)]
struct JikanRelationsResponse {
    data: Option<Vec<JikanRelationGroup>>,
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

pub async fn fetch_episodes(client: &reqwest::Client, mal_id: i64) -> Vec<AnimeEpisode> {
    let mut episodes: Vec<AnimeEpisode> = Vec::new();
    let mut page = 1;
    let mut has_next = true;

    while has_next && episodes.len() < 2000 {
        let url = format!("{}/anime/{}/episodes?page={}", JIKAN_BASE, mal_id, page);
        let response = match client
            .get(&url)
            .header("User-Agent", "Mozilla/5.0")
            .send()
            .await
        {
            Ok(response) => response,
            Err(_) => break,
        };
        if !response.status().is_success() {
            break;
        }

        let payload: JikanEpisodeResponse = match response.json().await {
            Ok(payload) => payload,
            Err(_) => break,
        };

        let items = payload.data.unwrap_or_default();
        if items.is_empty() {
            break;
        }

        let offset = episodes.len() as i32;
        for (index, episode) in items.into_iter().enumerate() {
            episodes.push(AnimeEpisode {
                mal_id: episode.mal_id,
                number: offset + index as i32 + 1,
                title: episode.title,
            });
        }

        has_next = payload
            .pagination
            .and_then(|pagination| pagination.has_next_page)
            .unwrap_or(false);
        page += 1;
    }

    episodes
}

pub async fn fetch_relations(client: &reqwest::Client, mal_id: i64) -> Option<Vec<AnimeRelation>> {
    let url = format!("{}/anime/{}/relations", JIKAN_BASE, mal_id);
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

    let payload: JikanRelationsResponse = match response.json().await {
        Ok(payload) => payload,
        Err(_) => return None,
    };

    let relevant = ["Sequel", "Prequel"];
    let mut relations: Vec<AnimeRelation> = Vec::new();

    for group in payload.data.unwrap_or_default() {
        if !relevant.contains(&group.relation.as_str()) {
            continue;
        }
        for entry in group.entry.unwrap_or_default() {
            if entry.entry_type == "anime" {
                relations.push(AnimeRelation {
                    mal_id: entry.mal_id,
                    name: entry.name,
                    relation: group.relation.clone(),
                    format: None,
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
