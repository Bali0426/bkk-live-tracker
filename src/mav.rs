//! MÁV / GYSEV vonatok (vonatinfo.mav.hu + MÁV+ EMMA GraphQL), menetrendek, vasúthálózat.

use std::{
    collections::HashMap,
    sync::{Arc, LazyLock},
    time::{Duration, Instant},
};

use bytes::Bytes;
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};

use crate::{
    error::{Error, Result},
    futar::now_secs,
    state::{AppState, CacheResult},
    util::*,
};

const VONATINFO_URL: &str = "https://vonatinfo.mav.hu/map.aspx/getData";
const MAVPLUSZ_GRAPHQL_URL: &str = "https://mavplusz.hu/otp2-backend/otp/routers/default/index/graphql";
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const DETAILS_TTL: Duration = Duration::from_secs(30);
const STATION_TTL: Duration = Duration::from_secs(45);
/// A vágányhálózat geometriája statikus.
const LINES_TTL: Duration = Duration::from_secs(3600);
/// Ennyi ideig nem látott vonatot törlünk a sebesség-trackerből.
const TRACK_EXPIRY: Duration = Duration::from_secs(900);

// ─────────────────────────────── Segédfüggvények ─────────────────────────────

/// Sebesség (km/h) és irányszög (fok) két koordináta és eltelt idő alapján.
fn calculate_geo_motion(lat1: f64, lon1: f64, lat2: f64, lon2: f64, dt: f64) -> (i64, Option<f64>) {
    if dt <= 0.0 {
        return (0, None);
    }
    const R: f64 = 6_371_000.0;
    let (phi1, phi2) = (lat1.to_radians(), lat2.to_radians());
    let dphi = (lat2 - lat1).to_radians();
    let dlambda = (lon2 - lon1).to_radians();

    let a = (dphi / 2.0).sin().powi(2) + phi1.cos() * phi2.cos() * (dlambda / 2.0).sin().powi(2);
    let c = 2.0 * a.sqrt().atan2((1.0 - a).max(0.0).sqrt());
    let dist_m = R * c;
    if dist_m < 15.0 {
        return (0, None);
    }

    let mut speed = dist_m / dt * 3.6;
    if speed > 180.0 {
        speed = 160.0;
    }
    let y = dlambda.sin() * phi2.cos();
    let x = phi1.cos() * phi2.sin() - phi1.sin() * phi2.cos() * dlambda.cos();
    let bearing = (y.atan2(x).to_degrees() + 360.0) % 360.0;
    (py_round(speed), Some(round_to(bearing, 1)))
}

fn vonatinfo_request(st: &AppState) -> reqwest::RequestBuilder {
    st.http
        .post(VONATINFO_URL)
        .header("User-Agent", BROWSER_UA)
        .header("Accept", "application/json, text/javascript, */*; q=0.01")
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Origin", "https://vonatinfo.mav.hu")
        .header("Referer", "https://vonatinfo.mav.hu/")
}

/// vonatinfo `getData` hívás; a `d` mező gyakran JSON-t tartalmazó string.
async fn vonatinfo(st: &AppState, payload: Value) -> Result<Value> {
    let mut raw: Value = vonatinfo_request(st)
        .json(&payload)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let d = raw
        .as_object_mut()
        .and_then(|m| m.remove("d"))
        .unwrap_or(Value::Null);
    Ok(match d {
        Value::String(s) => serde_json::from_str(&s)?,
        other => other,
    })
}

static HTML_FIXES: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        // 1. Kattintható vonat és állomás linkek átalakítása saját JS függvényekre
        (
            r"map\.getData\('TRAIN',\s*\{\s*v:\s*'([^']+)'(?:,\s*[^}]*)?\}\s*\)",
            "loadMavTrainDetails('${1}', '')",
        ),
        (
            r"map\.getData\('STATION',\s*\{[^}]*?\ba:\s*'([^']+)'[^}]*\}\s*\)",
            "loadMavStationDetails('${1}')",
        ),
        // 2. Sötét hátteren olvashatatlan inline színek javítása
        (r"(?i)color\s*:\s*blue\s*;\s*background-color\s*:\s*yellow", "color:#fef08a;background-color:#854d0e"),
        (r"(?i)color\s*:\s*blue\s*;\s*background-color\s*:\s*orange", "color:#fed7aa;background-color:#9a3412"),
        (r"(?i)color\s*:\s*(#000000|#000|black)\b", "color:#f1f5f9"),
        (r"(?i)color\s*:\s*(#0000ff|blue)\b", "color:#38bdf8"),
        (r"(?i)color\s*:\s*(#008000|green)\b", "color:#34d399"),
        (r"(?i)color\s*:\s*(#ff0000|red)\b", "color:#f87171"),
    ]
    .into_iter()
    .map(|(p, r)| (Regex::new(p).expect("hibás regex"), r))
    .collect()
});

/// Az Elvira HTML táblázat sötét témához igazítása és a linkek bekötése.
fn clean_mav_html(html: &str) -> String {
    let mut out = html.to_string();
    for (re, rep) in HTML_FIXES.iter() {
        if let std::borrow::Cow::Owned(s) = re.replace_all(&out, *rep) {
            out = s;
        }
    }
    out
}

// ─────────────────────────────── Vonatnevek (EMMA) ───────────────────────────

pub struct TrainName {
    train_name: String,
    full_title: String,
}

pub type NameMap = HashMap<String, TrainName>;

static TRIP_SHORT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d+)\s*(.*)$").unwrap());

/// Vonatszám → olvasható név (pl. IC TOKAJ, Z30, S10). Hiba esetén üres.
async fn train_names(st: &AppState) -> Arc<NameMap> {
    st.mav_names
        .try_get_with((), fetch_train_names(st))
        .await
        .unwrap_or_default()
}

async fn fetch_train_names(st: &AppState) -> Result<Arc<NameMap>> {
    let query = "{ vehiclePositions(swLat: 45.7, swLon: 16.0, neLat: 48.6, neLon: 22.9) \
                 { trip { tripShortName tripHeadsign route { longName mode } } } }";
    let resp = st
        .http
        .post(MAVPLUSZ_GRAPHQL_URL)
        .header("User-Agent", BROWSER_UA)
        .header("Origin", "https://mavplusz.hu")
        .header("Referer", "https://mavplusz.hu/")
        .json(&json!({ "query": query }))
        .timeout(Duration::from_secs(6))
        .send()
        .await?;

    let mut map = NameMap::new();
    if !resp.status().is_success() {
        return Ok(Arc::new(map));
    }
    let raw: Value = resp.json().await?;

    for v in raw["data"]["vehiclePositions"].as_array().map(Vec::as_slice).unwrap_or_default() {
        let t = &v["trip"];
        let rt = &t["route"];
        if !matches!(rt["mode"].as_str(), Some("RAIL" | "SUBURBAN_RAILWAY" | "TRAMTRAIN")) {
            continue;
        }
        let tsn = t["tripShortName"].as_str().unwrap_or("").trim();
        let ln = rt["longName"].as_str().unwrap_or("").trim();
        let hs = t["tripHeadsign"].as_str().unwrap_or("").trim();
        let Some(c) = TRIP_SHORT_RE.captures(tsn) else {
            continue;
        };
        let num = &c[1];
        let rest = c[2].trim();
        let rest_l = rest.to_lowercase();
        let short_hs = hs.replace("Budapest-", "Bp-").replace(" vasútállomás", "");

        let clean = if rest_l == "tramtrain" {
            if short_hs.is_empty() { "TramTrain".into() } else { format!("TramTrain → {short_hs}") }
        } else if !ln.is_empty() && !ln.starts_with("Sz ") && !ln.contains('/') && !ln.starts_with("S ") {
            if !short_hs.is_empty() && ln.chars().count() <= 4 {
                format!("{ln} → {short_hs}")
            } else {
                ln.to_string()
            }
        } else if !rest.is_empty() && !matches!(rest_l.as_str(), "személyvonat" | "sebesvonat" | "gyorsvonat") {
            // pl. "SAVARIA InterCity" -> "SAVARIA IC"
            rest.replace("InterCity", "IC")
                .replace("EuroCity", "EC")
                .replace("InterRégió", "IR")
                .replace("EuroNight", "EN")
        } else if !short_hs.is_empty() {
            let prefix = if rest_l.contains("sebes") { "Sebes" } else { "Sz" };
            format!("{prefix} → {short_hs}")
        } else {
            [rest, ln, num].into_iter().find(|s| !s.is_empty()).unwrap_or("").to_string()
        };

        map.insert(
            num.to_string(),
            TrainName {
                train_name: clean,
                full_title: tsn.to_string(),
            },
        );
    }
    Ok(Arc::new(map))
}

struct Display {
    short_number: String,
    train_name: String,
    full_title: String,
}

/// A vonat olvasható neve és rövid száma az UIC azonosító és viszonylat alapján.
fn resolve_train_display(raw_num: &str, relation: &str, names: &NameMap) -> Display {
    let short_num = if (raw_num.starts_with("55") || raw_num.starts_with("43")) && raw_num.len() > 2 {
        &raw_num[2..]
    } else {
        raw_num
    };

    // HÉV vonatok (36H...)
    if raw_num.starts_with("36H") {
        let dest = if relation.contains(" - ") {
            relation.rsplit(" - ").next().unwrap_or("").trim()
        } else {
            relation
        };
        let hev = if raw_num.starts_with("36H1") {
            if relation.contains("Csömör") { "H9" } else { "H8" }
        } else if raw_num.starts_with("36H2") {
            "H6"
        } else if raw_num.starts_with("36H3") {
            "H7"
        } else if raw_num.starts_with("36H4") {
            "H5"
        } else {
            "HÉV"
        };
        return Display {
            short_number: raw_num[2..].to_string(),
            train_name: if dest.is_empty() { hev.into() } else { format!("{hev} → {dest}") },
            full_title: format!("{hev} ({relation})"),
        };
    }

    if let Some(info) = names.get(short_num) {
        return Display {
            short_number: short_num.to_string(),
            train_name: info.train_name.clone(),
            full_title: info.full_title.clone(),
        };
    }

    // Ha nincs az EMMA térképen, a viszonylatból képezünk beszédes nevet
    let train_name = if relation.contains(" - ") {
        let dest = relation.rsplit(" - ").next().unwrap_or("").trim();
        format!("→ {}", dest.replace("Budapest-", "Bp-").replace(" vasútállomás", ""))
    } else if !relation.is_empty() {
        relation.replace("Budapest-", "Bp-")
    } else {
        format!("Vonat {short_num}")
    };

    Display {
        short_number: short_num.to_string(),
        train_name,
        full_title: if relation.is_empty() {
            short_num.to_string()
        } else {
            format!("{short_num} ({relation})")
        },
    }
}

// ─────────────────────────────────── Vonatok ─────────────────────────────────

/// Előző pozíció a sebesség és haladási irány számításához.
pub struct Track {
    lat: f64,
    lon: f64,
    at: Instant,
    speed: i64,
    bearing: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Train {
    train_number: String,
    raw_train_number: String,
    train_name: String,
    full_title: String,
    relation: String,
    delay: i64,
    lat: f64,
    lon: f64,
    speed_kmh: i64,
    bearing: Option<f64>,
    elvira_id: String,
    menetvonal: String,
    category: &'static str,
    color: &'static str,
    text_color: &'static str,
    status_text: String,
    #[serde(rename = "isIC")]
    is_ic: bool,
    is_suburban: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrainsResponse {
    count: usize,
    avg_delay: f64,
    timestamp: i64,
    trains: Vec<Train>,
}

pub async fn trains(st: &AppState) -> CacheResult {
    st.cached("mav_trains".into(), st.cfg.cache_ttl, build_trains(st))
        .await
}

async fn build_trains(st: &AppState) -> Result<Bytes> {
    // A pozíciók és a vonatnevek lekérése párhuzamosan fut.
    let payload = json!({"a": "TRAINS", "jo": {"history": false, "id": false}});
    let (val, names) = tokio::join!(vonatinfo(st, payload), train_names(st));
    let val = val?;

    let list = &val["result"]["Trains"]["Train"];
    let items: &[Value] = match list {
        Value::Array(a) => a,
        Value::Object(_) => std::slice::from_ref(list),
        _ => &[],
    };

    let now = Instant::now();
    let mut tracking = st.mav_tracking.lock().unwrap_or_else(|e| e.into_inner());
    let mut trains = Vec::with_capacity(items.len());
    let mut total_delay = 0i64;

    for t in items {
        let (Some(lat), Some(lon)) = (as_f64(t.get("@Lat")), as_f64(t.get("@Lon"))) else {
            continue;
        };
        if lat == 0.0 || lon == 0.0 {
            continue;
        }
        let delay = match t.get("@Delay") {
            None => 0,
            Some(d) => match as_f64(Some(d)) {
                Some(x) => x as i64,
                None => continue,
            },
        };
        total_delay += delay.max(0);

        let train_num = to_text(t.get("@TrainNumber"));
        let relation = to_text(t.get("@Relation"));
        let elvira_id = to_text(t.get("@ElviraID"));
        let menetvonal = Some(to_text(t.get("@Menetvonal")))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "MAV".into());

        let d = resolve_train_display(&train_num, &relation, &names);

        // Késési kategória és színkód
        let (category, color, text_color, status_text) = if delay <= 0 {
            ("on_time", "#10b981", "#FFFFFF", "Pontos".to_string())
        } else if delay < 10 {
            ("minor", "#eab308", "#0f172a", format!("+{delay} perc"))
        } else {
            ("major", "#ef4444", "#FFFFFF", format!("+{delay} perc"))
        };

        let is_ic = ["IC", "InterCity", "EC", "EuroCity", "RJ", "Railjet"]
            .iter()
            .any(|k| d.full_title.contains(k) || d.train_name.contains(k));
        let is_suburban = d.train_name.starts_with(['S', 'Z', 'G', 'H']);

        // Sebesség és irány az előző pozícióból
        let train_key = if elvira_id.is_empty() { train_num.clone() } else { elvira_id.clone() };
        let (mut speed_kmh, mut bearing) = (0, None);
        if let Some(prev) = tracking.get(&train_key) {
            let dt = now.duration_since(prev.at).as_secs_f64();
            if (2.0..=180.0).contains(&dt) {
                let (cs, cb) = calculate_geo_motion(prev.lat, prev.lon, lat, lon, dt);
                if cb.is_some() {
                    (speed_kmh, bearing) = (cs, cb);
                } else {
                    bearing = prev.bearing; // áll: 0 km/h, irány megtartva
                }
            } else {
                (speed_kmh, bearing) = (prev.speed, prev.bearing);
            }
        }
        tracking.insert(
            train_key,
            Track { lat, lon, at: now, speed: speed_kmh, bearing },
        );

        trains.push(Train {
            train_number: d.short_number,
            raw_train_number: train_num,
            train_name: d.train_name,
            full_title: d.full_title,
            relation,
            delay,
            lat,
            lon,
            speed_kmh,
            bearing,
            elvira_id,
            menetvonal,
            category,
            color,
            text_color,
            status_text,
            is_ic,
            is_suburban,
        });
    }

    // Régóta nem látott vonatok törlése (a Python verzióban korlátlanul nőtt).
    tracking.retain(|_, tr| now.duration_since(tr.at) < TRACK_EXPIRY);
    drop(tracking);

    let avg_delay = round_to(total_delay as f64 / trains.len().max(1) as f64, 1);
    to_bytes(&TrainsResponse {
        count: trains.len(),
        avg_delay,
        timestamp: now_secs() as i64,
        trains,
    })
}

// ───────────────────────────── Vonat részletek ───────────────────────────────

pub async fn train_details(st: &AppState, elvira_id: String, train_number: String) -> CacheResult {
    let key = format!("mav_train:{elvira_id}:{train_number}");
    st.cached(key, DETAILS_TTL, async move {
        let payload = json!({
            "a": "TRAIN",
            "jo": {"v": elvira_id, "vsz": train_number, "zoom": false, "csakkozlekedovonat": true}
        });
        let val = vonatinfo(st, payload).await?;
        let res = &val["result"];

        let polylines: Vec<Value> = res["line"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter_map(|seg| {
                let pts = seg["points"].as_str().filter(|s| !s.is_empty())?;
                let coords = decode_polyline(pts);
                (!coords.is_empty()).then(|| {
                    json!({
                        "info": seg.get("info").cloned().unwrap_or_else(|| "vonat".into()),
                        "coordinates": coords
                    })
                })
            })
            .collect();

        to_bytes(&json!({
            "elviraId": elvira_id,
            "trainNumber": train_number,
            "html": clean_mav_html(res["html"].as_str().unwrap_or("")),
            "polylines": polylines
        }))
    })
    .await
}

// ─────────────────────────────── Vasúthálózat ────────────────────────────────

pub async fn network(st: &AppState, sw_lat: f64, sw_lon: f64, ne_lat: f64, ne_lon: f64, zoom: i64) -> CacheResult {
    let key = format!("mav_network:{sw_lat:.2}:{sw_lon:.2}:{ne_lat:.2}:{ne_lon:.2}:{zoom}");
    st.cached(key, LINES_TTL, async move {
        let payload = json!({
            "a": "LINE",
            "jo": {"sw": [sw_lat, sw_lon], "ne": [ne_lat, ne_lon], "id": "bg", "zoom": zoom}
        });
        let val = vonatinfo(st, payload).await?;

        let lines: Vec<Value> = val["result"]["lines"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter_map(|item| {
                let pts = item["points"].as_str().filter(|s| !s.is_empty())?;
                let coords = decode_polyline(pts);
                (!coords.is_empty()).then(|| {
                    json!({
                        "lineNum": item.get("linenum").cloned().unwrap_or_else(|| EMPTY_STR.clone()),
                        "coordinates": coords
                    })
                })
            })
            .collect();

        to_bytes(&json!({ "count": lines.len(), "lines": lines }))
    })
    .await
}

// ─────────────────────────────────── Állomások ───────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Station {
    id: &'static str,
    name: &'static str,
    short_name: &'static str,
    lat: f64,
    lon: f64,
    is_major: bool,
    city: &'static str,
}

const fn s(
    id: &'static str,
    name: &'static str,
    short_name: &'static str,
    lat: f64,
    lon: f64,
    is_major: bool,
    city: &'static str,
) -> Station {
    Station { id, name, short_name, lat, lon, is_major, city }
}

const MAJOR_STATIONS: &[Station] = &[
    // Budapest főpályaudvarok és csomópontok
    s("bp-keleti", "Budapest-Keleti", "Keleti pu.", 47.5002, 19.0838, true, "Budapest"),
    s("bp-nyugati", "Budapest-Nyugati", "Nyugati pu.", 47.5108, 19.0575, true, "Budapest"),
    s("bp-deli", "Budapest-Déli", "Déli pu.", 47.4998, 19.0253, true, "Budapest"),
    s("kelenfold", "Kelenföld", "Kelenföld", 47.4646, 19.0215, true, "Budapest"),
    s("kobanya-kispest", "Kőbánya-Kispest", "Kőbánya-Kispest", 47.4639, 19.1489, true, "Budapest"),
    s("zuglo", "Zugló", "Zugló", 47.5132, 19.0984, false, "Budapest"),
    s("ferencvaros", "Ferencváros", "Ferencváros", 47.4678, 19.0898, false, "Budapest"),
    s("rakos", "Rákos", "Rákos", 47.4983, 19.1558, false, "Budapest"),
    s("ujpest", "Újpest", "Újpest", 47.5619, 19.0886, false, "Budapest"),
    // Vármegyeszékhelyek és nagyobb vasúti csomópontok
    s("debrecen", "Debrecen", "Debrecen", 47.5208, 21.6261, true, "Debrecen"),
    s("gyor", "Győr", "Győr", 47.6833, 17.6350, true, "Győr"),
    s("szeged", "Szeged", "Szeged", 46.2410, 20.1432, true, "Szeged"),
    s("miskolc-tiszai", "Miskolc-Tiszai", "Miskolc-Tiszai", 48.1008, 20.8065, true, "Miskolc"),
    s("pecs", "Pécs", "Pécs", 46.0683, 18.2325, true, "Pécs"),
    s("szekesfehervar", "Székesfehérvár", "Székesfehérvár", 47.1812, 18.4239, true, "Székesfehérvár"),
    s("szolnok", "Szolnok", "Szolnok", 47.1683, 20.1783, true, "Szolnok"),
    s("nyiregyhaza", "Nyíregyháza", "Nyíregyháza", 47.9506, 21.7139, true, "Nyíregyháza"),
    s("kecskemet", "Kecskemét", "Kecskemét", 46.9103, 19.6978, true, "Kecskemét"),
    s("bekescsaba", "Békéscsaba", "Békéscsaba", 46.6739, 21.0825, true, "Békéscsaba"),
    s("szombathely", "Szombathely", "Szombathely", 47.2372, 16.6358, true, "Szombathely"),
    s("veszprem", "Veszprém", "Veszprém", 47.1158, 17.9150, true, "Veszprém"),
    s("zalaegerszeg", "Zalaegerszeg", "Zalaegerszeg", 46.8375, 16.8522, true, "Zalaegerszeg"),
    s("eger", "Eger", "Eger", 47.8931, 20.3739, true, "Eger"),
    s("kaposvar", "Kaposvár", "Kaposvár", 46.3533, 17.7942, true, "Kaposvár"),
    s("tatabanya", "Tatabánya", "Tatabánya", 47.5847, 18.3986, true, "Tatabánya"),
    s("sopron", "Sopron", "Sopron", 47.6767, 16.5886, true, "Sopron"),
    s("cegled", "Cegléd", "Cegléd", 47.1781, 19.7892, false, "Cegléd"),
    s("vac", "Vác", "Vác", 47.7817, 19.1367, false, "Vác"),
    s("hatvan", "Hatvan", "Hatvan", 47.6631, 19.6742, false, "Hatvan"),
    s("fuzesabony", "Füzesabony", "Füzesabony", 47.7478, 20.4194, false, "Füzesabony"),
    s("siofok", "Siófok", "Siófok", 46.9069, 18.0531, true, "Siófok"),
    s("balatonfured", "Balatonfüred", "Balatonfüred", 46.9589, 17.8822, false, "Balatonfüred"),
    s("fonyod", "Fonyód", "Fonyód", 46.7456, 17.5539, false, "Fonyód"),
    s("keszthely", "Keszthely", "Keszthely", 46.7583, 17.2472, false, "Keszthely"),
    s("nagykanizsa", "Nagykanizsa", "Nagykanizsa", 46.4447, 16.9944, false, "Nagykanizsa"),
    s("dombovar", "Dombóvár", "Dombóvár", 46.3719, 18.1406, false, "Dombóvár"),
    s("komarom", "Komárom", "Komárom", 47.7458, 18.1189, false, "Komárom"),
    s("esztergom", "Esztergom", "Esztergom", 47.7775, 18.7408, false, "Esztergom"),
    s("hegyeshalom", "Hegyeshalom", "Hegyeshalom", 47.9133, 17.1528, false, "Hegyeshalom"),
    s("zahony", "Záhony", "Záhony", 48.4069, 22.1811, false, "Záhony"),
];

/// A főbb állomások listája – indításkor egyszer szerializálva.
pub static STATIONS_JSON: LazyLock<Bytes> = LazyLock::new(|| {
    to_bytes(&json!({ "stations": MAJOR_STATIONS })).expect("állomáslista szerializálása")
});

pub async fn station_details(st: &AppState, station: String) -> CacheResult {
    st.cached(format!("mav_station:{station}"), STATION_TTL, async move {
        let val = vonatinfo(st, json!({"a": "STATION", "jo": {"a": station}})).await?;
        let html = match &val["result"] {
            Value::String(s) => clean_mav_html(s),
            Value::Null => String::new(),
            other => clean_mav_html(&other.to_string()),
        };
        to_bytes(&json!({
            "station": station,
            "html": html,
            "timestamp": now_secs() as i64
        }))
    })
    .await
}

/// Az `Error` típus használata a modul publikus felületén (lint elkerülése).
#[allow(dead_code)]
fn _assert_error_type(_: Error) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_cleanup() {
        let html = r#"<a onclick="map.getData('TRAIN', { v: '123_456', vsz: '55149' })">x</a><span style="color:black">y</span>"#;
        let out = clean_mav_html(html);
        assert!(out.contains("loadMavTrainDetails('123_456', '')"), "{out}");
        assert!(out.contains("color:#f1f5f9"), "{out}");

        let st = clean_mav_html("map.getData('STATION', { a: 'Budapest-Keleti', b: 1 })");
        assert_eq!(st, "loadMavStationDetails('Budapest-Keleti')");
    }

    #[test]
    fn train_display() {
        let names = NameMap::new();
        let d = resolve_train_display("55149", "Budapest-Keleti - Szeged", &names);
        assert_eq!((d.short_number.as_str(), d.train_name.as_str()), ("149", "→ Szeged"));

        let h = resolve_train_display("36H4123", "Batthyány tér - Szentendre", &names);
        assert_eq!(h.train_name, "H5 → Szentendre");
    }

    #[test]
    fn geo_motion() {
        // ~1.1 km észak felé 60 s alatt ≈ 67 km/h, irány 0°
        let (speed, bearing) = calculate_geo_motion(47.0, 19.0, 47.01, 19.0, 60.0);
        assert!((60..75).contains(&speed), "{speed}");
        assert_eq!(bearing, Some(0.0));
        assert_eq!(calculate_geo_motion(47.0, 19.0, 47.0, 19.0, 60.0), (0, None));
    }
}
