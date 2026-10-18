//! Egységes hibakezelés. A válaszok formátuma megegyezik a korábbi FastAPI-éval:
//! `{"detail": "..."}`.

use std::fmt;

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};

#[derive(Debug, Clone)]
pub struct Error(pub String);

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        // Az URL-t kivesszük, mert az API kulcsot tartalmazhatja.
        Error(e.without_url().to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error(format!("JSON hiba: {e}"))
    }
}

impl From<prost::DecodeError> for Error {
    fn from(e: prost::DecodeError) -> Self {
        Error(format!("Protobuf hiba: {e}"))
    }
}

/// HTTP hibaválasz.
pub struct ApiError {
    status: StatusCode,
    detail: String,
}

impl ApiError {
    pub fn bad_gateway(prefix: &str, e: impl fmt::Display) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            detail: format!("{prefix}: {e}"),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({ "detail": self.detail })),
        )
            .into_response()
    }
}
