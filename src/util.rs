//! Közös segédfüggvények: laza JSON hozzáférés (Python-szerű "truthiness"),
//! referencia-normalizálás, polyline dekódolás, kerekítés.

use std::collections::HashMap;

use bytes::Bytes;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::Result;

pub static NULL: Value = Value::Null;
pub static EMPTY_STR: Value = Value::String(String::new());

/// Python-féle igazságérték egy JSON értékre.
pub fn truthy_v(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

pub fn truthy(v: Option<&Value>) -> bool {
    v.is_some_and(truthy_v)
}

/// Python `a or b or ...`: az első igaz értékű elem.
pub fn first_truthy<'a, const N: usize>(vals: [Option<&'a Value>; N]) -> Option<&'a Value> {
    vals.into_iter().flatten().find(|v| truthy_v(v))
}

/// Python `str(x or "")`.
pub fn to_text(v: Option<&Value>) -> String {
    match v {
        Some(v) if truthy_v(v) => match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        },
        _ => String::new(),
    }
}

/// Python `str(x)` (None → "None").
pub fn py_str(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => "None".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(true)) => "True".into(),
        Some(Value::Bool(false)) => "False".into(),
        Some(other) => other.to_string(),
    }
}

/// Szám kinyerése számból vagy számot tartalmazó szövegből.
pub fn as_f64(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// Python `round()` – banker's rounding.
pub fn py_round(x: f64) -> i64 {
    x.round_ties_even() as i64
}

pub fn round_to(x: f64, decimals: i32) -> f64 {
    let m = 10f64.powi(decimals);
    (x * m).round_ties_even() / m
}

pub fn to_bytes<T: Serialize + ?Sized>(v: &T) -> Result<Bytes> {
    Ok(Bytes::from(serde_json::to_vec(v)?))
}

/// BKK OTP API `references` szótárak és listák egységes `id -> obj` elérése (másolás nélkül).
pub enum Refs<'a> {
    Obj(&'a Map<String, Value>),
    List(HashMap<&'a str, &'a Value>),
    Empty,
}

impl<'a> Refs<'a> {
    pub fn new(v: &'a Value) -> Self {
        match v {
            Value::Object(m) => Refs::Obj(m),
            Value::Array(a) => Refs::List(
                a.iter()
                    .filter_map(|it| Some((it.get("id")?.as_str()?, it)))
                    .collect(),
            ),
            _ => Refs::Empty,
        }
    }

    /// Hiányzó kulcs esetén `null`-t ad vissza (indexelve tovább is `null`).
    pub fn get(&self, key: Option<&Value>) -> &'a Value {
        let Some(k) = key.and_then(Value::as_str) else {
            return &NULL;
        };
        match self {
            Refs::Obj(m) => m.get(k).unwrap_or(&NULL),
            Refs::List(h) => h.get(k).copied().unwrap_or(&NULL),
            Refs::Empty => &NULL,
        }
    }

    pub fn first(&self) -> Option<&'a Value> {
        match self {
            Refs::Obj(m) => m.values().next(),
            Refs::List(h) => h.values().next().copied(),
            Refs::Empty => None,
        }
    }
}

/// Google encoded polyline dekódolása `[lat, lon]` pontokká.
/// Hibás/csonka bemenetnél az addig dekódolt pontokat adja vissza.
pub fn decode_polyline(s: &str) -> Vec<[f64; 2]> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len() / 4);
    let (mut i, mut lat, mut lng) = (0usize, 0i64, 0i64);
    'outer: while i < b.len() {
        let mut deltas = [0i64; 2];
        for d in deltas.iter_mut() {
            let (mut shift, mut result) = (0u32, 0i64);
            loop {
                let Some(&c) = b.get(i) else { break 'outer };
                let v = c as i64 - 63;
                i += 1;
                result |= (v & 0x1f) << shift;
                shift += 5;
                if v < 0x20 {
                    break;
                }
                if shift > 60 {
                    break 'outer;
                }
            }
            *d = if result & 1 != 0 { !(result >> 1) } else { result >> 1 };
        }
        lat += deltas[0];
        lng += deltas[1];
        // Osztás (nem szorzás 1e-5-tel), így a legrövidebb decimális alakot kapjuk.
        out.push([lat as f64 / 1e5, lng as f64 / 1e5]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polyline_reference_vector() {
        // Google dokumentáció példája
        let pts = decode_polyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
        assert_eq!(pts, vec![[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
    }

    #[test]
    fn polyline_truncated_is_safe() {
        assert_eq!(decode_polyline("_p~iF~ps|U_ul").len(), 1);
        assert!(decode_polyline("").is_empty());
    }
}
