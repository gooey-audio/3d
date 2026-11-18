//! The web UI (`studio/web/dist`), embedded in release builds and read from disk in
//! debug builds. Unknown paths get `index.html` (client-side routes).

use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "$CARGO_MANIFEST_DIR/../web/dist"]
struct Dist;

pub async fn serve(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path.starts_with("api/") {
        return (StatusCode::NOT_FOUND, "no such API route").into_response();
    }
    let (file, name) = match Dist::get(path).filter(|_| !path.is_empty()) {
        Some(f) => (f, path),
        None => match Dist::get("index.html") {
            Some(f) => (f, "index.html"),
            None => return (StatusCode::NOT_FOUND, "web UI not built").into_response(),
        },
    };
    let mime = mime_guess::from_path(name).first_or_octet_stream();
    // Vite fingerprints assets; index.html must always be fresh.
    let cache = if name.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    (
        [
            (header::CONTENT_TYPE, mime.to_string()),
            (header::CACHE_CONTROL, cache.to_owned()),
        ],
        file.data,
    )
        .into_response()
}
