//! BKK FUTÁR (OTP REST) kliens: járművek, megállók, indulások, járat-nyomvonalak.

use std::{
    borrow::Cow,
    collections::HashSet,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use futures::future::join_all;
use serde::Serialize;
use serde_json::Value;

use crate::{
    config::{DEFAULT_KEY, FUTAR_BASE_URL},
    error::{Error, Result},
    state::{AppState, CacheResult},
    util::*,
};

/// Megállók listája ritkán változik.
const STOPS_TTL: Duration = Duration::from_secs(300);
/// Az összevont hálózati válasz élettartama (a járatok külön, 1 órára cache-elődnek).
const NETWORK_TTL: Duration = Duration::from_secs(300);
/// Ennyi párhuzamos kérés megy a BKK felé a hálózat összeállításakor.
const NETWORK_CONCURRENCY: usize = 6;

type Color = Cow<'static, str>;

pub fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

// ───────────────────────────── Színek és típusok ─────────────────────────────

fn format_hex(col: Option<&Value>, default: &'static str) -> Color {
    if !truthy(col) {
        return Cow::Borrowed(default);
    }
    let s = to_text(col);
    let s = s.trim();
    if s.starts_with('#') {
        Cow::Owned(s.to_string())
    } else {
        Cow::Owned(format!("#{s}"))
    }
}

/// Hivatalos BKK színek és kontrasztos betűszínek feloldása járatokra és típusokra.
pub fn route_colors(route: &Value) -> (Color, Color) {
    let short = to_text(route.get("shortName")).trim().to_uppercase();
    let rtype = to_text(route.get("type")).to_uppercase();
    let (bg, text) = (route.get("color"), route.get("textColor"));
    let has_given = truthy(bg) && truthy(text);
    let fixed = |a: &'static str, b: &'static str| (Cow::Borrowed(a), Cow::Borrowed(b));

    // HÉV (hivatalos BKK zöld: #007B3B)
    if rtype.contains("SUBURBAN") || rtype.contains("RAIL") || short.starts_with('H') {
        return if has_given {
            (format_hex(bg, "#007B3B"), format_hex(text, "#FFFFFF"))
        } else {
            fixed("#007B3B", "#FFFFFF")
        };
    }
    // Metrók
    if rtype.contains("SUBWAY") || short.starts_with('M') {
        return if short.contains('1') {
            fixed("#FFD800", "#000000")
        } else if short.contains('2') {
            fixed("#E41F18", "#FFFFFF")
        } else if short.contains('4') && !short.contains('3') {
            fixed("#4CA22F", "#FFFFFF")
        } else {
            fixed("#005CA5", "#FFFFFF")
        };
    }
    if rtype.contains("TRAM") {
        return fixed("#FFD800", "#000000");
    }
    if rtype.contains("TROLLEY") {
        return fixed("#E41F18", "#FFFFFF");
    }
    // Éjszakai buszok (9xx)
    if short.starts_with('9') && short.chars().count() == 3 {
        return fixed("#1E293B", "#FFFFFF");
    }
    if has_given {
        return (format_hex(bg, "#009EE3"), format_hex(text, "#FFFFFF"));
    }
    fixed("#009EE3", "#FFFFFF")
}

/// Egységes járműtípus (RAIL / TROLLEYBUS / SUBWAY / TRAM / BUS).
fn normalize_type(raw_type_upper: &str, short_upper: &str) -> &'static str {
    let t = raw_type_upper;
    if t.contains("SUBURBAN") || t.contains("RAIL") || short_upper.starts_with('H') {
        "RAIL"
    } else if t.contains("TROLLEY") {
        "TROLLEYBUS"
    } else if t.contains("SUBWAY") || t.contains("METRO") || short_upper.starts_with('M') {
        "SUBWAY"
    } else if t.contains("TRAM") {
        "TRAM"
    } else {
        "BUS"
    }
}

// ───────────────────────────────── Járművek ─────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Vehicle<'a> {
    vehicle_id: Value,
    license_plate: Option<&'a Value>,
    lat: Option<&'a Value>,
    lon: Option<&'a Value>,
    bearing: Option<&'a Value>,
    speed_kmh: i64,
    route_id: Option<&'a Value>,
    route_short_name: String,
    route_type: &'static str,
    color: Color,
    text_color: Color,
    headsign: &'a Value,
    model: &'a Value,
    status: &'a Value,
}

#[derive(Serialize)]
struct VehiclesResponse<'a> {
    count: usize,
    timestamp: i64,
    vehicles: Vec<Vehicle<'a>>,
}

pub async fn vehicles(
    st: &AppState,
    lat: f64,
    lon: f64,
    lat_span: f64,
    lon_span: f64,
    key: String,
) -> CacheResult {
    let cache_key = format!("vehicles:{lat:.3}:{lon:.3}:{lat_span:.3}:{lon_span:.3}");
    st.cached(
        cache_key,
        st.cfg.cache_ttl,
        build_vehicles(st, lat, lon, lat_span, lon_span, key),
    )
    .await
}

async fn send_sectors(
    st: &AppState,
    url: &str,
    key: &str,
    sectors: &[[f64; 4]],
) -> Vec<reqwest::Result<reqwest::Response>> {
    join_all(sectors.iter().map(|s| {
        st.http
            .get(url)
            .query(&[("key", key)])
            .query(&[("lat", s[0]), ("lon", s[1]), ("latSpan", s[2]), ("lonSpan", s[3])])
            .query(&[("includeReferences", "routes,trips")])
            .send()
    }))
    .await
}

async fn build_vehicles(
    st: &AppState,
    lat: f64,
    lon: f64,
    lat_span: f64,
    lon_span: f64,
    key: String,
) -> Result<Bytes> {
    let url = format!("{FUTAR_BASE_URL}/vehicles-for-location.json");

    // A BKK OTP API limit: ha latSpan vagy lonSpan >= 0.095, az API üres választ ad!
    // Kicsinyített térképnél 4 fedő szektort kérdezünk le párhuzamosan.
    let sectors: Vec<[f64; 4]> = if lat_span > 0.08 || lon_span > 0.08 {
        vec![
            [47.54, 19.01, 0.085, 0.085], // Észak-Buda / Óbuda
            [47.54, 19.13, 0.085, 0.085], // Észak-Pest / Újpest / Zugló
            [47.45, 19.02, 0.085, 0.085], // Dél-Buda / Kelenföld
            [47.45, 19.14, 0.085, 0.085], // Dél-Pest / Kőbánya / Kispest
        ]
    } else {
        vec![[lat, lon, lat_span.min(0.088), lon_span.min(0.088)]]
    };

    let mut responses = send_sectors(st, &url, &key, &sectors).await;
    // Ha 401-et kapunk egyéni kulcsra, újrapróbáljuk a hivatalos 'bkk-web' kulccsal.
    if key != DEFAULT_KEY
        && responses
            .iter()
            .any(|r| matches!(r, Ok(r) if r.status() == reqwest::StatusCode::UNAUTHORIZED))
    {
        responses = send_sectors(st, &url, DEFAULT_KEY, &sectors).await;
    }

    let bodies: Vec<Value> = join_all(
        responses
            .into_iter()
            .flatten()
            .filter(|r| r.status() == reqwest::StatusCode::OK)
            .map(|r| r.json::<Value>()),
    )
    .await
    .into_iter()
    .flatten()
    .collect();

    let mut seen = HashSet::new();
    let mut vehicles = Vec::new();

    for raw in &bodies {
        let data = &raw["data"];
        let routes = Refs::new(&data["references"]["routes"]);
        let trips = Refs::new(&data["references"]["trips"]);
        let Some(list) = data["list"].as_array() else {
            continue;
        };

        for v in list {
            let loc = &v["location"];
            if !truthy_v(loc) {
                continue;
            }
            let vehicle_id = match v.get("vehicleId") {
                Some(id) if truthy_v(id) => id.clone(),
                _ => Value::String(format!(
                    "{}_{}",
                    py_str(loc.get("lat")),
                    py_str(loc.get("lon"))
                )),
            };
            if !seen.insert(vehicle_id.to_string()) {
                continue;
            }

            let trip = trips.get(v.get("tripId"));
            let route_id = first_truthy([v.get("routeId"), trip.get("routeId")]);
            let route = routes.get(route_id);

            let short_name = match first_truthy([route.get("shortName"), v.get("label")]) {
                Some(x) => to_text(Some(x)),
                None => to_text(route_id).replace("BKK_", ""),
            };
            let (color, text_color) = route_colors(route);
            let raw_type = to_text(first_truthy([route.get("type"), v.get("routeType")])).to_uppercase();

            vehicles.push(Vehicle {
                vehicle_id,
                license_plate: v.get("licensePlate"),
                lat: loc.get("lat"),
                lon: loc.get("lon"),
                bearing: v.get("bearing"),
                speed_kmh: py_round(as_f64(v.get("speed")).unwrap_or(0.0) * 3.6),
                route_id,
                route_type: normalize_type(&raw_type, &short_name.to_uppercase()),
                route_short_name: short_name,
                color,
                text_color,
                headsign: first_truthy([trip.get("tripHeadsign"), v.get("label")]).unwrap_or(&EMPTY_STR),
                model: v.get("model").unwrap_or(&EMPTY_STR),
                status: v.get("status").unwrap_or(&EMPTY_STR),
            });
        }
    }

    to_bytes(&VehiclesResponse {
        count: vehicles.len(),
        timestamp: now_secs() as i64,
        vehicles,
    })
}

// ───────────────────────────────── Megállók ─────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stop<'a> {
    stop_id: String,
    name: String,
    lat: Option<&'a Value>,
    lon: Option<&'a Value>,
    direction: &'a Value,
    #[serde(rename = "type")]
    kind: String,
    stop_category: &'static str,
    stop_color: &'static str,
    stop_type_label: &'static str,
    location_type: &'a Value,
    location_sub_type: &'a Value,
    parent_station_id: &'a Value,
    is_stop_area: bool,
}

#[derive(Serialize)]
struct StopsResponse<'a> {
    count: usize,
    stops: Vec<Stop<'a>>,
}

static ZERO: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| Value::from(0));

pub async fn stops(
    st: &AppState,
    lat: f64,
    lon: f64,
    lat_span: f64,
    lon_span: f64,
    key: String,
) -> CacheResult {
    let cache_key = format!("stops:{lat:.3}:{lon:.3}:{lat_span:.3}:{lon_span:.3}");
    st.cached(cache_key, STOPS_TTL, build_stops(st, lat, lon, lat_span, lon_span, key))
        .await
}

async fn build_stops(
    st: &AppState,
    lat: f64,
    lon: f64,
    lat_span: f64,
    lon_span: f64,
    key: String,
) -> Result<Bytes> {
    let raw: Value = st
        .http
        .get(format!("{FUTAR_BASE_URL}/stops-for-location.json"))
        .query(&[("key", key.as_str())])
        .query(&[("lat", lat), ("lon", lon), ("latSpan", lat_span), ("lonSpan", lon_span)])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let data = &raw["data"];
    let routes = Refs::new(&data["references"]["routes"]);
    let mut stops = Vec::new();

    for s in data["list"].as_array().map(Vec::as_slice).unwrap_or_default() {
        if !(truthy(s.get("lat")) && truthy(s.get("lon"))) {
            continue;
        }
        let stop_id = to_text(s.get("id"));
        let stop_name = to_text(s.get("name"));
        let name_low = stop_name.to_lowercase();
        let raw_type = to_text(s.get("type")).to_uppercase();

        let mut r_types: HashSet<String> = HashSet::new();
        let mut has_hev_route = false;
        for rid in s["routeIds"].as_array().map(Vec::as_slice).unwrap_or_default() {
            let r = routes.get(Some(rid));
            let rt = to_text(r.get("type")).to_uppercase();
            let sn = to_text(r.get("shortName")).to_uppercase();
            if !rt.is_empty() {
                r_types.insert(rt);
            }
            if matches!(sn.as_str(), "H5" | "H6" | "H7" | "H8" | "H9") {
                has_hev_route = true;
            }
        }
        if !raw_type.is_empty() {
            r_types.insert(raw_type.clone());
        }

        let is_mav_station = stop_id.starts_with("BKK_0055")
            || name_low.contains("vasútállomás")
            || name_low.contains("pályaudvar")
            || (r_types.contains("RAIL") && !has_hev_route);

        let (cat, color, label) = if is_mav_station {
            ("MAV", "#f59e0b", "Vasútállomás")
        } else if r_types.contains("SUBWAY") {
            ("SUBWAY", "#a855f7", "Metróállomás")
        } else if has_hev_route || r_types.contains("SUBURBAN_RAILWAY") || name_low.contains("hév") {
            ("HEV", "#10b981", "HÉV-állomás")
        } else if r_types.contains("TRAM") {
            ("TRAM", "#eab308", "Villamosmegálló")
        } else if r_types.contains("TROLLEYBUS") {
            ("TROLLEYBUS", "#ef4444", "Trolibuszmegálló")
        } else {
            ("BUS", "#0ea5e9", "Buszmegálló")
        };

        let is_stop_area = as_f64(s.get("locationType")) == Some(1.0)
            || s.get("locationSubType").and_then(Value::as_str) == Some("stop-area")
            || stop_id.starts_with("BKK_CS");

        stops.push(Stop {
            stop_id,
            name: stop_name,
            lat: s.get("lat"),
            lon: s.get("lon"),
            direction: s.get("direction").unwrap_or(&EMPTY_STR),
            kind: if raw_type.is_empty() { cat.to_string() } else { raw_type },
            stop_category: cat,
            stop_color: color,
            stop_type_label: label,
            location_type: s.get("locationType").unwrap_or(&ZERO),
            location_sub_type: s.get("locationSubType").unwrap_or(&EMPTY_STR),
            parent_station_id: s.get("parentStationId").unwrap_or(&EMPTY_STR),
            is_stop_area,
        });
    }

    to_bytes(&StopsResponse {
        count: stops.len(),
        stops,
    })
}

// ───────────────────────────────── Indulások ────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Departure<'a> {
    route_short_name: String,
    headsign: &'a Value,
    minutes_until: i64,
    display_time: String,
    is_realtime: bool,
    epoch_time: i64,
    color: Color,
    text_color: Color,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeparturesResponse<'a> {
    stop_id: &'a str,
    stop_name: Value,
    timestamp: i64,
    departures: Vec<Departure<'a>>,
}

pub async fn departures(
    st: &AppState,
    stop_id: String,
    limit: usize,
    minutes_after: u32,
    key: String,
) -> CacheResult {
    let cache_key = format!("departures:{stop_id}:{limit}:{minutes_after}");
    st.cached(
        cache_key,
        st.cfg.cache_ttl,
        build_departures(st, stop_id, limit, minutes_after, key),
    )
    .await
}

async fn build_departures(
    st: &AppState,
    stop_id: String,
    limit: usize,
    minutes_after: u32,
    key: String,
) -> Result<Bytes> {
    let raw: Value = st
        .http
        .get(format!("{FUTAR_BASE_URL}/arrivals-and-departures-for-stop.json"))
        .query(&[
            ("key", key.as_str()),
            ("stopId", stop_id.as_str()),
            ("onlyDepartures", "true"),
            ("limit", &limit.to_string()),
            ("minutesAfter", &minutes_after.to_string()),
            ("includeReferences", "routes,trips,stops"),
        ])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let data = &raw["data"];
    let refs = &data["references"];
    let stops = Refs::new(&refs["stops"]);
    let routes = Refs::new(&refs["routes"]);
    let trips = Refs::new(&refs["trips"]);

    let sid = Value::String(stop_id.clone());
    let stop_info = Some(stops.get(Some(&sid)))
        .filter(|v| truthy_v(v))
        .or_else(|| stops.first());
    let stop_name = stop_info
        .and_then(|s| s.get("name"))
        .cloned()
        .unwrap_or_else(|| sid.clone());

    let now = now_secs();
    let mut departures = Vec::new();

    for stt in data["entry"]["stopTimes"].as_array().map(Vec::as_slice).unwrap_or_default() {
        let trip = trips.get(stt.get("tripId"));
        let route_id = first_truthy([trip.get("routeId"), stt.get("routeId")]);
        let route = routes.get(route_id);

        let sched = first_truthy([stt.get("departureTime"), stt.get("arrivalTime")]);
        let pred = first_truthy([stt.get("predictedDepartureTime"), stt.get("predictedArrivalTime")]);
        let Some(mut effective) = as_f64(pred.or(sched)) else {
            continue;
        };
        // Ha ezredmásodpercben érkezne, osztjuk 1000-rel
        if effective > 1e11 {
            effective /= 1000.0;
        }
        let diff_min = (((effective - now) / 60.0).floor() as i64).max(0);

        let short_name = match route.get("shortName").filter(|v| truthy_v(v)) {
            Some(x) => to_text(Some(x)),
            None => to_text(route_id).replace("BKK_", ""),
        };
        let (color, text_color) = route_colors(route);

        departures.push(Departure {
            route_short_name: short_name,
            headsign: first_truthy([stt.get("stopHeadsign"), trip.get("tripHeadsign")]).unwrap_or(&EMPTY_STR),
            minutes_until: diff_min,
            display_time: if diff_min == 0 { "MOST".into() } else { format!("{diff_min}'") },
            is_realtime: pred.is_some(),
            epoch_time: effective as i64,
            color,
            text_color,
        });
    }

    departures.sort_by_key(|d| d.epoch_time);
    departures.truncate(limit);

    to_bytes(&DeparturesResponse {
        stop_id: &stop_id,
        stop_name,
        timestamp: now as i64,
        departures,
    })
}

// ─────────────────────────────── Járat nyomvonal ─────────────────────────────

/// Gyakori járatszám → BKK routeId leképezés.
fn common_route_id(short: &str) -> Option<&'static str> {
    Some(match short {
        // Metrók
        "M1" => "BKK_5100",
        "M2" => "BKK_5200",
        "M3" => "BKK_5300",
        "M4" => "BKK_5400",
        // Villamosok
        "1" => "BKK_3010",
        "2" => "BKK_3020",
        "3" => "BKK_3030",
        "4" => "BKK_3040",
        "6" => "BKK_3060",
        "17" => "BKK_3170",
        "19" => "BKK_3190",
        "47" => "BKK_3470",
        "49" => "BKK_3490",
        "56" => "BKK_3560",
        // HÉV vonalak
        "H5" => "BKK_H5",
        "H6" => "BKK_H6",
        "H7" => "BKK_H7",
        "H8" => "BKK_H8",
        "H9" => "BKK_H9",
        // Trolibuszok
        "72" => "BKK_4720",
        "73" => "BKK_4730",
        "74" => "BKK_4740",
        "75" => "BKK_4750",
        "76" => "BKK_4760",
        "77" => "BKK_4770",
        "78" => "BKK_4780",
        "79" => "BKK_4790",
        "80" => "BKK_4800",
        "81" => "BKK_4810",
        "82" => "BKK_4820",
        "83" => "BKK_4830",
        // Főbb autóbuszok
        "7" => "BKK_0070",
        "8E" => "BKK_0085",
        "9" => "BKK_0090",
        "100E" => "BKK_1005",
        "200E" => "BKK_2005",
        "105" => "BKK_1050",
        "133E" => "BKK_1335",
        _ => return None,
    })
}

/// Budapest törzshálózata (metrók, főbb villamosok, HÉV, troli, főbuszok).
const CORE_NETWORK_ROUTES: &[&str] = &[
    "BKK_5100", "BKK_5200", "BKK_5300", "BKK_5400", // Metrók
    "BKK_3040", "BKK_3060", "BKK_3010", "BKK_3020", "BKK_3470", "BKK_3490", // Villamosok
    "BKK_H5", "BKK_H6", "BKK_H7", "BKK_H8", // HÉV
    "BKK_4720", "BKK_4740", "BKK_4760", "BKK_4800", // Trolibusz
    "BKK_0070", "BKK_0090", "BKK_1050", "BKK_1005", // Főbuszok
];

#[derive(Serialize)]
pub struct RoutePolyline {
    name: Value,
    headsign: Value,
    direction: Value,
    coordinates: Vec<[f64; 2]>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteDetails {
    route_id: String,
    short_name: Value,
    description: Value,
    #[serde(rename = "type")]
    kind: &'static str,
    color: Color,
    text_color: Color,
    polylines: Vec<RoutePolyline>,
}

/// Egy járat adatai és nyomvonala (1 órás cache – a geometria ritkán változik).
pub async fn route_details(
    st: &AppState,
    route_id: &str,
    key: &str,
) -> std::result::Result<Arc<RouteDetails>, Arc<Error>> {
    let clean_id = route_id.trim();
    let mut target = common_route_id(&clean_id.to_uppercase())
        .map(str::to_string)
        .unwrap_or_else(|| clean_id.to_string());
    if !target.starts_with("BKK_") {
        target = format!("BKK_{target}");
    }
    st.routes
        .try_get_with(target.clone(), fetch_route(st, target, clean_id.to_string(), key.to_string()))
        .await
}

async fn fetch_route(st: &AppState, target: String, clean_id: String, key: String) -> Result<Arc<RouteDetails>> {
    let mut raw: Value = st
        .http
        .get(format!("{FUTAR_BASE_URL}/route-details.json"))
        .query(&[
            ("key", key.as_str()),
            ("routeId", target.as_str()),
            ("includePolyline", "true"),
        ])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let entry = raw
        .pointer_mut("/data/entry")
        .map(Value::take)
        .unwrap_or(Value::Null);

    let short_name = match entry.get("shortName") {
        Some(v) if truthy_v(v) => v.clone(),
        _ => Value::String(clean_id),
    };
    let raw_type = entry
        .get("type")
        .map_or_else(|| "BUS".to_string(), |v| py_str(Some(v)))
        .to_uppercase();
    let kind = normalize_type(&raw_type, &py_str(Some(&short_name)).to_uppercase());
    let (color, text_color) = route_colors(&entry);

    let get_or_empty = |v: &Value, k: &str| v.get(k).cloned().unwrap_or_else(|| EMPTY_STR.clone());
    let polylines = entry["variants"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|var| {
            let pts = var["polyline"]["points"].as_str().filter(|s| !s.is_empty())?;
            let coordinates = decode_polyline(pts);
            (!coordinates.is_empty()).then(|| RoutePolyline {
                name: get_or_empty(var, "name"),
                headsign: get_or_empty(var, "headsign"),
                direction: get_or_empty(var, "direction"),
                coordinates,
            })
        })
        .collect();

    Ok(Arc::new(RouteDetails {
        route_id: target,
        short_name,
        description: get_or_empty(&entry, "description"),
        kind,
        color,
        text_color,
        polylines,
    }))
}

#[derive(Serialize)]
struct NetworkResponse<'a> {
    count: usize,
    routes: Vec<&'a RouteDetails>,
}

/// Törzshálózat nyomvonalai – korlátozott párhuzamossággal lekérve.
pub async fn transit_network(st: &AppState, key: String) -> CacheResult {
    let key_clone = key.clone();
    st.cached("core_transit_network".into(), NETWORK_TTL, async move {
        let mut results = Vec::with_capacity(CORE_NETWORK_ROUTES.len());
        for chunk in CORE_NETWORK_ROUTES.chunks(NETWORK_CONCURRENCY) {
            let chunk_futs: Vec<_> = chunk.iter().map(|&rid| {
                route_details(st, rid, &key_clone)
            }).collect();
            let chunk_res = futures::future::join_all(chunk_futs).await;
            results.extend(chunk_res);
        }

        let mut last_err = None;
        let routes: Vec<Arc<RouteDetails>> = results
            .into_iter()
            .filter_map(|r| r.map_err(|e| last_err = Some(e)).ok())
            .filter(|r| !r.polylines.is_empty())
            .collect();

        // Teljes kudarcot nem cache-elünk – a következő kérés újrapróbálja.
        if routes.is_empty() {
            if let Some(e) = last_err {
                return Err(Error(e.to_string()));
            }
        }
        to_bytes(&NetworkResponse {
            count: routes.len(),
            routes: routes.iter().map(Arc::as_ref).collect(),
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn colors() {
        let c = |v: Value| {
            let (a, b) = route_colors(&v);
            (a.into_owned(), b.into_owned())
        };
        assert_eq!(c(json!({"shortName": "M2", "type": "SUBWAY"})).0, "#E41F18");
        assert_eq!(c(json!({"shortName": "M4", "type": "SUBWAY"})).0, "#4CA22F");
        assert_eq!(c(json!({"shortName": "4", "type": "TRAM"})).0, "#FFD800");
        assert_eq!(c(json!({"shortName": "914", "type": "BUS"})).0, "#1E293B");
        assert_eq!(
            c(json!({"shortName": "105", "type": "BUS", "color": "009EE3", "textColor": "FFFFFF"})),
            ("#009EE3".into(), "#FFFFFF".into())
        );
        assert_eq!(c(Value::Null), ("#009EE3".into(), "#FFFFFF".into()));
    }
}
