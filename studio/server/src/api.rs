//! HTTP API (JSON) and the server-sent event stream.
//!
//!   GET   /api/info                       directory, library, agent model
//!   GET   /api/events                     SSE: parts, script, scene, building, build, agent
//!   GET   /api/parts                      [{name, build}]
//!   POST  /api/parts                      {name, source?} -> a new part script
//!   GET   /api/parts/{p}                  script, sha, scene, resolved, build, turn
//!   PUT   /api/parts/{p}/script           {source, base_sha} (409 if base_sha is stale)
//!   POST  /api/parts/{p}/build            rebuild now
//!   GET   /api/parts/{p}/mesh.stl         last good mesh
//!   GET   /api/parts/{p}/report           last build: report.json or the error
//!   GET   /api/parts/{p}/export.step      STEP of the current script + params
//!   GET   /api/parts/{p}/scene            PATCH: JSON merge patch
//!   GET   /api/parts/{p}/chat             turns; POST {message}; DELETE clears
//!   POST  /api/parts/{p}/chat/stop
//!   POST  /api/parts/{p}/revert/{turn}    restore the script + scene from before a turn
//!   GET   /api/library                    finishes, resolved
//!   GET   /api/asset?path=REL             a file in the project (HDRIs)
//!   GET   /api/uploads                    uploaded STLs; POST multipart `file` fields
//!   DELETE /api/uploads/{sha}
//!   GET   /api/renders                    render jobs, newest first
//!   POST  /api/renders                    {kind: sheet|still, ...} (renders.rs)
//!   POST  /api/parts/{p}/render           a sheet of the part in its scene's look
//!   GET   /api/renders/{id}               job with its sheet index; DELETE removes it
//!   POST  /api/renders/{id}/cancel
//!   GET   /api/renders/{id}/image         the PNG

use std::convert::Infallible;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, Query, Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use futures_util::Stream;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;

use crate::{App, AppError, agent, renders, sha256_hex, valid_part};

pub struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}

impl From<AppError> for ApiError {
    fn from(e: AppError) -> Self {
        let status = if e.0.starts_with("no part ") {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::UNPROCESSABLE_ENTITY
        };
        ApiError(status, e.0)
    }
}

fn err(status: StatusCode, msg: impl Into<String>) -> ApiError {
    ApiError(status, msg.into())
}

type R<T> = Result<T, ApiError>;
type S = State<Arc<App>>;

/// The router behind the local-only guard, for a server on `port`.
pub fn app(app: Arc<App>, port: u16) -> Router {
    router(app).layer(middleware::from_fn(move |req, next| local_only(req, next, port)))
}

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/api/info", get(info))
        .route("/api/events", get(events))
        .route("/api/parts", get(parts).post(create_part))
        .route("/api/parts/{part}", get(part))
        .route("/api/parts/{part}/script", put(put_script))
        .route("/api/parts/{part}/build", post(build))
        .route("/api/parts/{part}/mesh.stl", get(mesh))
        .route("/api/parts/{part}/report", get(report))
        .route("/api/parts/{part}/export.step", get(export_step))
        .route("/api/parts/{part}/scene", get(get_scene).patch(patch_scene))
        .route(
            "/api/parts/{part}/chat",
            get(get_chat).post(post_chat).delete(clear_chat),
        )
        .route("/api/parts/{part}/chat/stop", post(stop_chat))
        .route("/api/parts/{part}/revert/{turn}", post(revert))
        .route("/api/library", get(library))
        .route("/api/asset", get(asset))
        .route(
            "/api/uploads",
            get(uploads)
                .post(upload)
                .layer(axum::extract::DefaultBodyLimit::max(512 << 20)),
        )
        .route("/api/uploads/{sha}", axum::routing::delete(delete_upload))
        .route("/api/renders", get(list_renders).post(submit_render))
        .route("/api/parts/{part}/render", post(render_part))
        .route("/api/renders/{id}", get(get_render).delete(delete_render))
        .route("/api/renders/{id}/cancel", post(cancel_render))
        .route("/api/renders/{id}/image", get(render_image))
        .fallback(crate::assets::serve)
        .with_state(app)
}

async fn info(State(app): S) -> Json<Value> {
    Json(json!({
        "version": crate::VERSION,
        "dir": app.dir,
        "library": app.library.path,
        "agent": app.agent.as_ref().map(|a| json!({"model": a.model, "base_url": a.base_url})),
    }))
}

async fn events(State(app): S) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let stream = BroadcastStream::new(app.events.subscribe()).filter_map(|m| match m {
        Ok(text) => Some(Ok(Event::default().data(text))),
        // Lagged: the browser refetches on `resync`.
        Err(_) => Some(Ok(Event::default().data(r#"{"type":"resync"}"#))),
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

async fn parts(State(app): S) -> Json<Value> {
    Json(json!(
        app.part_names()
            .into_iter()
            .map(|n| {
                let b = app.latest(&n).map(|b| json!({"ok": b.ok, "rev": b.rev}));
                json!({"name": n, "build": b})
            })
            .collect::<Vec<_>>()
    ))
}

#[derive(Deserialize)]
struct NewPart {
    name: String,
    source: Option<String>,
}

const TEMPLATE: &str = r#"// New part. Units: mm, Z up.

export const defaultParams = {
  width: 40,
  depth: 30,
  height: 10,
  radius: 2,
};

export const paramRanges = {
  width: [5, 300],
  depth: [5, 300],
  height: [1, 100],
  radius: [0, 10],
};

export function main({ drawRoundedRectangle }, p) {
  return drawRoundedRectangle(p.width, p.depth, p.radius).sketchOnPlane("XY").extrude(p.height);
}
"#;

async fn create_part(State(app): S, Json(req): Json<NewPart>) -> R<Json<Value>> {
    if !valid_part(&req.name) {
        return Err(err(StatusCode::BAD_REQUEST, "names use letters, digits, - _ and ."));
    }
    let path = app.script_path(&req.name);
    if path.exists() {
        return Err(err(StatusCode::CONFLICT, format!("{}.js exists", req.name)));
    }
    crate::write_atomic(&path, req.source.as_deref().unwrap_or(TEMPLATE).as_bytes())?;
    app.emit(json!({"type": "parts"}));
    app.touch(&req.name)?;
    Ok(Json(json!({"name": req.name})))
}

async fn part(State(app): S, Path(part): Path<String>) -> R<Json<Value>> {
    app.check_part(&part)?;
    let script = app.read_script(&part)?;
    let scene = app.load_scene(&part)?;
    if !app.has_build(&part) {
        app.touch(&part)?;
    }
    Ok(Json(json!({
        "name": part,
        "script": script,
        "sha": sha256_hex(script.as_bytes()),
        "scene": scene,
        "resolved": scene.resolve(&app.library).unwrap_or_else(|e| json!({"error": e.0})),
        "build": app.latest(&part).map(|b| b.summary()),
        "good_rev": app.last_good(&part).map(|b| b.rev),
        "turn": app.running_turn(&part),
    })))
}

#[derive(Deserialize)]
struct PutScript {
    source: String,
    base_sha: Option<String>,
}

async fn put_script(State(app): S, Path(part): Path<String>, Json(req): Json<PutScript>) -> R<Json<Value>> {
    app.check_part(&part)?;
    if app.running_turn(&part).is_some() {
        return Err(err(StatusCode::CONFLICT, "the agent is editing this part"));
    }
    let current = sha256_hex(app.read_script(&part)?.as_bytes());
    if let Some(base) = &req.base_sha
        && *base != current
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "the script changed on disk since you loaded it".into(),
        ));
    }
    let rev = app.write_script(&part, &req.source)?;
    Ok(Json(json!({"sha": sha256_hex(req.source.as_bytes()), "rev": rev})))
}

async fn build(State(app): S, Path(part): Path<String>) -> R<Json<Value>> {
    Ok(Json(json!({"rev": app.rebuild(&part)?})))
}

async fn mesh(State(app): S, Path(part): Path<String>) -> R<Response> {
    app.check_part(&part)?;
    let b = app
        .last_good(&part)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "no good build yet"))?;
    let bytes = tokio::fs::read(b.mesh.as_ref().unwrap())
        .await
        .map_err(|e| err(StatusCode::NOT_FOUND, e.to_string()))?;
    Ok((
        [
            (header::CONTENT_TYPE, "model/stl".to_owned()),
            (header::CACHE_CONTROL, "no-store".to_owned()),
            (header::HeaderName::from_static("x-build-rev"), b.rev.to_string()),
        ],
        bytes,
    )
        .into_response())
}

async fn report(State(app): S, Path(part): Path<String>) -> R<Json<Value>> {
    app.check_part(&part)?;
    let b = app
        .latest(&part)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "not built yet"))?;
    Ok(Json(json!(*b)))
}

async fn export_step(State(app): S, Path(part): Path<String>) -> R<Response> {
    let path = app.export_step(&part).await?;
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/step".to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{part}.step\""),
            ),
        ],
        bytes,
    )
        .into_response())
}

async fn get_scene(State(app): S, Path(part): Path<String>) -> R<Json<Value>> {
    app.check_part(&part)?;
    let s = app.load_scene(&part)?;
    Ok(Json(json!({"scene": s, "resolved": s.resolve(&app.library)?})))
}

async fn patch_scene(State(app): S, Path(part): Path<String>, Json(patch): Json<Value>) -> R<Json<Value>> {
    app.check_part(&part)?;
    let (s, rev) = app.patch_scene(&part, &patch)?;
    Ok(Json(
        json!({"scene": s, "resolved": s.resolve(&app.library)?, "rev": rev}),
    ))
}

async fn get_chat(State(app): S, Path(part): Path<String>) -> R<Json<Value>> {
    app.check_part(&part)?;
    Ok(Json(
        json!({"turns": agent::load_turns(&app, &part), "running": app.running_turn(&part)}),
    ))
}

#[derive(Deserialize)]
struct ChatReq {
    message: String,
}

async fn post_chat(State(app): S, Path(part): Path<String>, Json(req): Json<ChatReq>) -> R<Json<Value>> {
    if req.message.trim().is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "empty message"));
    }
    if app.agent.is_none() {
        return Err(err(
            StatusCode::SERVICE_UNAVAILABLE,
            "the agent is off: set DEEPSEEK_API_KEY and restart gooey-studio",
        ));
    }
    if app.running_turn(&part).is_some() {
        return Err(err(StatusCode::CONFLICT, "a turn is already running for this part"));
    }
    let id = agent::start(app.clone(), &part, &req.message)?;
    Ok(Json(json!({"turn": id})))
}

async fn clear_chat(State(app): S, Path(part): Path<String>) -> R<Json<Value>> {
    app.check_part(&part)?;
    agent::clear(&app, &part)?;
    Ok(Json(json!({"ok": true})))
}

async fn stop_chat(State(app): S, Path(part): Path<String>) -> Json<Value> {
    Json(json!({"stopped": agent::stop(&app, &part)}))
}

async fn revert(State(app): S, Path((part, turn)): Path<(String, String)>) -> R<Json<Value>> {
    agent::revert(&app, &part, &turn)?;
    Ok(Json(json!({"ok": true})))
}

async fn library(State(app): S) -> Json<Value> {
    let finishes: Vec<Value> = app
        .library
        .entries
        .iter()
        .map(|(name, e)| {
            json!({"name": name, "label": e.label,
                   "material": crate::scene::resolve_material(Some(&json!(name)), &app.library).ok()})
        })
        .collect();
    Json(json!({"path": app.library.path, "finishes": finishes}))
}

#[derive(Deserialize)]
struct AssetQuery {
    path: String,
}

async fn asset(State(app): S, Query(q): Query<AssetQuery>) -> R<Response> {
    let p = app.project_file(&q.path).map_err(|e| err(StatusCode::NOT_FOUND, e.0))?;
    let bytes = tokio::fs::read(&p)
        .await
        .map_err(|e| err(StatusCode::NOT_FOUND, e.to_string()))?;
    let mime = mime_guess::from_path(&p).first_or_octet_stream();
    Ok(([(header::CONTENT_TYPE, mime.to_string())], Body::from(bytes)).into_response())
}

/// Part scripts run as code on this machine, so only this machine's pages may drive the
/// server: the Host must be a loopback name (no DNS rebinding) and any Origin must be
/// the studio itself or the Vite dev server.
pub async fn local_only(req: Request, next: Next, port: u16) -> Response {
    let loopback = |hostport: &str| {
        let host = hostport.rsplit_once(':').map_or(hostport, |(h, _)| h);
        matches!(host, "localhost" | "127.0.0.1" | "[::1]")
    };
    let host_ok = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .is_some_and(loopback);
    let origin_ok = match req.headers().get(header::ORIGIN).and_then(|h| h.to_str().ok()) {
        None => true,
        Some(o) => o
            .strip_prefix("http://")
            .is_some_and(|hp| loopback(hp) && (hp.ends_with(&format!(":{port}")) || hp.ends_with(":5173"))),
    };
    if host_ok && origin_ok {
        next.run(req).await
    } else {
        (StatusCode::FORBIDDEN, "gooey-studio only serves pages on this machine").into_response()
    }
}

// --- uploads and renders --------------------------------------------------------

async fn uploads(State(app): S) -> Json<Value> {
    Json(json!(renders::list_uploads(&app)))
}

async fn upload(State(app): S, mut form: axum::extract::Multipart) -> R<Json<Value>> {
    let mut saved = vec![];
    while let Some(field) = form
        .next_field()
        .await
        .map_err(|e| err(StatusCode::BAD_REQUEST, e.to_string()))?
    {
        let name = field.file_name().unwrap_or("part.stl").to_owned();
        let bytes = field
            .bytes()
            .await
            .map_err(|e| err(StatusCode::BAD_REQUEST, e.to_string()))?;
        saved.push(renders::save_upload(&app, &name, &bytes)?);
    }
    if saved.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "no files"));
    }
    app.emit(json!({"type": "uploads"}));
    Ok(Json(json!(saved)))
}

async fn delete_upload(State(app): S, Path(sha): Path<String>) -> R<Json<Value>> {
    renders::delete_upload(&app, &sha)?;
    app.emit(json!({"type": "uploads"}));
    Ok(Json(json!({"ok": true})))
}

async fn list_renders(State(app): S) -> Json<Value> {
    Json(json!(app.renders.list()))
}

async fn submit_render(State(app): S, Json(req): Json<renders::Request>) -> R<Json<Value>> {
    Ok(Json(json!(renders::submit(&app, req)?)))
}

#[derive(Deserialize, Default)]
struct PartRender {
    #[serde(default)]
    views: Vec<Value>,
    orbit: Option<String>,
    spp: Option<u32>,
}

async fn render_part(State(app): S, Path(part): Path<String>, body: Option<Json<PartRender>>) -> R<Json<Value>> {
    let b = body.map(|b| b.0).unwrap_or_default();
    Ok(Json(json!(renders::part_sheet(&app, &part, b.views, b.orbit, b.spp)?)))
}

async fn get_render(State(app): S, Path(id): Path<String>) -> R<Json<Value>> {
    let j = app
        .renders
        .get(&id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "no such render"))?;
    Ok(Json(json!(j)))
}

async fn cancel_render(State(app): S, Path(id): Path<String>) -> R<Json<Value>> {
    renders::cancel(&app, &id)?;
    Ok(Json(json!({"ok": true})))
}

async fn delete_render(State(app): S, Path(id): Path<String>) -> R<Json<Value>> {
    renders::delete(&app, &id)?;
    app.emit(json!({"type": "renders"}));
    Ok(Json(json!({"ok": true})))
}

async fn render_image(State(app): S, Path(id): Path<String>) -> R<Response> {
    let p = renders::image_path(&app, &id).ok_or_else(|| err(StatusCode::NOT_FOUND, "no image (yet)"))?;
    let bytes = tokio::fs::read(&p)
        .await
        .map_err(|e| err(StatusCode::NOT_FOUND, e.to_string()))?;
    Ok(([(header::CONTENT_TYPE, "image/png")], bytes).into_response())
}
