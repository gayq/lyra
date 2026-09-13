use crate::{catalog_store::{self, now, Job, Store}, identity, upstream::{self, Provider}, AppState};
use axum::{extract::{Path, Query, State, rejection::QueryRejection}, http::{header, StatusCode}, response::{IntoResponse, Response}, Json};
use moka::future::Cache;
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::{HashSet, VecDeque}, sync::Arc, time::Duration};

const FIELDS: &str = "id idMal type title { english romaji native } synonyms coverImage { large medium } bannerImage description genres averageScore popularity trending seasonYear startDate { year month day } isAdult format status episodes nextAiringEpisode { episode airingAt }";
const FRESH: i64 = 6 * 60 * 60 * 1000;

#[derive(Clone)]
pub struct Catalog {
    pub store: Store,
    responses: Cache<String, Arc<Value>>,
}

impl Catalog {
    pub fn new(store: Store) -> Self {
        Self { store, responses: Cache::builder().max_capacity(32 * 1024 * 1024)
            .weigher(|_: &String, value: &Arc<Value>| crate::json_weight(value))
            .time_to_live(Duration::from_secs(5)).build() }
    }

    pub fn start(&self, client: reqwest::Client) -> tokio::task::JoinHandle<()> {
        let catalog = self.clone();
        tokio::spawn(async move {
            let mut seeded = 0;
            loop {
                if now() - seeded > 60_000 {
                    for sort in ["trending", "popular"] {
                        let snapshot = catalog.store.snapshot(format!("feed:{sort}")).await.ok().flatten();
                        if snapshot.is_none_or(|(_, time)| now() - time > 600_000) {
                            let _ = catalog.store.enqueue("feed", sort, 100).await;
                        }
                    }
                    seeded = now();
                }
                match catalog.store.claim().await {
                    Ok(Some(job)) => {
                        let result = tokio::time::timeout(Duration::from_secs(120), catalog.refresh(&client, &job)).await;
                        if !matches!(result, Ok(Ok(()))) {
                            let _ = catalog.store.fail(job).await;
                            tracing::warn!("catalog refresh deferred... /ᐠ - ˕ -マ");
                        }
                    }
                    _ => tokio::time::sleep(Duration::from_millis(250)).await,
                }
            }
        })
    }

    async fn refresh(&self, client: &reqwest::Client, job: &Job) -> Result<(), ()> {
        if job.kind == "episodes" {
            let mal = job.arg.parse::<i64>().map_err(|_| ())?;
            let episodes = crate::jikan::fetch_episodes(client, mal).await.ok_or(())?;
            if episodes.is_empty() { return Err(()); }
            return self.store.complete(job.clone(), vec![], Some(json!(episodes))).await;
        }
        let fields = format!("{FIELDS} relations {{ edges {{ relationType node {{ {FIELDS} }} }} }}");
        let (query, variables) = match job.kind.as_str() {
            "feed" => {
                let sort = if job.arg == "popular" { "POPULARITY_DESC" } else { "TRENDING_DESC" };
                (format!("query {{ Page(page:1,perPage:50) {{ media(type:ANIME,sort:{sort}) {{ {fields} }} }} }}"), json!({}))
            }
            "search" => (format!("query($search:String) {{ Page(page:1,perPage:50) {{ media(type:ANIME,search:$search) {{ {fields} }} }} }}"), json!({"search":job.arg})),
            "media" | "mal" => {
                let id = job.arg.parse::<i32>().map_err(|_| ())?;
                let field = if job.kind == "mal" { "idMal" } else { "id" };
                (format!("query($id:Int) {{ Media(type:ANIME,{field}:$id) {{ {fields} }} }}"), json!({"id":id}))
            }
            _ => return Err(()),
        };
        let response = upstream::send(Provider::Anilist, client.post("https://graphql.anilist.co").json(&json!({"query":query,"variables":variables}))).await.ok_or(())?;
        if !response.status().is_success() { return Err(()); }
        let payload: Value = response.json().await.map_err(|_| ())?;
        if payload["errors"].as_array().is_some_and(|errors| !errors.is_empty()) { return Err(()); }
        let media = if job.kind == "feed" || job.kind == "search" {
            payload["data"]["Page"]["media"].as_array().cloned().ok_or(())?
        } else {
            let media = payload["data"]["Media"].clone();
            let expected = job.arg.parse::<i64>().map_err(|_| ())?;
            let key = if job.kind == "mal" { "idMal" } else { "id" };
            if media[key].as_i64() != Some(expected) { return Err(()); }
            vec![media]
        };
        if media.iter().any(|m| m["id"].as_i64().is_none_or(|id| id <= 0) || m["title"].as_object().is_none() || m["relations"]["edges"].as_array().is_none()) {
            return Err(());
        }
        if job.kind == "feed" && media.is_empty() { return Err(()); }
        let ids = media.iter().filter_map(|m| m["id"].as_i64()).collect::<Vec<_>>();
        self.store.complete(job.clone(), media, Some(json!({"ids":ids}))).await
    }

    pub async fn identity(&self, input: &identity::IdentityRequest) -> Option<identity::AnimeIdentity> {
        let mut ids = input.normalized_ids();
        let (column, id) = if let Some(id) = ids.anilist.as_deref().and_then(|s| s.parse::<i64>().ok()) {
            ("id", id)
        } else { ("mal_id", ids.mal.as_deref()?.parse::<i64>().ok()?) };
        let (media, updated) = self.store.run(move |conn| catalog_store::media(conn, column, id)).await.ok()??;
        if now() - updated > FRESH {
            let _ = self.store.enqueue("media", &media["id"].to_string(), 80).await;
        }
        if ids.mal.as_ref().is_some_and(|id| media["idMal"].as_i64().is_some_and(|mal| id != &mal.to_string())) { return None; }
        ids.anilist = media["id"].as_i64().map(|id| id.to_string());
        ids.mal = media["idMal"].as_i64().map(|id| id.to_string()).or(ids.mal);
        Some(identity::AnimeIdentity {
            ids, titles: media["title"].as_object()?.values().filter_map(Value::as_str).map(str::to_owned).collect(),
            year: media["startDate"]["year"].as_i64().map(|v| v as i32), format: media["format"].as_str().map(str::to_owned),
            episodes: aired_count(&media).map(|v| v as i32), mapping_confidence: Some("exact".into()),
            mapping_sources: vec!["anilist".into()], ..Default::default()
        })
    }
}

pub fn aired_count(media: &Value) -> Option<i64> {
    if media["status"] == "FINISHED" { return media["episodes"].as_i64().filter(|v| *v > 0); }
    let next = media["nextAiringEpisode"]["episode"].as_i64()?;
    next.checked_sub(1).filter(|v| *v >= 0)
}

fn response(value: Value) -> Response {
    let pending = value["pending"] == true;
    let status = if pending { StatusCode::ACCEPTED } else { StatusCode::OK };
    let mut response = (status, Json(value)).into_response();
    response.headers_mut().insert(header::CACHE_CONTROL, if pending { "no-store" } else { "public, max-age=30, s-maxage=60, stale-while-revalidate=3600" }.parse().unwrap());
    if pending { response.headers_mut().insert(header::RETRY_AFTER, "2".parse().unwrap()); }
    response
}

fn unavailable() -> Response {
    (StatusCode::SERVICE_UNAVAILABLE, [(header::CACHE_CONTROL, "no-store"), (header::RETRY_AFTER, "2")], Json(json!({
        "error":crate::negative_message("anime catalog is temporarily unavailable"), "code":"ANIME_CATALOG_UNAVAILABLE"
    }))).into_response()
}

fn invalid() -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({"error":crate::negative_message("invalid catalog request"),"code":"INVALID_CATALOG_REQUEST"}))).into_response()
}

#[derive(Deserialize, Default)]
pub struct CatalogQuery {
    #[serde(default)] search: String,
    #[serde(default)] sort: String,
    #[serde(default)] adult: bool,
}

pub async fn listing(State(state): State<Arc<AppState>>, query: Result<Query<CatalogQuery>, QueryRejection>) -> Response {
    let Ok(Query(query)) = query else { return invalid(); };
    let Some(catalog) = &state.catalog else { return unavailable(); };
    let search = query.search.trim().to_lowercase();
    if search.len() > 120 || !["", "trending", "popular"].contains(&query.sort.as_str()) { return invalid(); }
    let sort = if query.sort == "popular" { "popular" } else { "trending" };
    let key = format!("list:{sort}:{}:{search}", query.adult);
    if let Some(value) = catalog.responses.get(&key).await { return response((*value).clone()); }
    let job_kind = if search.is_empty() { "feed" } else { "search" };
    let arg = if search.is_empty() { sort.to_owned() } else { search.clone() };
    let snapshot_key = format!("{job_kind}:{arg}");
    let adult = query.adult;
    let value = catalog.store.run(move |conn| {
        let snapshot = catalog_store::snapshot(conn, &snapshot_key)?;
        let tokens = search.split(|c: char| !c.is_alphanumeric()).filter(|s| !s.is_empty()).take(8)
            .map(|s| format!("\"{s}\"*")).collect::<Vec<_>>().join(" AND ");
        let sql = if search.is_empty() {
            if sort == "popular" { "SELECT body FROM anime WHERE (?1 OR adult=0) ORDER BY popularity DESC LIMIT 100" }
            else { "SELECT body FROM anime WHERE (?1 OR adult=0) ORDER BY trending DESC,popularity DESC LIMIT 100" }
        } else { "SELECT body FROM anime WHERE (?1 OR adult=0) AND id IN (SELECT rowid FROM anime_search WHERE anime_search MATCH ?2) ORDER BY popularity DESC LIMIT 100" };
        let mut stmt = conn.prepare(sql)?;
        let rows = if search.is_empty() { stmt.query(params![adult])? } else { stmt.query(params![adult, if tokens.is_empty() { "\"\"" } else { &tokens }])? };
        let media = collect(rows)?;
        let stale = snapshot.as_ref().is_none_or(|(_, updated)| now() - updated > 600_000);
        let pending = media.is_empty() && snapshot.is_none();
        Ok(json!({"media":media,"stale":stale,"pending":pending}))
    }).await;
    let Ok(value) = value else { return unavailable(); };
    if value["stale"] == true { let _ = catalog.store.enqueue(job_kind, &arg, if job_kind == "feed" {100} else {60}).await; }
    catalog.responses.insert(key, Arc::new(value.clone())).await;
    response(value)
}

fn collect(mut rows: rusqlite::Rows<'_>) -> rusqlite::Result<Vec<Value>> {
    let mut media = vec![];
    while let Some(row) = rows.next()? {
        let body: String = row.get(0)?;
        if let Ok(value) = serde_json::from_str(&body) { media.push(value); }
    }
    Ok(media)
}

pub async fn franchise(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let Ok(id) = id.parse::<i32>().filter_positive() else { return invalid(); };
    let Some(catalog) = &state.catalog else { return unavailable(); };
    let key = format!("franchise:{id}");
    if let Some(value) = catalog.responses.get(&key).await { return response((*value).clone()); }
    let result = catalog.store.run(move |conn| {
        let root = catalog_store::media(conn, "mal_id", i64::from(id))?;
        let Some((root, updated)) = root else { return Ok((json!({"relations":[],"complete":false,"stale":true,"pending":true}), vec![("mal", id.to_string())])); };
        let mut pending = VecDeque::from([(root, "Self".to_owned(), updated)]);
        let mut seen = HashSet::new();
        let mut relations = vec![];
        let mut refresh = vec![];
        let mut complete = true;
        while let Some((mut media, relation, mut updated)) = pending.pop_front() {
            let Some(anilist) = media["id"].as_i64() else { complete = false; continue; };
            if !seen.insert(anilist) { continue; }
            if seen.len() > 64 { complete = false; break; }
            if updated == 0 {
                if let Some((stored, time)) = catalog_store::media(conn, "id", anilist)? { media = stored; updated = time; }
            }
            if now() - updated > FRESH { refresh.push(("media", anilist.to_string())); }
            if let Some(mal) = media["idMal"].as_i64().filter(|v| *v > 0) {
                let name = media["title"]["english"].as_str().or(media["title"]["romaji"].as_str()).unwrap_or("");
                relations.push(json!({"mal_id":mal,"anilist_id":anilist,"name":name,"relation":relation,
                    "format":media["format"],"year":media["startDate"]["year"],"episode_count":aired_count(&media),
                    "total_episodes":media["episodes"],"source":"anilist"}));
            } else { complete = false; }
            if let Some(edges) = media["relations"]["edges"].as_array() {
                for edge in edges {
                    let relation = edge["relationType"].as_str().unwrap_or("");
                    if ["PREQUEL", "SEQUEL"].contains(&relation) && edge["node"]["type"] == "ANIME" {
                        pending.push_back((edge["node"].clone(), relation.to_owned(), 0));
                    }
                }
            } else { complete = false; }
        }
        Ok((json!({"relations":relations,"complete":complete,"stale":!refresh.is_empty(),"pending":false}), refresh))
    }).await;
    let Ok((value, refresh)) = result else { return unavailable(); };
    for (kind, arg) in refresh { let _ = catalog.store.enqueue(kind, &arg, 80).await; }
    catalog.responses.insert(key, Arc::new(value.clone())).await;
    response(value)
}

trait Positive { fn filter_positive(self) -> Result<i32, ()>; }
impl<E> Positive for Result<i32, E> { fn filter_positive(self) -> Result<i32, ()> { self.map_err(|_| ()).and_then(|id| if id > 0 { Ok(id) } else { Err(()) }) } }

pub async fn episodes(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let Ok(id) = id.parse::<i32>().filter_positive() else { return invalid(); };
    let Some(catalog) = &state.catalog else { return unavailable(); };
    let key = format!("episodes:{id}");
    if let Some(value) = catalog.responses.get(&key).await { return response((*value).clone()); }
    let result = catalog.store.run(move |conn| {
        let media = catalog_store::media(conn, "mal_id", i64::from(id))?;
        let snapshot = catalog_store::snapshot(conn, &format!("episodes:{id}"))?;
        let items = snapshot.as_ref().and_then(|(v, _)| v.as_array()).cloned().unwrap_or_default();
        let listed = items.iter().filter_map(|v| v["number"].as_i64()).max();
        let aired = media.as_ref().and_then(|(v, _)| aired_count(v));
        let count = aired.into_iter().chain(listed).max().unwrap_or(0);
        let stale = snapshot.as_ref().is_none_or(|(_, t)| now() - t > 900_000);
        let metadata_stale = media.as_ref().is_none_or(|(_, t)| now() - t > FRESH);
        Ok((json!({"count":count,"aired":aired,"total":media.as_ref().map(|(v,_)| &v["episodes"]),
            "subCount":null,"dubCount":null,"episodes":items,"stale":stale || metadata_stale,
            "pending":count == 0 && media.is_none() && snapshot.is_none()}), stale, metadata_stale))
    }).await;
    let Ok((value, stale, metadata_stale)) = result else { return unavailable(); };
    if stale { let _ = catalog.store.enqueue("episodes", &id.to_string(), 40).await; }
    if metadata_stale { let _ = catalog.store.enqueue("mal", &id.to_string(), 80).await; }
    catalog.responses.insert(key, Arc::new(value.clone())).await;
    response(value)
}

pub async fn metrics(State(state): State<Arc<AppState>>) -> Response {
    let Some(catalog) = &state.catalog else { return unavailable(); };
    let value = catalog.store.run(|conn| {
        let titles: i64 = conn.query_row("SELECT count(*) FROM anime", [], |r| r.get(0))?;
        let queued: i64 = conn.query_row("SELECT count(*) FROM jobs", [], |r| r.get(0))?;
        let mut stmt = conn.prepare("SELECT name,requests,failures,max(blocked_until-?1,0) FROM providers")?;
        let rows = stmt.query_map([now()], |r| Ok(json!({"provider":r.get::<_,String>(0)?,"requests":r.get::<_,i64>(1)?,"failures":r.get::<_,i64>(2)?,"cooldownMs":r.get::<_,i64>(3)?})))?;
        Ok(json!({"titles":titles,"queued":queued,"providers":rows.collect::<rusqlite::Result<Vec<_>>>()?}))
    }).await;
    match value { Ok(value) => ([(header::CACHE_CONTROL,"no-store")],Json(value)).into_response(), Err(_) => unavailable() }
}
