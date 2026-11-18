//! API and agent-loop tests. No CAD worker is needed: builds use a missing worker and
//! fail fast with kind `worker`, which is all the agent loop needs to see. The model is
//! a mock server that streams canned OpenAI-style chunks.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::routing::post;
use gooey_cad::WorkerCommand;
use gooey_studio::{App, Config, agent, api};
use serde_json::{Value, json};
use tower::ServiceExt;

const SCRIPT: &str =
    "export const defaultParams = { w: 10 };\nexport function main(r, p) { return r.makeBaseBox(p.w, p.w, p.w); }\n";

fn app(dir: &std::path::Path, agent: Option<agent::Config>) -> Arc<App> {
    std::fs::write(dir.join("cube.js"), SCRIPT).unwrap();
    App::new(Config {
        dir: dir.to_owned(),
        library: None,
        worker: Some(WorkerCommand::program("/nonexistent/gooey-cad-worker")),
        agent,
    })
    .unwrap()
}

async fn send(router: &axum::Router, method: &str, uri: &str, body: Option<Value>, host: &str) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(uri).header("host", host);
    if body.is_some() {
        req = req.header("content-type", "application/json");
    }
    let req = req
        .body(body.map_or(Body::empty(), |b| Body::from(b.to_string())))
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test(flavor = "multi_thread")]
async fn script_put_detects_conflicts_and_scene_patches_validate() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(dir.path(), None);
    let r = api::app(app.clone(), 7878);
    let h = "localhost:7878";

    let (s, part) = send(&r, "GET", "/api/parts/cube", None, h).await;
    assert_eq!(s, StatusCode::OK);
    let sha = part["sha"].as_str().unwrap().to_owned();
    // A failed build (no worker) is reported, not hung.
    let b = app.wait_build("cube", 1, Duration::from_secs(10)).await.unwrap();
    assert!(!b.ok && b.error.as_ref().unwrap().kind == gooey_cad::ErrorKind::Worker);

    let new = SCRIPT.replace("w: 10", "w: 12");
    let (s, v) = send(
        &r,
        "PUT",
        "/api/parts/cube/script",
        Some(json!({"source": new, "base_sha": sha})),
        h,
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let (s, _) = send(
        &r,
        "PUT",
        "/api/parts/cube/script",
        Some(json!({"source": SCRIPT, "base_sha": sha})),
        h,
    )
    .await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_eq!(std::fs::read_to_string(dir.path().join("cube.js")).unwrap(), new);

    let (s, v) = send(
        &r,
        "PATCH",
        "/api/parts/cube/scene",
        Some(json!({"material": "#3366cc", "params": {"w": 20}})),
        h,
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert!(v["rev"].is_u64(), "a params change queues a build: {v}");
    let (s, v) = send(
        &r,
        "PATCH",
        "/api/parts/cube/scene",
        Some(json!({"background": "blue"})),
        h,
    )
    .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "{v}");
    let saved: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("cube.studio.json")).unwrap()).unwrap();
    assert_eq!(saved["material"], "#3366cc");
    assert_eq!(saved["params"]["w"], 20);

    let (s, _) = send(&r, "GET", "/api/parts/nope", None, h).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _) = send(&r, "GET", "/api/parts/..%2Fetc", None, h).await;
    assert_ne!(s, StatusCode::OK);
    let (s, _) = send(&r, "GET", "/api/asset?path=../../etc/passwd", None, h).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

#[tokio::test(flavor = "multi_thread")]
async fn only_local_pages_may_call_the_api() {
    let dir = tempfile::tempdir().unwrap();
    let r = api::app(app(dir.path(), None), 7878);
    assert_eq!(
        send(&r, "GET", "/api/info", None, "localhost:7878").await.0,
        StatusCode::OK
    );
    assert_eq!(
        send(&r, "GET", "/api/info", None, "127.0.0.1:7878").await.0,
        StatusCode::OK
    );
    // DNS rebinding: a remote name resolving to 127.0.0.1.
    assert_eq!(
        send(&r, "GET", "/api/info", None, "evil.example:7878").await.0,
        StatusCode::FORBIDDEN
    );
    // Cross-site requests from a page elsewhere.
    let req = Request::builder()
        .method("PUT")
        .uri("/api/parts/cube/script")
        .header("host", "localhost:7878")
        .header("origin", "http://evil.example")
        .header("content-type", "application/json")
        .body(Body::from(json!({"source": "x"}).to_string()))
        .unwrap();
    assert_eq!(r.clone().oneshot(req).await.unwrap().status(), StatusCode::FORBIDDEN);
}

/// Streams chunks the way OpenAI-compatible servers do.
fn sse(chunks: &[Value]) -> String {
    chunks.iter().map(|c| format!("data: {c}\n\n")).collect::<String>() + "data: [DONE]\n\n"
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_runs_tools_and_feeds_results_back() {
    let bodies: Arc<Mutex<Vec<Value>>> = Arc::default();
    let seen = bodies.clone();
    let mock = axum::Router::new().route(
        "/chat/completions",
        post(move |axum::Json(body): axum::Json<Value>| {
            let seen = seen.clone();
            async move {
                let n = {
                    let mut b = seen.lock().unwrap();
                    b.push(body);
                    b.len()
                };
                let text = if n == 1 {
                    // Two tool calls, their arguments split across chunks.
                    sse(&[
                        json!({"choices": [{"delta": {"role": "assistant", "content": "On it."}}]}),
                        json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "type": "function",
                            "function": {"name": "update_scene", "arguments": "{\"patch\": {\"mate"}}]}}]}),
                        json!({"choices": [{"delta": {"tool_calls": [{"index": 0,
                            "function": {"arguments": "rial\": \"#ff0000\"}}"}}]}}]}),
                        json!({"choices": [{"delta": {"tool_calls": [{"index": 1, "id": "c2", "type": "function",
                            "function": {"name": "edit_script", "arguments": "{\"edits\": [{\"old_text\": \"w: 10\", \"new_text\": \"w: 25\"}]}"}}]}}]}),
                        json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}),
                    ])
                } else {
                    sse(&[json!({"choices": [{"delta": {"content": "Done: red, 25 mm."}}]})])
                };
                ([("content-type", "text/event-stream")], text)
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, mock).await.unwrap() });

    let dir = tempfile::tempdir().unwrap();
    let cfg = agent::Config {
        api_key: "test".into(),
        model: "mock".into(),
        base_url: format!("http://{addr}"),
        max_steps: 4,
    };
    let app = app(dir.path(), Some(cfg));
    let mut events = app.events.subscribe();
    let turn = agent::start(app.clone(), "cube", "make it red and 25 mm").unwrap();
    let done = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let e: Value = serde_json::from_str(&events.recv().await.unwrap()).unwrap();
            if e["type"] == "agent" && e["kind"] == "done" {
                return e;
            }
        }
    })
    .await
    .expect("turn finishes");
    assert_eq!(done["error"], Value::Null, "{done}");
    assert!(app.running_turn("cube").is_none());

    // The tools ran against the files.
    let scene: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("cube.studio.json")).unwrap()).unwrap();
    assert_eq!(scene["material"], "#ff0000");
    assert!(
        std::fs::read_to_string(dir.path().join("cube.js"))
            .unwrap()
            .contains("w: 25")
    );

    // The second request carried both tool results, matched to their calls.
    let bodies = bodies.lock().unwrap();
    assert_eq!(bodies.len(), 2);
    let msgs = bodies[1]["messages"].as_array().unwrap();
    assert_eq!(msgs[0]["role"], "system");
    assert!(msgs[1]["content"].as_str().unwrap().contains("<studio-context>"));
    let calls = msgs[2]["tool_calls"].as_array().unwrap();
    assert_eq!(
        calls[0]["function"]["arguments"],
        "{\"patch\": {\"material\": \"#ff0000\"}}"
    );
    assert_eq!(
        (msgs[3]["tool_call_id"].as_str(), msgs[4]["tool_call_id"].as_str()),
        (Some("c1"), Some("c2"))
    );
    // The build failed (no worker); the model is told why.
    let edit: Value = serde_json::from_str(msgs[4]["content"].as_str().unwrap()).unwrap();
    assert_eq!(edit["ok"], false);
    assert_eq!(edit["error"]["kind"], "worker");

    // History is stored and the turn can be reverted to its checkpoint.
    let turns = agent::load_turns(&app, "cube");
    assert_eq!(turns.len(), 1);
    assert!(turns[0].done && turns[0].messages.len() == 5);
    agent::revert(&app, "cube", &turn).unwrap();
    assert_eq!(std::fs::read_to_string(dir.path().join("cube.js")).unwrap(), SCRIPT);
    assert!(!dir.path().join("cube.studio.json").exists());
}
