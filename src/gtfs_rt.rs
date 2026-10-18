//! BKK bináris GTFS-Realtime (`VehiclePositions.pb`) letöltése és dekódolása.
//!
//! A protobuf üzeneteket kézzel definiáljuk (`prost` derive), csak a szükséges mezőkkel –
//! így nincs szükség `protoc`-ra a buildhez, az ismeretlen mezőket a dekóder átugorja.

use std::sync::Arc;

use bytes::Bytes;
use prost::Message;
use serde::Serialize;

use crate::{
    config::GTFS_RT_BASE_URL,
    error::{Error, Result},
    state::AppState,
    util::{py_round, round_to, to_bytes},
};

mod pb {
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct FeedMessage {
        #[prost(message, optional, tag = "1")]
        pub header: Option<FeedHeader>,
        #[prost(message, repeated, tag = "2")]
        pub entity: Vec<FeedEntity>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct FeedHeader {
        #[prost(uint64, optional, tag = "3")]
        pub timestamp: Option<u64>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct FeedEntity {
        #[prost(string, optional, tag = "1")]
        pub id: Option<String>,
        #[prost(message, optional, tag = "4")]
        pub vehicle: Option<VehiclePosition>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct VehiclePosition {
        #[prost(message, optional, tag = "1")]
        pub trip: Option<TripDescriptor>,
        #[prost(message, optional, tag = "2")]
        pub position: Option<Position>,
        #[prost(uint64, optional, tag = "5")]
        pub timestamp: Option<u64>,
        #[prost(message, optional, tag = "8")]
        pub vehicle: Option<VehicleDescriptor>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct TripDescriptor {
        #[prost(string, optional, tag = "1")]
        pub trip_id: Option<String>,
        #[prost(string, optional, tag = "5")]
        pub route_id: Option<String>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct Position {
        #[prost(float, optional, tag = "1")]
        pub latitude: Option<f32>,
        #[prost(float, optional, tag = "2")]
        pub longitude: Option<f32>,
        #[prost(float, optional, tag = "3")]
        pub bearing: Option<f32>,
        #[prost(float, optional, tag = "5")]
        pub speed: Option<f32>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct VehicleDescriptor {
        #[prost(string, optional, tag = "1")]
        pub id: Option<String>,
        #[prost(string, optional, tag = "2")]
        pub label: Option<String>,
        #[prost(string, optional, tag = "3")]
        pub license_plate: Option<String>,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GtfsVehicle {
    entity_id: String,
    vehicle_id: String,
    label: String,
    license_plate: String,
    route_id: String,
    trip_id: String,
    lat: Option<f64>,
    lon: Option<f64>,
    bearing: Option<f64>,
    speed_kmh: i64,
    timestamp: u64,
    /// Az entitás sorszáma a feedben (a `limit` az entitásokra vonatkozik).
    #[serde(skip)]
    entity_index: usize,
}

/// A teljes, dekódolt feed – egyszer töltjük le, minden `limit` értékhez ezt szeleteljük.
pub struct GtfsFeed {
    feed_timestamp: u64,
    total_entities: usize,
    vehicles: Vec<GtfsVehicle>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GtfsResponse<'a> {
    feed_timestamp: u64,
    total_entities_in_feed: usize,
    returned_count: usize,
    vehicles: &'a [GtfsVehicle],
}

pub async fn vehicle_positions(st: &AppState, key: String, limit: usize) -> Result<Bytes> {
    let feed = st
        .gtfs
        .try_get_with((), fetch_feed(st, key))
        .await
        .map_err(|e| Error(e.to_string()))?;

    let n = feed.vehicles.partition_point(|v| v.entity_index < limit);
    to_bytes(&GtfsResponse {
        feed_timestamp: feed.feed_timestamp,
        total_entities_in_feed: feed.total_entities,
        returned_count: n,
        vehicles: &feed.vehicles[..n],
    })
}

async fn fetch_feed(st: &AppState, key: String) -> Result<Arc<GtfsFeed>> {
    let raw = st
        .http
        .get(format!("{GTFS_RT_BASE_URL}/VehiclePositions.pb"))
        .query(&[("key", key.as_str())])
        .timeout(std::time::Duration::from_secs(12))
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;

    let feed = pb::FeedMessage::decode(raw)?;
    let total_entities = feed.entity.len();

    let vehicles = feed
        .entity
        .into_iter()
        .enumerate()
        .filter_map(|(entity_index, e)| {
            let v = e.vehicle?;
            let pos = v.position.as_ref();
            let trip = v.trip.unwrap_or_default();
            let desc = v.vehicle.unwrap_or_default();
            Some(GtfsVehicle {
                entity_id: e.id.unwrap_or_default(),
                vehicle_id: desc.id.unwrap_or_default(),
                label: desc.label.unwrap_or_default(),
                license_plate: desc.license_plate.unwrap_or_default(),
                route_id: trip.route_id.unwrap_or_default(),
                trip_id: trip.trip_id.unwrap_or_default(),
                lat: pos.map(|p| round_to(p.latitude.unwrap_or(0.0) as f64, 6)),
                lon: pos.map(|p| round_to(p.longitude.unwrap_or(0.0) as f64, 6)),
                bearing: pos.and_then(|p| p.bearing).map(|b| round_to(b as f64, 1)),
                speed_kmh: pos
                    .and_then(|p| p.speed)
                    .map_or(0, |s| py_round(s as f64 * 3.6)),
                timestamp: v.timestamp.unwrap_or(0),
                entity_index,
            })
        })
        .collect();

    Ok(Arc::new(GtfsFeed {
        feed_timestamp: feed.header.and_then(|h| h.timestamp).unwrap_or(0),
        total_entities,
        vehicles,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_roundtrip() {
        let msg = pb::FeedMessage {
            header: Some(pb::FeedHeader { timestamp: Some(1_700_000_000) }),
            entity: vec![pb::FeedEntity {
                id: Some("e1".into()),
                vehicle: Some(pb::VehiclePosition {
                    trip: Some(pb::TripDescriptor {
                        trip_id: Some("t1".into()),
                        route_id: Some("BKK_3040".into()),
                    }),
                    position: Some(pb::Position {
                        latitude: Some(47.5),
                        longitude: Some(19.04),
                        bearing: Some(90.0),
                        speed: Some(10.0),
                    }),
                    timestamp: Some(1_700_000_001),
                    vehicle: None,
                }),
            }],
        };
        let decoded = pb::FeedMessage::decode(msg.encode_to_vec().as_slice()).unwrap();
        assert_eq!(decoded, msg);
    }
}
