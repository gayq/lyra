use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnimeEpisode {
    pub mal_id: i64,
    pub number: i32,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnimeRelation {
    pub mal_id: i64,
    pub name: String,
    pub relation: String,
    pub format: Option<String>,
    pub year: Option<i32>,
    pub episode_count: Option<i32>,
    pub source: Option<String>,
}
