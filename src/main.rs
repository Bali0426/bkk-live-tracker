//! Fő belépési pont, Axum routing, statikus fájlok kiszolgálása és API végpontok.

use std::{net::SocketAddr, sync::Arc};

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::get,
    Json, Router,
};
use bytes::Bytes;
use mime_guess::from_path;
use rust_embed::Embed;
use serde::Deserialize;
use tower_http::cors::{Any, CorsLayer};

mod config;
mod error;
mod futar;
mod gtfs_rt;
mod mav;
mod state;
mod util;
mod vagonweb;

use config::Config;
use error::ApiError;
use state::AppState;

#[derive(Embed)]
#[folder = "app/static/"]
struct Asset;

#[tokio::main]
async fn main() {
    // .env betöltése ha elérhető
    let _ = dotenvy::dotenv();

    let cfg = Config::from_env();
    let host = cfg.host.clone();
    let port = cfg.port;

    let app_state = Arc::new(AppState::new(cfg));

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/", get(index_handler))
        .route("/static/{*path}", get(static_handler))
        .route("/api/status", get(api_status))
        .route("/api/vehicles", get(get_vehicles))
        .route("/api/stops", get(get_stops))
        .route("/api/departures/{stop_id}", get(get_departures))
        .route("/api/routes/{route_id}", get(get_route))
        .route("/api/network", get(get_network))
        .route("/api/gtfs-rt/vehicles", get(get_gtfs_rt_vehicles))
        .route("/api/mav/trains", get(get_mav_trains))
        .route("/api/mav/trains/{elvira_id}", get(get_mav_train_details))
        .route("/api/mav/trains/{elvira_id}/composition", get(get_mav_train_composition))
        .route("/api/mav/composition/{train_number}", get(get_train_composition_by_number))
        .route("/api/mav/network", get(get_mav_network))
        .route("/api/mav/stations", get(get_mav_stations))
        .route("/api/mav/stations/{station_name}", get(get_mav_station_details))
        .layer(cors)
        .with_state(app_state);

    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .unwrap_or_else(|_| SocketAddr::from(([127, 0, 0, 1], 8000)));

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("\n❌ Hiba a szerver indításakor: nem sikerült a(z) {addr} címhez csatlakozni!");
            if e.kind() == std::io::ErrorKind::AddrInUse {
                eprintln!("👉 A(z) {port}-as portot már használja egy másik folyamat (például a korábbi Python szerver vagy egy másik példány).");
                eprintln!("   Állítsd le a futó folyamatot, vagy adj meg másik portot a .env fájlban (pl. PORT=8080)!\n");
            } else {
                eprintln!("   Részletek: {e}\n");
            }
            std::process::exit(1);
        }
    };
    println!("🚀 BKK Live Tracker (Rust / Axum) indul: http://{addr}");
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("❌ Szerver hiba: {e}");
    }
}

async fn index_handler() -> impl IntoResponse {
    match Asset::get("index.html") {
        Some(content) => Html(content.data).into_response(),
        None => (StatusCode::NOT_FOUND, "404 Not Found").into_response(),
    }
}

async fn static_handler(Path(path): Path<String>) -> impl IntoResponse {
    let clean_path = path.trim_start_matches('/');
    match Asset::get(clean_path) {
        Some(content) => {
            let mime = from_path(clean_path).first_or_octet_stream();
            ([(header::CONTENT_TYPE, mime.as_ref())], content.data).into_response()
        }
        None => (StatusCode::NOT_FOUND, "404 Not Found").into_response(),
    }
}

fn json_response(bytes: Bytes) -> Response {
    ([(header::CONTENT_TYPE, "application/json; charset=utf-8")], bytes).into_response()
}

// ──────────────────────────────── API Végpontok ──────────────────────────────

async fn api_status(State(st): State<Arc<AppState>>) -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "ok",
        "hasEnvApiKey": st.cfg.has_env_key(),
        "cacheTtlSeconds": st.cfg.cache_ttl.as_secs()
    }))
}

#[derive(Deserialize)]
struct KeyParams {
    key: Option<String>,
}

fn resolve_key(st: &AppState, query: Option<&str>, headers: &HeaderMap) -> String {
    let header_val = headers.get("x-bkk-key").and_then(|v| v.to_str().ok());
    st.cfg.resolve_key(query, header_val)
}

#[derive(Deserialize)]
struct VehiclesParams {
    #[serde(default = "default_lat")]
    lat: f64,
    #[serde(default = "default_lon")]
    lon: f64,
    #[serde(default = "default_lat_span")]
    lat_span: f64,
    #[serde(default = "default_lon_span")]
    lon_span: f64,
    key: Option<String>,
}

fn default_lat() -> f64 { 47.4979 }
fn default_lon() -> f64 { 19.0402 }
fn default_lat_span() -> f64 { 0.03 }
fn default_lon_span() -> f64 { 0.04 }

async fn get_vehicles(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<VehiclesParams>,
) -> std::result::Result<Response, ApiError> {
    let api_key = resolve_key(&st, params.key.as_deref(), &headers);
    match futar::vehicles(&st, params.lat, params.lon, params.lat_span, params.lon_span, api_key).await {
        Ok(bytes) => Ok(json_response(bytes)),
        Err(e) => Err(ApiError::bad_gateway("BKK API hiba", e)),
    }
}

#[derive(Deserialize)]
struct StopsParams {
    #[serde(default = "default_lat")]
    lat: f64,
    #[serde(default = "default_lon")]
    lon: f64,
    #[serde(default = "default_stop_lat_span")]
    lat_span: f64,
    #[serde(default = "default_stop_lon_span")]
    lon_span: f64,
    key: Option<String>,
}

fn default_stop_lat_span() -> f64 { 0.015 }
fn default_stop_lon_span() -> f64 { 0.02 }

async fn get_stops(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<StopsParams>,
) -> std::result::Result<Response, ApiError> {
    let api_key = resolve_key(&st, params.key.as_deref(), &headers);
    match futar::stops(&st, params.lat, params.lon, params.lat_span, params.lon_span, api_key).await {
        Ok(bytes) => Ok(json_response(bytes)),
        Err(e) => Err(ApiError::bad_gateway("BKK API hiba", e)),
    }
}

#[derive(Deserialize)]
struct DeparturesParams {
    #[serde(default = "default_dep_limit")]
    limit: usize,
    #[serde(default = "default_dep_minutes")]
    minutes_after: u32,
    key: Option<String>,
}

fn default_dep_limit() -> usize { 8 }
fn default_dep_minutes() -> u32 { 45 }

async fn get_departures(
    State(st): State<Arc<AppState>>,
    Path(stop_id): Path<String>,
    headers: HeaderMap,
    Query(params): Query<DeparturesParams>,
) -> std::result::Result<Response, ApiError> {
    let api_key = resolve_key(&st, params.key.as_deref(), &headers);
    let limit = params.limit.clamp(1, 30);
    let minutes_after = params.minutes_after.clamp(5, 120);

    match futar::departures(&st, stop_id, limit, minutes_after, api_key).await {
        Ok(bytes) => Ok(json_response(bytes)),
        Err(e) => Err(ApiError::bad_gateway("BKK API hiba", e)),
    }
}

async fn get_route(
    State(st): State<Arc<AppState>>,
    Path(route_id): Path<String>,
    headers: HeaderMap,
    Query(params): Query<KeyParams>,
) -> std::result::Result<Response, ApiError> {
    let api_key = resolve_key(&st, params.key.as_deref(), &headers);
    match futar::route_details(&st, &route_id, &api_key).await {
        Ok(route) => match util::to_bytes(&*route) {
            Ok(b) => Ok(json_response(b)),
            Err(e) => Err(ApiError::bad_gateway("JSON hiba", e)),
        },
        Err(e) => Err(ApiError::bad_gateway("BKK API hiba", e)),
    }
}

async fn get_network(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<KeyParams>,
) -> std::result::Result<Response, ApiError> {
    let api_key = resolve_key(&st, params.key.as_deref(), &headers);
    match futar::transit_network(&st, api_key).await {
        Ok(bytes) => Ok(json_response(bytes)),
        Err(e) => Err(ApiError::bad_gateway("BKK API hiba", e)),
    }
}

#[derive(Deserialize)]
struct GtfsParams {
    #[serde(default = "default_gtfs_limit")]
    limit: usize,
    key: Option<String>,
}

fn default_gtfs_limit() -> usize { 100 }

async fn get_gtfs_rt_vehicles(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<GtfsParams>,
) -> std::result::Result<Response, ApiError> {
    let api_key = resolve_key(&st, params.key.as_deref(), &headers);
    let limit = params.limit.clamp(1, 1000);
    match gtfs_rt::vehicle_positions(&st, api_key, limit).await {
        Ok(bytes) => Ok(json_response(bytes)),
        Err(e) => Err(ApiError::bad_gateway("GTFS-RT hiba", e)),
    }
}

async fn get_mav_trains(State(st): State<Arc<AppState>>) -> std::result::Result<Response, ApiError> {
    match mav::trains(&st).await {
        Ok(bytes) => Ok(json_response(bytes)),
        Err(e) => Err(ApiError::bad_gateway("MÁV API hiba", e)),
    }
}

#[derive(Deserialize)]
struct MavTrainParams {
    train_number: Option<String>,
}

async fn get_mav_train_details(
    State(st): State<Arc<AppState>>,
    Path(elvira_id): Path<String>,
    Query(params): Query<MavTrainParams>,
) -> std::result::Result<Response, ApiError> {
    let train_number = params.train_number.unwrap_or_default();
    match mav::train_details(&st, elvira_id, train_number).await {
        Ok(bytes) => Ok(json_response(bytes)),
        Err(e) => Err(ApiError::bad_gateway("MÁV menetrend hiba", e)),
    }
}

async fn get_mav_train_composition(
    State(st): State<Arc<AppState>>,
    Path(elvira_id): Path<String>,
    Query(params): Query<MavTrainParams>,
) -> std::result::Result<Response, ApiError> {
    let num_query = params.train_number.unwrap_or_else(|| elvira_id);
    match vagonweb::composition(&st, num_query).await {
        Ok(bytes) => Ok(json_response(bytes)),
        Err(e) => Err(ApiError::bad_gateway("vagonWEB hiba", e)),
    }
}

async fn get_train_composition_by_number(
    State(st): State<Arc<AppState>>,
    Path(train_number): Path<String>,
) -> std::result::Result<Response, ApiError> {
    match vagonweb::composition(&st, train_number).await {
        Ok(bytes) => Ok(json_response(bytes)),
        Err(e) => Err(ApiError::bad_gateway("vagonWEB hiba", e)),
    }
}

#[derive(Deserialize)]
struct MavNetworkParams {
    #[serde(default = "default_sw_lat")]
    sw_lat: f64,
    #[serde(default = "default_sw_lon")]
    sw_lon: f64,
    #[serde(default = "default_ne_lat")]
    ne_lat: f64,
    #[serde(default = "default_ne_lon")]
    ne_lon: f64,
    #[serde(default = "default_zoom")]
    zoom: i64,
}

fn default_sw_lat() -> f64 { 45.7 }
fn default_sw_lon() -> f64 { 16.1 }
fn default_ne_lat() -> f64 { 48.6 }
fn default_ne_lon() -> f64 { 22.9 }
fn default_zoom() -> i64 { 10 }

async fn get_mav_network(
    State(st): State<Arc<AppState>>,
    Query(params): Query<MavNetworkParams>,
) -> std::result::Result<Response, ApiError> {
    match mav::network(&st, params.sw_lat, params.sw_lon, params.ne_lat, params.ne_lon, params.zoom).await {
        Ok(bytes) => Ok(json_response(bytes)),
        Err(e) => Err(ApiError::bad_gateway("MÁV vasúthálózat hiba", e)),
    }
}

async fn get_mav_stations() -> impl IntoResponse {
    json_response(mav::STATIONS_JSON.clone())
}

async fn get_mav_station_details(
    State(st): State<Arc<AppState>>,
    Path(station_name): Path<String>,
) -> std::result::Result<Response, ApiError> {
    match mav::station_details(&st, station_name).await {
        Ok(bytes) => Ok(json_response(bytes)),
        Err(e) => Err(ApiError::bad_gateway("MÁV állomás menetrend hiba", e)),
    }
}
