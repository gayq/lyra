use reqwest::{header::USER_AGENT, Url};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

const ANILIST_URL: &str = "https://graphql.anilist.co";
const KITSU_BASE: &str = "https://kitsu.io/api/edge";
const IDENTITY_USER_AGENT: &str = "lyra-anime-identity/1.0";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeIds {
    pub anilist: Option<String>,
    pub mal: Option<String>,
    pub anidb: Option<String>,
    pub kitsu: Option<String>,
    pub tmdb: Option<String>,
    pub tmdb_season: Option<String>,
    pub imdb: Option<String>,
    pub tvdb: Option<String>,
    pub tvdb_season: Option<String>,
    pub anime_planet: Option<String>,
    pub live_chart: Option<String>,
    pub anime_news_network: Option<String>,
    pub ani_search: Option<String>,
    pub simkl: Option<String>,
    pub anime_countdown: Option<String>,
    pub anikoto: Option<String>,
    pub anikoto_episode: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeIdentity {
    pub ids: AnimeIds,
    pub titles: Vec<String>,
    pub year: Option<i32>,
    pub season: Option<String>,
    pub format: Option<String>,
    pub episodes: Option<i32>,
    pub mapping_confidence: Option<String>,
    pub mapping_sources: Vec<String>,
    pub mapping_warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RawAnimeIds {
    anilist: Option<Value>,
    mal: Option<Value>,
    anidb: Option<Value>,
    kitsu: Option<Value>,
    tmdb: Option<Value>,
    tmdb_season: Option<Value>,
    imdb: Option<Value>,
    tvdb: Option<Value>,
    tvdb_season: Option<Value>,
    anime_planet: Option<Value>,
    live_chart: Option<Value>,
    anime_news_network: Option<Value>,
    ani_search: Option<Value>,
    simkl: Option<Value>,
    anime_countdown: Option<Value>,
    anikoto: Option<Value>,
    anikoto_episode: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct IdentityRequest {
    pub ids: Option<RawAnimeIds>,
    #[serde(alias = "anilistId")]
    pub anilist_id: Option<Value>,
    #[serde(alias = "malId")]
    pub mal_id: Option<Value>,
    pub title: Option<String>,
    pub year: Option<i32>,
    pub season: Option<String>,
    pub format: Option<String>,
}

impl IdentityRequest {
    pub fn normalized_ids(&self) -> AnimeIds {
        let mut ids = AnimeIds::default();
        if let Some(raw) = &self.ids {
            set_id(&mut ids, "anilist", raw.anilist.as_ref());
            set_id(&mut ids, "mal", raw.mal.as_ref());
            set_id(&mut ids, "anidb", raw.anidb.as_ref());
            set_id(&mut ids, "kitsu", raw.kitsu.as_ref());
            set_id(&mut ids, "tmdb", raw.tmdb.as_ref());
            set_id(&mut ids, "tmdbSeason", raw.tmdb_season.as_ref());
            set_id(&mut ids, "imdb", raw.imdb.as_ref());
            set_id(&mut ids, "tvdb", raw.tvdb.as_ref());
            set_id(&mut ids, "tvdbSeason", raw.tvdb_season.as_ref());
            set_id(&mut ids, "animePlanet", raw.anime_planet.as_ref());
            set_id(&mut ids, "liveChart", raw.live_chart.as_ref());
            set_id(
                &mut ids,
                "animeNewsNetwork",
                raw.anime_news_network.as_ref(),
            );
            set_id(&mut ids, "aniSearch", raw.ani_search.as_ref());
            set_id(&mut ids, "simkl", raw.simkl.as_ref());
            set_id(&mut ids, "animeCountdown", raw.anime_countdown.as_ref());
            set_id(&mut ids, "anikoto", raw.anikoto.as_ref());
            set_id(&mut ids, "anikotoEpisode", raw.anikoto_episode.as_ref());
        }
        set_id(&mut ids, "anilist", self.anilist_id.as_ref());
        set_id(&mut ids, "mal", self.mal_id.as_ref());
        ids
    }
}

pub fn cache_key(request: &IdentityRequest) -> String {
    let ids = request.normalized_ids();
    format!(
        "{:?}|{}|{}|{}|{}",
        ids,
        request
            .title
            .as_deref()
            .unwrap_or_default()
            .trim()
            .to_lowercase(),
        request.year.unwrap_or_default(),
        request.season.as_deref().unwrap_or_default().to_lowercase(),
        request.format.as_deref().unwrap_or_default().to_lowercase(),
    )
}

fn value_id(value: Option<&Value>) -> Option<String> {
    let value = value?;
    match value {
        Value::String(value) => {
            let value = value.trim();
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            if value.bytes().all(|byte| byte.is_ascii_digit())
                && value.bytes().all(|byte| byte == b'0')
            {
                return None;
            }
            Some(value.to_string())
        }
        Value::Number(value) => {
            (value.as_i64().map(|number| number > 0).unwrap_or(true)).then(|| value.to_string())
        }
        _ => None,
    }
}

fn set_id(ids: &mut AnimeIds, provider: &str, value: Option<&Value>) {
    let Some(value) = value_id(value) else { return };
    set_id_string(ids, provider, value);
}

fn set_id_string(ids: &mut AnimeIds, provider: &str, value: String) {
    let slot = match provider {
        "anilist" => &mut ids.anilist,
        "mal" => &mut ids.mal,
        "anidb" => &mut ids.anidb,
        "kitsu" => &mut ids.kitsu,
        "tmdb" => &mut ids.tmdb,
        "tmdbSeason" => &mut ids.tmdb_season,
        "imdb" => &mut ids.imdb,
        "tvdb" => &mut ids.tvdb,
        "tvdbSeason" => &mut ids.tvdb_season,
        "animePlanet" => &mut ids.anime_planet,
        "liveChart" => &mut ids.live_chart,
        "animeNewsNetwork" => &mut ids.anime_news_network,
        "aniSearch" => &mut ids.ani_search,
        "simkl" => &mut ids.simkl,
        "animeCountdown" => &mut ids.anime_countdown,
        "anikoto" => &mut ids.anikoto,
        "anikotoEpisode" => &mut ids.anikoto_episode,
        _ => return,
    };
    if slot.is_none() {
        *slot = Some(value);
    }
}

fn push_unique(values: &mut Vec<String>, value: impl Into<String>) {
    let value = value.into();
    if !value.trim().is_empty() && !values.iter().any(|item| item == &value) {
        values.push(value);
    }
}

fn add_source(identity: &mut AnimeIdentity, source: &str) {
    push_unique(&mut identity.mapping_sources, source.to_string());
}

fn add_warning(identity: &mut AnimeIdentity, warning: impl Into<String>) {
    let warning = warning.into();
    push_unique(
        &mut identity.mapping_warnings,
        crate::negative_message(&warning),
    );
}

async fn get_json<T: DeserializeOwned>(client: &reqwest::Client, url: &str) -> Option<T> {
    let response = client
        .get(url)
        .header(USER_AGENT, IDENTITY_USER_AGENT)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json().await.ok()
}

#[derive(Debug, Deserialize)]
struct AniListEnvelope {
    data: Option<AniListData>,
}

#[derive(Debug, Deserialize)]
struct AniListData {
    #[serde(rename = "Media")]
    media: Option<AniListMedia>,
    #[serde(rename = "Page")]
    page: Option<AniListPage>,
}

#[derive(Debug, Deserialize)]
struct AniListPage {
    media: Option<Vec<AniListMedia>>,
}

#[derive(Debug, Clone, Deserialize)]
struct AniListMedia {
    id: i64,
    #[serde(rename = "idMal")]
    id_mal: Option<i64>,
    title: Option<TitleSet>,
    synonyms: Option<Vec<String>>,
    format: Option<String>,
    season: Option<String>,
    #[serde(rename = "seasonYear")]
    season_year: Option<i32>,
    episodes: Option<i32>,
    #[serde(rename = "startDate")]
    start_date: Option<DateSet>,
    #[serde(rename = "externalLinks")]
    external_links: Option<Vec<ExternalLink>>,
}

#[derive(Debug, Clone, Deserialize)]
struct TitleSet {
    romaji: Option<String>,
    english: Option<String>,
    native: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct DateSet {
    year: Option<i32>,
}

#[derive(Debug, Clone, Deserialize)]
struct ExternalLink {
    site: Option<String>,
    url: Option<String>,
}

async fn anilist_request(
    client: &reqwest::Client,
    query: &str,
    variables: Value,
) -> Option<AniListEnvelope> {
    crate::anilist::wait_for_slot().await;
    for attempt in 0..3 {
        let response = client
            .post(ANILIST_URL)
            .header(USER_AGENT, IDENTITY_USER_AGENT)
            .header("Content-Type", "application/json")
            .json(&json!({ "query": query, "variables": variables }))
            .send()
            .await
            .ok()?;
        if response.status().as_u16() == 429 || response.status().is_server_error() {
            tokio::time::sleep(Duration::from_millis(500 * (attempt + 1))).await;
            continue;
        }
        if !response.status().is_success() {
            return None;
        }
        return response.json().await.ok();
    }
    None
}

async fn fetch_anilist(client: &reqwest::Client, id: &str) -> Option<AniListMedia> {
    let id = id.parse::<i64>().ok()?;
    let query = r#"
      query($id:Int) {
        Media(id:$id, type:ANIME) {
          id idMal title { romaji english native } synonyms format season seasonYear episodes
          startDate { year }
          externalLinks { site url }
        }
      }
    "#;
    anilist_request(client, query, json!({ "id": id }))
        .await
        .and_then(|response| response.data?.media)
}

async fn search_anilist(client: &reqwest::Client, title: &str) -> Vec<AniListMedia> {
    let query = r#"
      query($search:String) {
        Page(perPage:10) {
          media(search:$search, type:ANIME) {
            id idMal title { romaji english native } synonyms format season seasonYear episodes
            startDate { year }
            externalLinks { site url }
          }
        }
      }
    "#;
    anilist_request(client, query, json!({ "search": title }))
        .await
        .and_then(|response| response.data?.page?.media)
        .unwrap_or_default()
}

fn media_titles(media: &AniListMedia) -> Vec<String> {
    let mut titles = Vec::new();
    if let Some(title) = &media.title {
        if let Some(value) = &title.romaji {
            push_unique(&mut titles, value);
        }
        if let Some(value) = &title.english {
            push_unique(&mut titles, value);
        }
        if let Some(value) = &title.native {
            push_unique(&mut titles, value);
        }
    }
    for title in media.synonyms.as_deref().unwrap_or_default() {
        push_unique(&mut titles, title.as_str());
    }
    titles
}

fn merge_anilist(identity: &mut AnimeIdentity, media: &AniListMedia, source: &str) {
    set_id_string(&mut identity.ids, "anilist", media.id.to_string());
    if let Some(mal) = media.id_mal {
        set_id_string(&mut identity.ids, "mal", mal.to_string());
    }
    for title in media_titles(media) {
        push_unique(&mut identity.titles, title);
    }
    identity.year = identity
        .year
        .or(media.season_year)
        .or_else(|| media.start_date.as_ref().and_then(|date| date.year));
    identity.season = identity.season.clone().or_else(|| media.season.clone());
    identity.format = identity.format.clone().or_else(|| media.format.clone());
    identity.episodes = identity.episodes.or(media.episodes);
    add_source(identity, source);
    for link in media.external_links.as_deref().unwrap_or_default() {
        if let (Some(site), Some(url)) = (link.site.as_deref(), link.url.as_deref()) {
            if let Some((provider, id)) = external_link_id(site, url) {
                set_id_string(&mut identity.ids, provider, id);
            }
        }
    }
}

#[derive(Debug, Deserialize)]
struct KitsuObjectResponse {
    data: Option<KitsuResource>,
}

#[derive(Debug, Deserialize)]
struct KitsuListResponse {
    data: Option<Vec<KitsuResource>>,
}

#[derive(Debug, Clone, Deserialize)]
struct KitsuResource {
    id: String,
    attributes: Option<KitsuAttributes>,
}

#[derive(Debug, Clone, Deserialize)]
struct KitsuAttributes {
    #[serde(rename = "canonicalTitle")]
    canonical_title: Option<String>,
    titles: Option<std::collections::HashMap<String, String>>,
    #[serde(rename = "startDate")]
    start_date: Option<String>,
    subtype: Option<String>,
    #[serde(rename = "episodeCount")]
    episode_count: Option<i32>,
    #[serde(rename = "externalSite")]
    external_site: Option<String>,
    #[serde(rename = "externalId")]
    external_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AnikotoSeriesResponse {
    data: Option<AnikotoSeriesData>,
}

#[derive(Debug, Deserialize)]
struct AnikotoSeriesData {
    anime: Option<AnikotoAnime>,
}

#[derive(Debug, Deserialize)]
struct AnikotoAnime {
    title: Option<String>,
    alternative: Option<String>,
    titles: Option<String>,
    native: Option<String>,
    year: Option<i32>,
    season: Option<String>,
    episodes: Option<Value>,
    mal_id: Option<Value>,
    ani_id: Option<Value>,
    #[serde(rename = "terms_by_type")]
    terms_by_type: Option<std::collections::HashMap<String, Vec<String>>>,
}

async fn fetch_anikoto_series(client: &reqwest::Client, anikoto_id: &str) -> Option<AnikotoAnime> {
    let url = format!("https://anikotoapi.site/series/{anikoto_id}");
    get_json::<AnikotoSeriesResponse>(client, &url)
        .await
        .and_then(|response| response.data)
        .and_then(|data| data.anime)
}

fn merge_anikoto(identity: &mut AnimeIdentity, anikoto_id: &str, anime: &AnikotoAnime) {
    set_id_string(&mut identity.ids, "anikoto", anikoto_id.to_string());
    for title in [
        anime.title.as_deref(),
        anime.alternative.as_deref(),
        anime.titles.as_deref(),
        anime.native.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        push_unique(&mut identity.titles, title);
    }
    identity.year = identity.year.or(anime.year);
    identity.season = identity.season.clone().or_else(|| anime.season.clone());
    identity.episodes = identity
        .episodes
        .or_else(|| value_id(anime.episodes.as_ref()).and_then(|value| value.parse::<i32>().ok()));
    if identity.format.is_none() {
        identity.format = anime
            .terms_by_type
            .as_ref()
            .and_then(|terms| terms.get("type"))
            .and_then(|types| types.first())
            .cloned();
    }
    set_id(&mut identity.ids, "mal", anime.mal_id.as_ref());
    set_id(&mut identity.ids, "anilist", anime.ani_id.as_ref());
    add_source(identity, "anikoto");
}

async fn search_kitsu(client: &reqwest::Client, title: &str) -> Vec<KitsuResource> {
    let mut url = match Url::parse(&format!("{KITSU_BASE}/anime")) {
        Ok(url) => url,
        Err(_) => return Vec::new(),
    };
    url.query_pairs_mut()
        .append_pair("filter[text]", title)
        .append_pair("page[limit]", "20");
    get_json::<KitsuListResponse>(client, url.as_str())
        .await
        .and_then(|response| response.data)
        .unwrap_or_default()
}

fn kitsu_resource_titles(resource: &KitsuResource) -> Vec<String> {
    let mut titles = Vec::new();
    if let Some(attributes) = &resource.attributes {
        if let Some(title) = &attributes.canonical_title {
            push_unique(&mut titles, title);
        }
        if let Some(values) = &attributes.titles {
            for title in values.values() {
                push_unique(&mut titles, title);
            }
        }
    }
    titles
}

fn kitsu_title_matches(
    resource: &KitsuResource,
    requested_title: &str,
    requested_year: Option<i32>,
    requested_format: Option<&str>,
) -> bool {
    let Some(attributes) = &resource.attributes else {
        return false;
    };
    if !kitsu_resource_titles(resource)
        .iter()
        .any(|title| normalize_title(title) == normalize_title(requested_title))
    {
        return false;
    }
    if let (Some(expected), Some(actual)) = (
        requested_year,
        attributes
            .start_date
            .as_deref()
            .and_then(|date| date.get(0..4))
            .and_then(|year| year.parse::<i32>().ok()),
    ) {
        if expected != actual {
            return false;
        }
    }
    format_matches(requested_format, attributes.subtype.as_deref())
}

fn kitsu_sites(ids: &AnimeIds) -> Vec<(&'static str, String)> {
    let mut values = Vec::new();
    if let Some(id) = &ids.anilist {
        values.push(("anilist/anime", id.clone()));
    }
    if let Some(id) = &ids.mal {
        values.push(("myanimelist/anime", id.clone()));
    }
    if let Some(id) = &ids.anidb {
        values.push(("anidb", id.clone()));
    }
    if let Some(id) = &ids.imdb {
        values.push(("imdb", id.clone()));
    }
    if let Some(id) = &ids.tvdb {
        values.push(("thetvdb/series", id.clone()));
    }
    if let Some(id) = &ids.tvdb_season {
        values.push(("thetvdb/season", id.clone()));
    }
    if let Some(id) = &ids.tmdb {
        values.push(("themoviedb/tv", id.clone()));
        values.push(("themoviedb/movie", id.clone()));
    }
    if let Some(id) = &ids.tmdb_season {
        values.push(("themoviedb/season", id.clone()));
    }
    if let Some(id) = &ids.anime_planet {
        values.push(("anime-planet/anime", id.clone()));
    }
    if let Some(id) = &ids.live_chart {
        values.push(("livechart", id.clone()));
    }
    if let Some(id) = &ids.ani_search {
        values.push(("anisearch", id.clone()));
    }
    if let Some(id) = &ids.anime_news_network {
        values.push(("animenewsnetwork", id.clone()));
    }
    values
}

async fn fetch_kitsu_mappings(
    client: &reqwest::Client,
    kitsu_id: &str,
) -> Option<Vec<KitsuResource>> {
    let url = format!("{KITSU_BASE}/anime/{kitsu_id}/mappings");
    get_json::<KitsuListResponse>(client, &url)
        .await
        .and_then(|response| response.data)
}

async fn fetch_kitsu_for_ids(
    client: &reqwest::Client,
    ids: &AnimeIds,
) -> Option<(KitsuResource, Vec<KitsuResource>)> {
    if let Some(kitsu_id) = &ids.kitsu {
        let mappings = fetch_kitsu_mappings(client, kitsu_id).await?;
        let anime_url = format!("{KITSU_BASE}/anime/{kitsu_id}");
        let anime = get_json::<KitsuObjectResponse>(client, &anime_url)
            .await
            .and_then(|response| response.data)
            .unwrap_or_else(|| KitsuResource {
                id: kitsu_id.clone(),
                attributes: None,
            });
        return Some((anime, mappings));
    }

    for (site, external_id) in kitsu_sites(ids) {
        let Ok(response) = client
            .get(format!("{KITSU_BASE}/mappings"))
            .query(&[
                ("filter[external_site]", site),
                ("filter[external_id]", external_id.as_str()),
            ])
            .header(USER_AGENT, IDENTITY_USER_AGENT)
            .send()
            .await
        else {
            continue;
        };
        if !response.status().is_success() {
            continue;
        }
        let Ok(mappings) = response.json::<KitsuListResponse>().await else {
            continue;
        };
        let Some(mapping) = mappings.data.and_then(|items| items.into_iter().next()) else {
            continue;
        };
        let mapping_id = mapping.id;
        let item_url = format!("{KITSU_BASE}/mappings/{mapping_id}/item");
        let Some(anime) = get_json::<KitsuObjectResponse>(client, &item_url)
            .await
            .and_then(|response| response.data)
        else {
            continue;
        };
        let Some(all_mappings) = fetch_kitsu_mappings(client, &anime.id).await else {
            continue;
        };
        return Some((anime, all_mappings));
    }
    None
}

fn merge_kitsu(identity: &mut AnimeIdentity, anime: &KitsuResource, mappings: &[KitsuResource]) {
    set_id_string(&mut identity.ids, "kitsu", anime.id.clone());
    if let Some(attributes) = &anime.attributes {
        if let Some(title) = &attributes.canonical_title {
            push_unique(&mut identity.titles, title);
        }
        if let Some(titles) = &attributes.titles {
            for title in titles.values() {
                push_unique(&mut identity.titles, title);
            }
        }
        identity.year = identity.year.or_else(|| {
            attributes
                .start_date
                .as_deref()
                .and_then(|date| date.get(0..4))
                .and_then(|year| year.parse().ok())
        });
        identity.format = identity
            .format
            .clone()
            .or_else(|| attributes.subtype.clone());
        identity.episodes = identity.episodes.or(attributes.episode_count);
    }
    for mapping in mappings {
        let Some(attributes) = &mapping.attributes else {
            continue;
        };
        let (Some(site), Some(external_id)) = (
            attributes.external_site.as_deref(),
            attributes.external_id.as_deref(),
        ) else {
            continue;
        };
        if let Some((provider, id)) = kitsu_mapping_id(site, external_id) {
            set_id_string(&mut identity.ids, provider, id);
        }
    }
    add_source(identity, "kitsu");
}

fn kitsu_mapping_id(site: &str, external_id: &str) -> Option<(&'static str, String)> {
    let site = site.to_ascii_lowercase();
    let provider = match site.as_str() {
        "myanimelist/anime" => "mal",
        "anilist/anime" => "anilist",
        "anidb" => "anidb",
        "imdb" | "imdb/title" => "imdb",
        "thetvdb/series" | "thetvdb" => "tvdb",
        "thetvdb/season" => "tvdbSeason",
        "themoviedb/tv" | "themoviedb/movie" | "themoviedb" => "tmdb",
        "themoviedb/season" => "tmdbSeason",
        "anime-planet/anime" | "anime-planet" => "animePlanet",
        "livechart" | "livechart/me" => "liveChart",
        "animenewsnetwork" | "animenewsnetwork/encyclopedia" => "animeNewsNetwork",
        "anisearch" => "aniSearch",
        "simkl" => "simkl",
        "animecountdown" => "animeCountdown",
        _ => return None,
    };
    Some((provider, external_id.to_string()))
}

fn final_path_segment(url: &str) -> Option<String> {
    let without_query = url.split(['?', '#']).next()?;
    without_query
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn external_link_id(site: &str, url: &str) -> Option<(&'static str, String)> {
    let site = site.to_ascii_lowercase().replace(['_', ' ', '-'], "");
    if site.contains("anidb") {
        if let Some(id) = url
            .split(['?', '&'])
            .find_map(|part| part.strip_prefix("aid="))
        {
            return Some(("anidb", id.to_string()));
        }
    }
    let id = final_path_segment(url)?;
    if site.contains("imdb") {
        return Some(("imdb", id));
    }
    if site.contains("anidb") {
        return Some(("anidb", id));
    }
    if site.contains("kitsu") {
        return Some(("kitsu", id));
    }
    if site.contains("anilist") {
        return Some(("anilist", id));
    }
    if site.contains("myanimelist") || site == "mal" {
        return Some(("mal", id));
    }
    if site.contains("animeplanet") {
        return Some(("animePlanet", id));
    }
    if site.contains("livechart") {
        return Some(("liveChart", id));
    }
    if site.contains("themoviedb") || site == "tmdb" {
        return Some(("tmdb", id));
    }
    if site.contains("thetvdb") || site == "tvdb" {
        return Some(("tvdb", id));
    }
    if site.contains("animenewsnetwork") {
        return Some(("animeNewsNetwork", id));
    }
    if site.contains("anisearch") {
        return Some(("aniSearch", id));
    }
    None
}

fn merge_jikan(identity: &mut AnimeIdentity, response: &Value) {
    let Some(payload) = response.get("data") else {
        return;
    };
    if let Some(id) = payload.get("mal_id").and_then(Value::as_i64) {
        set_id_string(&mut identity.ids, "mal", id.to_string());
    }
    for key in ["title", "title_english", "title_japanese"] {
        if let Some(title) = payload.get(key).and_then(Value::as_str) {
            push_unique(&mut identity.titles, title);
        }
    }
    if let Some(synonyms) = payload.get("title_synonyms").and_then(Value::as_array) {
        for title in synonyms.iter().filter_map(Value::as_str) {
            push_unique(&mut identity.titles, title);
        }
    }
    identity.year = identity.year.or_else(|| {
        payload
            .get("year")
            .and_then(Value::as_i64)
            .map(|year| year as i32)
    });
    identity.format = identity.format.clone().or_else(|| {
        payload
            .get("type")
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    identity.episodes = identity.episodes.or_else(|| {
        payload
            .get("episodes")
            .and_then(Value::as_i64)
            .map(|episodes| episodes as i32)
    });
    if let Some(external) = payload.get("external").and_then(Value::as_array) {
        for link in external {
            let site = link.get("name").and_then(Value::as_str);
            let url = link.get("url").and_then(Value::as_str);
            if let (Some(site), Some(url)) = (site, url) {
                if let Some((provider, id)) = external_link_id(site, url) {
                    set_id_string(&mut identity.ids, provider, id);
                }
            }
        }
    }
    add_source(identity, "jikan");
}

fn normalize_title(value: &str) -> String {
    value
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|character| character.is_alphanumeric())
        .collect()
}

fn format_matches(expected: Option<&str>, actual: Option<&str>) -> bool {
    match (expected, actual) {
        (Some(expected), Some(actual)) => normalize_title(expected) == normalize_title(actual),
        _ => true,
    }
}

fn title_candidate_matches(
    media: &AniListMedia,
    requested_title: &str,
    requested_year: Option<i32>,
    requested_format: Option<&str>,
) -> bool {
    let requested = normalize_title(requested_title);
    if requested.is_empty()
        || !media_titles(media)
            .iter()
            .any(|title| normalize_title(title) == requested)
    {
        return false;
    }
    if let (Some(expected), Some(actual)) = (requested_year, media.season_year) {
        if expected != actual {
            return false;
        }
    }
    format_matches(requested_format, media.format.as_deref())
}

async fn resolve_title(
    client: &reqwest::Client,
    identity: &mut AnimeIdentity,
    title: &str,
    year: Option<i32>,
    format: Option<&str>,
) -> bool {
    let candidates = search_anilist(client, title).await;
    let matches: Vec<AniListMedia> = candidates
        .into_iter()
        .filter(|media| title_candidate_matches(media, title, year, format))
        .collect();
    if matches.len() == 1 {
        merge_anilist(identity, &matches[0], "anilist-title-search");
        return true;
    }

    let kitsu_matches: Vec<KitsuResource> = search_kitsu(client, title)
        .await
        .into_iter()
        .filter(|resource| kitsu_title_matches(resource, title, year, format))
        .collect();
    if kitsu_matches.len() != 1 {
        return false;
    }
    let kitsu = &kitsu_matches[0];
    let mappings = fetch_kitsu_mappings(client, &kitsu.id)
        .await
        .unwrap_or_default();
    merge_kitsu(identity, kitsu, &mappings);
    true
}

pub async fn resolve(client: &reqwest::Client, request: &IdentityRequest) -> Option<AnimeIdentity> {
    let ids = request.normalized_ids();
    let had_input_identifier = [
        ids.anilist.as_ref(),
        ids.mal.as_ref(),
        ids.anidb.as_ref(),
        ids.kitsu.as_ref(),
        ids.tmdb.as_ref(),
        ids.tmdb_season.as_ref(),
        ids.imdb.as_ref(),
        ids.tvdb.as_ref(),
        ids.tvdb_season.as_ref(),
        ids.anime_planet.as_ref(),
        ids.live_chart.as_ref(),
        ids.anime_news_network.as_ref(),
        ids.ani_search.as_ref(),
        ids.simkl.as_ref(),
        ids.anime_countdown.as_ref(),
        ids.anikoto.as_ref(),
        ids.anikoto_episode.as_ref(),
    ]
    .into_iter()
    .any(|id| id.is_some());
    let mut identity = AnimeIdentity {
        ids: ids.clone(),
        titles: request.title.clone().into_iter().collect(),
        year: request.year,
        season: request.season.clone(),
        format: request.format.clone(),
        ..AnimeIdentity::default()
    };
    let mut had_direct_metadata = false;
    let mut matched_title = false;

    let anikoto_id = identity.ids.anikoto.clone();
    let anilist_id = identity.ids.anilist.clone();
    let mal_id = identity.ids.mal.clone();
    let anikoto_lookup = async {
        match anikoto_id {
            Some(id) => Some((id.clone(), fetch_anikoto_series(client, &id).await)),
            None => None,
        }
    };
    let anilist_lookup = async {
        match anilist_id {
            Some(id) => Some((id.clone(), fetch_anilist(client, &id).await)),
            None => None,
        }
    };
    let mal_lookup = async {
        match mal_id {
            Some(id) => {
                let url = format!("https://api.jikan.moe/v4/anime/{id}/full");
                Some(get_json::<Value>(client, &url).await)
            }
            None => None,
        }
    };
    let (anikoto_lookup, anilist_lookup, mal_lookup) =
        tokio::join!(anikoto_lookup, anilist_lookup, mal_lookup);

    if let Some((anikoto, result)) = anikoto_lookup {
        match result {
            Some(anime) => {
                merge_anikoto(&mut identity, &anikoto, &anime);
                had_direct_metadata = true;
            }
            None => add_warning(&mut identity, "anime metadata lookup failed"),
        }
    }

    if let Some((_anilist, result)) = anilist_lookup {
        match result {
            Some(media) => {
                merge_anilist(&mut identity, &media, "anilist");
                had_direct_metadata = true;
            }
            None => add_warning(&mut identity, "anime metadata lookup failed"),
        }
    }

    if let Some(result) = mal_lookup {
        match result {
            Some(data) => {
                merge_jikan(&mut identity, &data);
                had_direct_metadata = true;
            }
            None => add_warning(&mut identity, "anime metadata lookup failed"),
        }
    }

    if identity.ids.anilist.is_none() && identity.ids.mal.is_none() {
        if let Some(title) = request.title.as_deref() {
            if resolve_title(
                client,
                &mut identity,
                title,
                request.year,
                request.format.as_deref(),
            )
            .await
            {
                matched_title = true;
                identity.mapping_confidence = Some("title".to_string());
            } else {
                add_warning(
                    &mut identity,
                    "title did not identify one exact anime entry",
                );
            }
        }
    } else if identity.ids.anilist.is_none() && !identity.titles.is_empty() {
        let title = identity.titles[0].clone();
        let year = identity.year;
        let format = identity.format.clone();
        let _ = resolve_title(client, &mut identity, &title, year, format.as_deref()).await;
    }

    if let Some((kitsu_anime, mappings)) = fetch_kitsu_for_ids(client, &identity.ids).await {
        merge_kitsu(&mut identity, &kitsu_anime, &mappings);
        identity.mapping_confidence = Some("mapped".to_string());
    }

    if identity.mapping_confidence.is_none() {
        identity.mapping_confidence = Some(
            if had_direct_metadata || had_input_identifier || !identity.mapping_sources.is_empty() {
                "direct".to_string()
            } else {
                "mapped".to_string()
            },
        );
    }

    let has_identifier = identity.ids.anilist.is_some()
        || identity.ids.mal.is_some()
        || identity.ids.kitsu.is_some()
        || identity.ids.anidb.is_some()
        || identity.ids.tmdb.is_some()
        || identity.ids.imdb.is_some()
        || identity.ids.tvdb.is_some()
        || identity.ids.anikoto.is_some()
        || identity.ids.anikoto_episode.is_some();
    (has_identifier || had_input_identifier || matched_title).then_some(identity)
}

#[cfg(test)]
mod tests {
    use super::{
        add_warning, external_link_id, normalize_title, title_candidate_matches, AniListMedia,
        AnimeIdentity, TitleSet,
    };

    #[test]
    fn title_normalization_is_conservative_but_punctuation_tolerant() {
        assert_eq!(
            normalize_title("The Apothecary Diaries!"),
            "theapothecarydiaries"
        );
        assert_ne!(normalize_title("Season 1"), normalize_title("Season 2"));
    }

    #[test]
    fn parses_known_external_identifier_links() {
        assert_eq!(
            external_link_id("AniDB", "https://anidb.net/anime/6107"),
            Some(("anidb", "6107".into()))
        );
        assert_eq!(
            external_link_id(
                "Anime-Planet",
                "https://www.anime-planet.com/anime/cowboy-bebop"
            ),
            Some(("animePlanet", "cowboy-bebop".into()))
        );
        assert_eq!(
            external_link_id("IMDb", "https://www.imdb.com/title/tt0213338/"),
            Some(("imdb", "tt0213338".into()))
        );
        assert_eq!(
            external_link_id("AniList", "https://anilist.co/anime/5114"),
            Some(("anilist", "5114".into()))
        );
    }

    #[test]
    fn title_matching_requires_an_exact_alias_and_year() {
        let media = AniListMedia {
            id: 1,
            id_mal: Some(1),
            title: Some(TitleSet {
                romaji: Some("Cowboy Bebop".into()),
                english: None,
                native: None,
            }),
            synonyms: None,
            format: Some("TV".into()),
            season: None,
            season_year: Some(1998),
            episodes: Some(26),
            start_date: None,
            external_links: None,
        };
        assert!(title_candidate_matches(
            &media,
            "cowboy-bebop",
            Some(1998),
            Some("TV")
        ));
        assert!(!title_candidate_matches(
            &media,
            "cowboy-bebop",
            Some(1999),
            Some("TV")
        ));
        assert!(!title_candidate_matches(
            &media,
            "cowboy",
            Some(1998),
            Some("TV")
        ));
    }

    #[test]
    fn mapping_warnings_are_safe_lowercase_and_suffixed_once() {
        let mut identity = AnimeIdentity::default();
        add_warning(&mut identity, "anime metadata lookup failed...");
        add_warning(&mut identity, "anime metadata lookup failed... /ᐠ - ˕ -マ");

        assert_eq!(
            identity.mapping_warnings,
            vec!["anime metadata lookup failed... /ᐠ - ˕ -マ"]
        );
    }
}
