//! Megosztott alkalmazásállapot: egyetlen újrahasznosított HTTP kliens (connection pool)
//! és korlátos méretű, TTL-es gyorsítótárak.
//!
//! A `moka` cache `try_get_with` hívása összevonja az egyidejű kéréseket ugyanarra a kulcsra
//! (request coalescing), így N egyidejű kliens is csak 1 BKK API hívást generál.

use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use bytes::Bytes;
use moka::{future::Cache, Expiry};

use crate::{
    config::Config,
    error::{Error, Result},
    futar::RouteDetails,
    gtfs_rt::GtfsFeed,
    mav::{NameMap, Track},
};

pub type CacheResult = std::result::Result<Bytes, Arc<Error>>;

/// Előre szerializált JSON válasz + saját élettartam.
#[derive(Clone)]
pub struct CachedJson {
    body: Bytes,
    ttl: Duration,
}

struct PerEntryTtl;

impl Expiry<String, CachedJson> for PerEntryTtl {
    fn expire_after_create(&self, _key: &String, value: &CachedJson, _now: Instant) -> Option<Duration> {
        Some(value.ttl)
    }
}

pub struct AppState {
    pub cfg: Config,
    pub http: reqwest::Client,
    json: Cache<String, CachedJson>,
    pub routes: Cache<String, Arc<RouteDetails>>,
    pub gtfs: Cache<(), Arc<GtfsFeed>>,
    pub mav_names: Cache<(), Arc<NameMap>>,
    pub mav_tracking: Mutex<HashMap<String, Track>>,
}

impl AppState {
    pub fn new(cfg: Config) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!("bkk-live-tracker/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(5))
            .pool_idle_timeout(Duration::from_secs(90))
            .gzip(true)
            .build()
            .expect("HTTP kliens létrehozása sikertelen");

        Self {
            http,
            json: Cache::builder()
                .max_capacity(2_000)
                .expire_after(PerEntryTtl)
                .build(),
            routes: Cache::builder()
                .max_capacity(500)
                .time_to_live(Duration::from_secs(3600))
                .build(),
            gtfs: Cache::builder().max_capacity(1).time_to_live(cfg.cache_ttl).build(),
            mav_names: Cache::builder()
                .max_capacity(1)
                .time_to_live(Duration::from_secs(45))
                .build(),
            mav_tracking: Mutex::new(HashMap::new()),
            cfg,
        }
    }

    /// Lekéri a gyorsítótárból, vagy előállítja (egyszer) és eltárolja `ttl` időre.
    pub async fn cached(
        &self,
        key: String,
        ttl: Duration,
        fut: impl Future<Output = Result<Bytes>>,
    ) -> CacheResult {
        self.cached_with(key, async move { fut.await.map(|b| (b, ttl)) })
            .await
    }

    /// Mint a [`cached`](Self::cached), de az élettartamot az előállító határozza meg.
    pub async fn cached_with(
        &self,
        key: String,
        fut: impl Future<Output = Result<(Bytes, Duration)>>,
    ) -> CacheResult {
        self.json
            .try_get_with(key, async move {
                let (body, ttl) = fut.await?;
                Ok::<_, Error>(CachedJson { body, ttl })
            })
            .await
            .map(|c| c.body)
    }
}
