//! vagonWEB.cz scraping kliens: vonatok képes szerelvényösszeállítása (tervezett és tényleges).

use std::{
    sync::LazyLock,
    time::Duration,
};

use bytes::Bytes;
use chrono::Datelike;
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};

use crate::{
    error::Result,
    state::{AppState, CacheResult},
    util::to_bytes,
};

const VAGONWEB_BASE: &str = "https://www.vagonweb.cz/razeni/";
const CACHE_TTL: Duration = Duration::from_secs(7200); // 2 óra memóriabeli gyorsítótár
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

static HU_KEYWORDS: &[&str] = &[
    "budapest", "keleti", "nyugati", "déli", "kelenföld", "kőbánya", "ferencváros",
    "győr", "debrecen", "szeged", "miskolc", "pécs", "székesfehérvár",
    "kecskemét", "nyíregyháza", "szombathely", "sopron", "hegyeshalom",
    "szob", "lőkösháza", "kelebia", "biharkeresztes", "hidasnémeti",
    "somoskőújfalu", "záhony", "rajka", "vác", "békéscsaba", "hatvan",
    "tatabánya", "veszprém", "nagykanizsa", "zalaegerszeg", "keszthely",
    "siófok", "fonyód", "szolnok", "eger", "salgótarján", "baja",
    "szekszárd", "dunaújváros", "kaposvár", "komárom", "esztergom",
    "cegléd", "monor", "nagykáta", "gödöllő", "füzesabony",
    "szerencs", "sárospatak", "sátoraljaújhely", "püspökladány",
    "karcag", "kisvárda", "mátészalka", "orosháza", "szentes",
    "hódmezővásárhely", "kiskunfélegyháza", "kiskunhalas", "dombóvár",
    "sárbogárd", "bicske", "tata", "csorna", "kapuvár", "szentgotthárd",
    "balaton", "tapolca", "balatonfüred",
];

static DIGITS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d+").unwrap());
static HTML_TAGS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());
static WHITESPACE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static VLAK_BLOCK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)<div id=['\x22]vlak_(\d+)['\x22][^>]*>\s*<h4[^>]*>(.*?)</h4>\s*</div>").unwrap()
});
static DATE_DMY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b").unwrap()
});
static DATE_COMBINED_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(\d{4}\.\d{2}\.\d{2}\.)|\b(\d{1,2})\.(\d{1,2})\.").unwrap()
});
static RE_VCERA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\[včera\]").unwrap());
static RE_DNES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\[dnes\]").unwrap());
static RE_STANICI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)ve stanici:\s*").unwrap());
static RE_USEKU: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)v úseku:\s*").unwrap());
static RE_PLANOVANE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Plánované řazení\s*").unwrap());
static RE_SKUTECNE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Skutečné řazení vlaku dne:\s*").unwrap());
static CZ_DAYS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(po|út|st|čt|pá|so|ne)\b").unwrap());
static CELL_SPLIT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"<td class=['"]bunka_vozu['"][^>]*>"#).unwrap()
});

static IMG_M_RE1: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"<img[^>]+(?:obrazek_vagonu|vagonek)[^>]+src=['"]([^'"]+)['"]"#).unwrap()
});
static IMG_M_RE2: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"src=['"]([^'"]*(?:popisy/img|\.gif|\.png)[^'"]*)['"]"#).unwrap()
});
static NUM_M_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"class=['"]?raz-cislo['"]?>\s*([^<]+)"#).unwrap()
});
static TYPE_M_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"class=['"]?tab-radam['"]?>\s*([^<]+)"#).unwrap()
});
static SMALL_M_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"<small>\s*([^<]+)</small>"#).unwrap()
});
static OP_M_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<span title=['"][^'"]*(?:Dráhy|Vasút|START|MÁV|ÖBB|ČD|ZSSK|PKP|GYSEV)[^'"]*['"]>\s*([^<]+)</span>"#).unwrap()
});
static PIKTO_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"<img class=['"]pikto['"][^>]+src=['"]([^'"]+)['"][^>]+title=['"]([^'"]+)['"]"#).unwrap()
});
static LOCO_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)lokomotiva|mozdony|Taurus|Traxx|V43|470|480|182|380|383|193|vectron").unwrap()
});

fn is_hungarian_train(item: &Value) -> bool {
    let zeme = item.get("zeme").and_then(Value::as_str).unwrap_or("").to_uppercase();
    let zeme_trimmed = zeme.trim();
    if matches!(zeme_trimmed, "START" | "MÁV" | "MÁV-START" | "MAV" | "GYSEV") {
        return true;
    }

    let cislo = item.get("cislo").and_then(Value::as_str).unwrap_or("").to_uppercase();
    if cislo.contains("MÁV") || cislo.contains("START") || cislo.contains("GYSEV") {
        return true;
    }

    let trasa = item.get("trasa").and_then(Value::as_str).unwrap_or("").to_lowercase();
    let nazev = item.get("nazev").and_then(Value::as_str).unwrap_or("").to_lowercase();
    let combined = format!("{trasa} {nazev}");

    HU_KEYWORDS.iter().any(|kw| combined.contains(kw))
}

pub fn clean_train_number(raw_num: &str) -> Option<String> {
    let s = raw_num.trim();
    if s.is_empty() {
        return None;
    }

    // Ha HÉV (36H5, H5, H6, H7, H8, H9, stb.), arra a vagonWEB-en nincs összeállítás
    if s.contains("36H") || (s.starts_with('H') && s.chars().count() <= 3) || s.to_uppercase().contains("HÉV") {
        return None;
    }

    let mut stripped = s;
    if stripped.len() >= 5 && (stripped.starts_with("55") || stripped.starts_with("43")) {
        stripped = &stripped[2..];
    }

    for mat in DIGITS_RE.find_iter(stripped) {
        let m = mat.as_str();
        if (1..=5).contains(&m.len()) {
            return Some(m.to_string());
        }
    }

    if stripped.chars().all(|c| c.is_ascii_digit()) && !stripped.is_empty() {
        Some(stripped.to_string())
    } else {
        None
    }
}

fn format_vagonweb_date(text: &str) -> String {
    let mut clean = text.trim().to_string();
    clean = clean.replace("&nbsp;", " ");

    clean = RE_VCERA.replace_all(&clean, "(tegnap)").to_string();
    clean = RE_DNES.replace_all(&clean, "(ma)").to_string();
    clean = RE_STANICI.replace_all(&clean, "– Állomás: ").to_string();
    clean = RE_USEKU.replace_all(&clean, "– Szakasz: ").to_string();
    clean = RE_PLANOVANE.replace_all(&clean, "").to_string();
    clean = RE_SKUTECNE.replace_all(&clean, "").to_string();

    clean = CZ_DAYS_RE.replace_all(&clean, |caps: &regex::Captures| {
        let val = &caps[1];
        if val.eq_ignore_ascii_case("po") {
            "Hétfő"
        } else if val.eq_ignore_ascii_case("út") {
            "Kedd"
        } else if val.eq_ignore_ascii_case("st") {
            "Szerda"
        } else if val.eq_ignore_ascii_case("čt") {
            "Csütörtök"
        } else if val.eq_ignore_ascii_case("pá") {
            "Péntek"
        } else if val.eq_ignore_ascii_case("so") {
            "Szombat"
        } else if val.eq_ignore_ascii_case("ne") {
            "Vasárnap"
        } else {
            ""
        }
    }).to_string();

    // d.m.yyyy -> yyyy.mm.dd.
    clean = DATE_DMY_RE.replace_all(&clean, |caps: &regex::Captures| {
        let day: u32 = caps[1].parse().unwrap_or(0);
        let month: u32 = caps[2].parse().unwrap_or(0);
        let year = &caps[3];
        format!("{year}.{month:02}.{day:02}.")
    }).to_string();

    // d.m. -> mm.dd. (preserving already converted yyyy.mm.dd.)
    clean = DATE_COMBINED_RE.replace_all(&clean, |caps: &regex::Captures| {
        if let Some(already_full) = caps.get(1) {
            already_full.as_str().to_string()
        } else {
            let day: u32 = caps[2].parse().unwrap_or(0);
            let month: u32 = caps[3].parse().unwrap_or(0);
            format!("{month:02}.{day:02}.")
        }
    }).to_string();

    WHITESPACE_RE.replace_all(&clean, " ").trim().to_string()
}

fn resolve_url(base: &str, relative: &str) -> String {
    if relative.starts_with("http://") || relative.starts_with("https://") {
        relative.to_string()
    } else {
        let base_trimmed = base.trim_end_matches('/');
        let rel_trimmed = relative.trim_start_matches('/');
        format!("{base_trimmed}/{rel_trimmed}")
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Amenity {
    src: String,
    title: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Car {
    car_number: String,
    car_type: String,
    car_sub: String,
    operator: String,
    img_url: String,
    car_class: &'static str,
    #[serde(rename = "isLoco")]
    is_loco: bool,
    #[serde(rename = "isEmu")]
    is_emu: bool,
    amenities: Vec<Amenity>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Composition {
    vlak_id: String,
    raw_header: String,
    display_header: String,
    is_actual: bool,
    #[serde(rename = "type")]
    comp_type: &'static str,
    type_label: &'static str,
    cars_count: usize,
    cars: Vec<Car>,
}

fn parse_vagonweb_html(html: &str) -> Vec<Composition> {
    let mut compositions = Vec::new();

    for caps in VLAK_BLOCK_RE.captures_iter(html) {
        let vlak_id = caps[1].to_string();
        let header_raw = &caps[2];

        let clean_header_no_tags = HTML_TAGS_RE.replace_all(header_raw, " ").to_string();
        let clean_header = WHITESPACE_RE.replace_all(&clean_header_no_tags, " ").trim().to_string();

        let tbl_pattern = format!(r#"<table class=['"]vlacek['"][^>]*id=['"]vlacek{vlak_id}['"][^>]*>"#);
        let tbl_re = match Regex::new(&tbl_pattern) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let tbl_m = match tbl_re.find(html) {
            Some(m) => m,
            None => continue,
        };

        let tbl_start = tbl_m.start();
        let next_vlak_pattern = "<div id='vlak_";
        let next_vlak_idx = html[tbl_start + 50..].find(next_vlak_pattern).map(|idx| tbl_start + 50 + idx);
        let tbl_end = next_vlak_idx.unwrap_or_else(|| (tbl_start + 18000).min(html.len()));
        let tbl_chunk = &html[tbl_start..tbl_end];

        let cells: Vec<&str> = CELL_SPLIT.split(tbl_chunk).skip(1).collect();
        let mut cars = Vec::new();

        for cell in cells {
            let img_url = IMG_M_RE1.captures(cell)
                .or_else(|| IMG_M_RE2.captures(cell))
                .map(|c| resolve_url(VAGONWEB_BASE, &c[1]))
                .unwrap_or_default();

            let car_num = NUM_M_RE.captures(cell).map(|c| c[1].trim().to_string()).unwrap_or_default();
            let car_type = TYPE_M_RE.captures(cell).map(|c| c[1].trim().to_string()).unwrap_or_default();
            let car_sub = SMALL_M_RE.captures(cell).map(|c| c[1].trim().to_string()).unwrap_or_default();

            let mut op = OP_M_RE.captures(cell).map(|c| c[1].trim().to_string()).unwrap_or_default();
            if op.is_empty() {
                for known_op in &["START", "MÁVRT", "MÁV", "ÖBB", "ČD", "ZSSK", "PKP", "GYSEV", "DB", "RegioJet"] {
                    if cell.contains(known_op) {
                        op = (*known_op).to_string();
                        break;
                    }
                }
            }

            let mut amenities = Vec::new();
            for pikto_caps in PIKTO_RE.captures_iter(cell) {
                amenities.push(Amenity {
                    src: resolve_url(VAGONWEB_BASE, &pikto_caps[1]),
                    title: pikto_caps[2].to_string(),
                });
            }

            let car_class = if cell.contains("tab-1tr") || cell.contains("1. třída") || cell.contains("1. osztály") {
                "1"
            } else if cell.contains("tab-2tr") || cell.contains("2. třída") || cell.contains("2. osztály") {
                "2"
            } else {
                ""
            };

            let emu_types = [
                "415", "815", "425", "426", "406", "117", "Bzmot", "136", "5047", "5147",
                "FLIRT", "KISS", "Talent", "Desiro", "TramTrain", "BDVmot", "BVmot", "BVhmot"
            ];
            let is_emu = emu_types.iter().any(|&x| car_type.contains(x));

            let loco_types = ["470", "480", "431", "432", "433", "182", "1116", "1216", "383", "380", "193"];
            let is_loco = !is_emu && (
                LOCO_RE.is_match(cell)
                || (car_num.is_empty() && loco_types.iter().any(|&x| car_type.contains(x)))
            );

            if !img_url.is_empty() || !car_type.is_empty() || !car_num.is_empty() {
                cars.push(Car {
                    car_number: car_num,
                    car_type,
                    car_sub,
                    operator: op,
                    img_url,
                    car_class,
                    is_loco,
                    is_emu,
                    amenities,
                });
            }
        }

        let clean_lower = clean_header.to_lowercase();
        let is_actual = clean_lower.contains("skuteč") || clean_lower.contains("tényleges");
        let formatted_date = format_vagonweb_date(&clean_header);

        compositions.push(Composition {
            vlak_id,
            raw_header: clean_header,
            display_header: formatted_date,
            is_actual,
            comp_type: if is_actual { "actual" } else { "planned" },
            type_label: if is_actual { "Tényleges összeállítás" } else { "Tervezett menetrendi összeállítás" },
            cars_count: cars.len(),
            cars,
        });
    }

    compositions
}

pub async fn composition(st: &AppState, raw_train_num: String) -> CacheResult {
    let clean_num = match clean_train_number(&raw_train_num) {
        Some(num) => num,
        None => {
            let res_fail = json!({
                "success": false,
                "message": format!("Érvénytelen vonatszám: '{raw_train_num}'"),
                "trainNumber": raw_train_num
            });
            return Ok(to_bytes(&res_fail).unwrap_or_default());
        }
    };

    let cache_key = format!("vagonweb:{clean_num}");
    st.cached(cache_key, CACHE_TTL, build_composition(st, clean_num)).await
}

async fn build_composition(st: &AppState, clean_num: String) -> Result<Bytes> {
    let current_year = chrono::Utc::now().year();
    let years_to_try = [current_year, current_year - 1];
    let mut matched_train: Option<Value> = None;
    let mut target_year = current_year;

    for y in years_to_try {
        let url = format!("{VAGONWEB_BASE}json_vlaky.php?jmeno={clean_num}&rok={y}");
        let req = st.http.get(&url)
            .header("User-Agent", BROWSER_UA)
            .header("Accept-Language", "hu,en;q=0.9")
            .header("X-Requested-With", "XMLHttpRequest")
            .timeout(Duration::from_secs(7));

        if let Ok(resp) = req.send().await {
            if resp.status().is_success() {
                if let Ok(bytes) = resp.bytes().await {
                    let text = String::from_utf8_lossy(&bytes);
                    // Remove BOM if present
                    let clean_text = text.trim_start_matches('\u{feff}');
                    if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(clean_text) {
                        let hu_trains: Vec<Value> = items.into_iter().filter(is_hungarian_train).collect();
                        if hu_trains.is_empty() {
                            continue;
                        }

                        // 1. Pontos vonatszám egyezés
                        if let Some(exact) = hu_trains.iter().find(|x| x.get("cislo").and_then(Value::as_str) == Some(&clean_num)) {
                            matched_train = Some(exact.clone());
                            target_year = y;
                            break;
                        }

                        // 2. Összetett vonatszámot tartalmazó
                        if let Some(containing) = hu_trains.iter().find(|x| x.get("cislo").and_then(Value::as_str).is_some_and(|c| c.contains(&clean_num))) {
                            matched_train = Some(containing.clone());
                            target_year = y;
                            break;
                        }
                    }
                }
            }
        }
    }

    let Some(train) = matched_train else {
        let res_fail = json!({
            "success": false,
            "message": format!("Nem található vagonWEB összeállítás a(z) {clean_num} vonathoz."),
            "trainNumber": clean_num,
            "vagonwebSearchUrl": format!("{VAGONWEB_BASE}vlak.php?cislo={clean_num}")
        });
        return to_bytes(&res_fail);
    };

    let zeme = train.get("zeme").and_then(Value::as_str).unwrap_or("START");
    let kategorie = train.get("druh").and_then(Value::as_str).unwrap_or("");
    let cislo = train.get("cislo").and_then(Value::as_str).unwrap_or(&clean_num);
    let nazev = train.get("nazev").and_then(Value::as_str).unwrap_or("");
    let trasa = train.get("trasa").and_then(Value::as_str).unwrap_or("");

    let vagonweb_page_url = format!(
        "{VAGONWEB_BASE}vlak.php?zeme={}&kategorie={}&cislo={}&rok={}&lang=hu",
        urlencoding_encode(zeme),
        urlencoding_encode(kategorie),
        urlencoding_encode(cislo),
        target_year
    );

    let ajax_url = format!("{VAGONWEB_BASE}ajax_dalsi_razeni_vlak.php");

    // Párhuzamos lekérés: Tényleges és Tervezett összeállítások
    let fetch_actual = async {
        let params = [
            ("rok", target_year.to_string()),
            ("zeme", zeme.to_string()),
            ("cislo", cislo.to_string()),
            ("nazev", "_n_".to_string()),
            ("styl", "r".to_string()),
            ("aktualni_rok", current_year.to_string()),
            ("cislo_vozu", "".to_string()),
            ("datum", "vse".to_string()),
            ("lang", "hu".to_string()),
        ];
        if let Ok(resp) = st.http.post(&ajax_url)
            .form(&params)
            .header("User-Agent", BROWSER_UA)
            .header("Accept-Language", "hu,en;q=0.9")
            .header("X-Requested-With", "XMLHttpRequest")
            .timeout(Duration::from_secs(7))
            .send().await {
            if resp.status().is_success() {
                if let Ok(text) = resp.text().await {
                    return parse_vagonweb_html(&text);
                }
            }
        }
        Vec::new()
    };

    let fetch_planned = async {
        let params = [
            ("rok", target_year.to_string()),
            ("zeme", zeme.to_string()),
            ("cislo", cislo.to_string()),
            ("nazev", "_n_".to_string()),
            ("styl", "r".to_string()),
            ("aktualni_rok", current_year.to_string()),
            ("cislo_vozu", "".to_string()),
            ("vsechny_planovane", "1".to_string()),
            ("lang", "hu".to_string()),
        ];
        if let Ok(resp) = st.http.post(&ajax_url)
            .form(&params)
            .header("User-Agent", BROWSER_UA)
            .header("Accept-Language", "hu,en;q=0.9")
            .header("X-Requested-With", "XMLHttpRequest")
            .timeout(Duration::from_secs(7))
            .send().await {
            if resp.status().is_success() {
                if let Ok(text) = resp.text().await {
                    return parse_vagonweb_html(&text);
                }
            }
        }
        Vec::new()
    };

    let (mut actual_comps, mut planned_comps) = tokio::join!(fetch_actual, fetch_planned);

    let has_actual = !actual_comps.is_empty();
    let has_planned = !planned_comps.is_empty();

    actual_comps.truncate(6);
    planned_comps.truncate(6);

    let result = json!({
        "success": true,
        "trainNumber": clean_num,
        "trainName": nazev,
        "category": kategorie,
        "operator": zeme,
        "route": trasa,
        "year": target_year,
        "vagonwebUrl": vagonweb_page_url,
        "hasActual": has_actual,
        "hasPlanned": has_planned,
        "latestActual": actual_comps.first(),
        "defaultPlanned": planned_comps.first(),
        "actualCompositions": actual_comps,
        "plannedCompositions": planned_comps
    });

    to_bytes(&result)
}

fn urlencoding_encode(s: &str) -> String {
    let mut encoded = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
            encoded.push(b as char);
        } else {
            use std::fmt::Write;
            write!(&mut encoded, "%{b:02X}").unwrap();
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_date() {
        let s = "Skutečné řazení vlaku dne: so 13.12.2025 ve stanici: Budapest-Keleti";
        assert_eq!(format_vagonweb_date(s), "Szombat 2025.12.13. – Állomás: Budapest-Keleti");

        let s2 = "Plánované řazení 15.12.2024 - 1.1.2025";
        assert_eq!(format_vagonweb_date(s2), "2024.12.15. - 2025.01.01.");

        let s3 = "[dnes] čt 15.10. v úseku: Győr - Hegyeshalom";
        assert_eq!(format_vagonweb_date(s3), "(ma) Csütörtök 10.15. – Szakasz: Győr - Hegyeshalom");
    }

    #[test]
    fn test_clean_number() {
        assert_eq!(clean_train_number("55149"), Some("149".into()));
        assert_eq!(clean_train_number("IC 560"), Some("560".into()));
        assert_eq!(clean_train_number("36H4"), None);
        assert_eq!(clean_train_number("H5"), None);
    }
}
