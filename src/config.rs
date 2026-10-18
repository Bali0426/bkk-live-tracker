//! Környezeti változók (`.env`) és BKK végpont URL-ek kezelése.

use std::time::Duration;

/// BKK FUTÁR REST API alap URL
pub const FUTAR_BASE_URL: &str = "https://go.bkk.hu/api/query/v1/ws/otp/api/where";
/// BKK GTFS-Realtime Protobuf alap URL
pub const GTFS_RT_BASE_URL: &str = "https://go.bkk.hu/api/query/v1/ws/gtfs-rt/full";

/// A hivatalos, publikus webes kulcs (regisztráció nélkül is működik).
pub const DEFAULT_KEY: &str = "bkk-web";
/// A `.env.example` helykitöltő értéke – ezt üres kulcsként kezeljük.
pub const PLACEHOLDER_KEY: &str = "ide_ird_a_bkk_api_kulcsodat";

#[derive(Debug, Clone)]
pub struct Config {
    pub bkk_api_key: String,
    pub cache_ttl: Duration,
    pub host: String,
    pub port: u16,
}

impl Config {
    pub fn from_env() -> Self {
        let env = |k: &str| {
            std::env::var(k)
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        Self {
            bkk_api_key: env("BKK_API_KEY").unwrap_or_else(|| DEFAULT_KEY.into()),
            cache_ttl: Duration::from_secs(
                env("CACHE_TTL_SECONDS")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(8),
            ),
            host: env("HOST").unwrap_or_else(|| "127.0.0.1".into()),
            port: env("PORT").and_then(|v| v.parse().ok()).unwrap_or(8000),
        }
    }

    pub fn has_env_key(&self) -> bool {
        !self.bkk_api_key.is_empty() && self.bkk_api_key != PLACEHOLDER_KEY
    }

    /// Kulcs feloldása: query `?key=` → `X-BKK-Key` fejléc → `.env` → `bkk-web`.
    pub fn resolve_key(&self, query: Option<&str>, header: Option<&str>) -> String {
        let k = [query, header, Some(self.bkk_api_key.as_str())]
            .into_iter()
            .flatten()
            .find(|s| !s.is_empty())
            .unwrap_or("")
            .trim();
        if k.is_empty() || k == PLACEHOLDER_KEY {
            DEFAULT_KEY.into()
        } else {
            k.into()
        }
    }
}
