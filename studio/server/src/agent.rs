//! The embedded agent: DeepSeek's OpenAI-compatible chat completions with tools,
//! streamed. Tools edit the part script and its scene through the same paths as the
//! browser, so every edit rebuilds and shows up live; script tools wait for their
//! build and hand the model the result (or the error at its line) to act on.
//!
//! One turn per part at a time. Before a turn the script and scene are checkpointed
//! under `.studio/history/<part>/<turn>.*` so the turn can be reverted. The
//! conversation is kept in `.studio/chat/<part>.json`.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::{App, AppError, sha256_hex};

const CAD_SKILL: &str = include_str!("../../../engine/skill/cad/SKILL.md");
const BUILD_WAIT: Duration = Duration::from_secs(90);
/// Earlier turns sent with each request.
const HISTORY_TURNS: usize = 12;

#[derive(Clone, Debug)]
pub struct Config {
    pub api_key: String,
    pub model: String,
    /// Without the trailing `/chat/completions`.
    pub base_url: String,
    pub max_steps: usize,
}

impl Config {
    /// `DEEPSEEK_API_KEY` (required), `DEEPSEEK_MODEL` (default `deepseek-chat`),
    /// `DEEPSEEK_BASE_URL` (default `https://api.deepseek.com`) and `DEEPSEEK_MAX_STEPS`
    /// (model calls per turn, default 32).
    pub fn from_env() -> Option<Config> {
        let key = std::env::var("DEEPSEEK_API_KEY")
            .ok()
            .filter(|k| !k.trim().is_empty())?;
        let var = |k: &str, d: &str| std::env::var(k).ok().filter(|v| !v.is_empty()).unwrap_or(d.into());
        Some(Config {
            api_key: key.trim().into(),
            model: var("DEEPSEEK_MODEL", "deepseek-chat"),
            base_url: var("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
                .trim_end_matches('/')
                .into(),
            max_steps: var("DEEPSEEK_MAX_STEPS", "32").parse().unwrap_or(32),
        })
    }
}

/// One user request and everything the model and tools said in answer, as API messages.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Turn {
    pub id: String,
    /// The user's words (the first message also carries the studio context).
    pub user: String,
    pub messages: Vec<Value>,
    #[serde(default)]
    pub done: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Script sha before the turn (the checkpoint).
    #[serde(default)]
    pub checkpoint_sha: String,
}

fn chat_path(app: &App, part: &str) -> PathBuf {
    app.data.join("chat").join(format!("{part}.json"))
}

fn history_dir(app: &App, part: &str) -> PathBuf {
    app.data.join("history").join(part)
}

pub fn load_turns(app: &App, part: &str) -> Vec<Turn> {
    std::fs::read_to_string(chat_path(app, part))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_turns(app: &App, part: &str, turns: &[Turn]) {
    let p = chat_path(app, part);
    let _ = std::fs::create_dir_all(p.parent().unwrap());
    let _ = crate::write_atomic(&p, serde_json::to_string_pretty(turns).unwrap().as_bytes());
}

pub fn clear(app: &App, part: &str) -> Result<(), AppError> {
    if app.running_turn(part).is_some() {
        return Err(AppError("a turn is running".into()));
    }
    let _ = std::fs::remove_file(chat_path(app, part));
    Ok(())
}

/// Starts a turn in the background; progress arrives as `agent` events.
pub fn start(app: Arc<App>, part: &str, text: &str) -> Result<String, AppError> {
    let cfg = app
        .agent
        .clone()
        .ok_or_else(|| AppError("the agent is off: set DEEPSEEK_API_KEY and restart gooey-studio".into()))?;
    app.check_part(part)?;
    let id = format!(
        "t{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis()
    );
    let token = CancellationToken::new();
    {
        let mut turns = app.turns.lock().unwrap();
        if turns.contains_key(part) {
            return Err(AppError("a turn is already running for this part".into()));
        }
        turns.insert(part.to_owned(), (id.clone(), token.clone()));
    }
    // Checkpoint before anything changes.
    let script = app.read_script(part)?;
    let hist = history_dir(&app, part);
    std::fs::create_dir_all(&hist)?;
    std::fs::write(hist.join(format!("{id}.js")), &script)?;
    if let Ok(scene) = std::fs::read(app.scene_path(part)) {
        std::fs::write(hist.join(format!("{id}.studio.json")), scene)?;
    }
    let (part, text, tid) = (part.to_owned(), text.to_owned(), id.clone());
    tokio::spawn(async move {
        let sha = sha256_hex(script.as_bytes());
        let result = run(&app, &cfg, &part, &tid, &text, &sha, &token).await;
        app.turns.lock().unwrap().remove(&part);
        let mut turns = load_turns(&app, &part);
        if let Some(t) = turns.iter_mut().find(|t| t.id == tid) {
            t.done = true;
            t.error = result.as_ref().err().map(|e| e.0.clone());
            save_turns(&app, &part, &turns);
        }
        app.emit(json!({"type": "agent", "part": part, "turn": tid, "kind": "done",
                        "error": result.err().map(|e| e.0)}));
    });
    Ok(id)
}

pub fn stop(app: &App, part: &str) -> bool {
    match app.turns.lock().unwrap().get(part) {
        Some((_, token)) => {
            token.cancel();
            true
        }
        None => false,
    }
}

/// Restores the script and scene from before turn `turn`.
pub fn revert(app: &App, part: &str, turn: &str) -> Result<(), AppError> {
    app.check_part(part)?;
    if !turn.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(AppError("bad turn id".into()));
    }
    if app.running_turn(part).is_some() {
        return Err(AppError("stop the running turn first".into()));
    }
    let hist = history_dir(app, part);
    let script = std::fs::read_to_string(hist.join(format!("{turn}.js")))
        .map_err(|_| AppError(format!("no checkpoint for turn {turn}")))?;
    match std::fs::read(hist.join(format!("{turn}.studio.json"))) {
        Ok(scene) => crate::write_atomic(&app.scene_path(part), &scene)?,
        Err(_) => {
            let _ = std::fs::remove_file(app.scene_path(part));
        }
    }
    if let Ok(s) = app.load_scene(part) {
        app.emit_scene(part, &s);
    }
    app.write_script(part, &script)?;
    Ok(())
}

fn system_prompt(app: &App, part: &str) -> String {
    let finishes = if app.library.entries.is_empty() {
        "none loaded; use colours and look overrides".to_owned()
    } else {
        app.library
            .entries
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join(", ")
    };
    format!(
        "You are the CAD assistant inside gooey-studio, a live editor for one parametric part: \
`{part}.js`, a Replicad script. The user sees the script in an editor and the built part in a \
three.js preview, both updating as soon as you change anything.

How to work:
- Change the part by editing the program (edit_script for targeted changes, write_script for \
rewrites), never by describing a mesh. Keep the script's conventions: `defaultParams`, \
`paramRanges`, optional `expect`, and `main(replicad, params)` returning one solid. Expose \
meaningful dimensions as parameters.
- Every script or parameter change rebuilds and validates the part and returns the result. If a \
build fails, read the error kind, message and line, fix the cause, and try again. Do not stop on a \
failed build unless you explain why you cannot fix it.
- Units are millimetres. The part frame is Z up (CAD convention); it is shown resting on a ground \
plane.
- Use set_params to change parameter values; use edit_script to change defaults, ranges or the \
geometry itself.
- Change the look with update_scene (a JSON merge patch over the scene document). The scene's \
`material` is a finish name from the library ({finishes}), a colour `#rrggbb`, or an object such \
as {{\"color\": \"#c0c4c8\", \"metalness\": 1, \"roughness\": 0.25}} or \
{{\"finish\": \"wood/walnut\", \"clearcoat\": 0.5}} (look keys: roughness, metalness, clearcoat, \
clearcoat_roughness, transmission, ior, opacity, sheen; all 0..1 except ior 1..3). `environment` \
is {{\"type\": \"studio\", \"intensity\": 1, \"rotation_deg\": 0}} (softbox key, fill and rim \
lights, turned about the vertical axis) or {{\"type\": \"hdri\", \"path\": \"file.hdr\", \
\"intensity\": 1, \"rotation_deg\": 0}}. `background` is `#rrggbb` or `transparent`; `exposure` > \
0; `camera` is {{\"view\": \"iso\"|\"front\"|\"side\"|\"top\"|\"rear\"|\"rear-iso\"|[x,y,z], \"fov\": \
degrees}} (Y up in view space).
- Be brief. After changes, summarise what you did in one or two sentences with the key numbers \
(size, holes/genus, printability issues).

Reference: the gooey-3d cad skill (the CLI parts do not apply here; the tools replace them).

{CAD_SKILL}"
    )
}

fn context(app: &App, part: &str) -> String {
    let script = app.read_script(part).unwrap_or_default();
    let scene = app.load_scene(part).map(|s| json!(s)).unwrap_or_default();
    let build = app.latest(part).map(|b| b.summary()).unwrap_or(json!(null));
    format!(
        "<studio-context>\nPart: {part}.js\nCurrent script:\n{}\nScene: {scene}\nLast build: {build}\n</studio-context>",
        numbered(&script)
    )
}

fn numbered(src: &str) -> String {
    src.lines()
        .enumerate()
        .map(|(i, l)| format!("{:>4}| {l}", i + 1))
        .collect::<Vec<_>>()
        .join("\n")
}

fn tools() -> Value {
    let f = |name: &str, desc: &str, params: Value| json!({"type": "function", "function": {"name": name, "description": desc, "parameters": params}});
    let none = json!({"type": "object", "properties": {}});
    json!([
        f(
            "read_script",
            "Read the current part script, with line numbers.",
            none.clone()
        ),
        f(
            "edit_script",
            "Apply exact text replacements to the script, then rebuild. Each old_text must occur exactly once in the current script (include enough context). Returns the build result.",
            json!({"type": "object", "properties": {"edits": {"type": "array", "items": {
              "type": "object", "properties": {
                  "old_text": {"type": "string"}, "new_text": {"type": "string"}},
              "required": ["old_text", "new_text"]}}}, "required": ["edits"]})
        ),
        f(
            "write_script",
            "Replace the whole script, then rebuild. Returns the build result.",
            json!({"type": "object", "properties": {"source": {"type": "string"}}, "required": ["source"]})
        ),
        f(
            "set_params",
            "Override parameter values (null resets one to its default), then rebuild. Returns the build result.",
            json!({"type": "object", "properties": {"values": {"type": "object"}}, "required": ["values"]})
        ),
        f(
            "get_report",
            "The last build's full validation report (without the face table), or its error.",
            none.clone()
        ),
        f(
            "get_scene",
            "The scene document (params, material, environment, background, exposure, camera) and the resolved material.",
            none.clone()
        ),
        f(
            "update_scene",
            "Apply a JSON merge patch to the scene document (null deletes a key). Returns the new scene or a validation error.",
            json!({"type": "object", "properties": {"patch": {"type": "object"}}, "required": ["patch"]})
        ),
        f("list_finishes", "The finish library: names and labels.", none),
    ])
}

/// Runs one tool call; the result goes back to the model as JSON.
pub async fn call_tool(app: &App, part: &str, name: &str, args: &Value) -> Value {
    match tool(app, part, name, args).await {
        Ok(v) => v,
        Err(e) => json!({"ok": false, "error": e.0}),
    }
}

async fn tool(app: &App, part: &str, name: &str, args: &Value) -> Result<Value, AppError> {
    let s = |k: &str| args.get(k).and_then(Value::as_str);
    match name {
        "read_script" => Ok(json!({"script": numbered(&app.read_script(part)?)})),
        "write_script" => {
            let src = s("source").ok_or_else(|| AppError("write_script needs `source`".into()))?;
            let rev = app.write_script(part, src)?;
            Ok(build_result(app, part, rev).await)
        }
        "edit_script" => {
            let edits = args
                .get("edits")
                .and_then(Value::as_array)
                .ok_or_else(|| AppError("edit_script needs `edits`".into()))?;
            let mut src = app.read_script(part)?;
            for (i, e) in edits.iter().enumerate() {
                let old = e.get("old_text").and_then(Value::as_str).unwrap_or_default();
                let new = e.get("new_text").and_then(Value::as_str).unwrap_or_default();
                match src.matches(old).count() {
                    _ if old.is_empty() => return Err(AppError(format!("edit {i}: empty old_text"))),
                    1 => src = src.replacen(old, new, 1),
                    0 => {
                        return Err(AppError(format!(
                            "edit {i}: old_text not found; nothing was changed. Read the script and retry."
                        )));
                    }
                    n => {
                        return Err(AppError(format!(
                            "edit {i}: old_text occurs {n} times; add context. Nothing was changed."
                        )));
                    }
                }
            }
            let rev = app.write_script(part, &src)?;
            Ok(build_result(app, part, rev).await)
        }
        "set_params" => {
            let values = args
                .get("values")
                .filter(|v| v.is_object())
                .ok_or_else(|| AppError("set_params needs an object `values`".into()))?;
            let (_, rev) = app.patch_scene(part, &json!({"params": values}))?;
            Ok(build_result(app, part, rev).await)
        }
        "get_report" => match app.latest(part) {
            Some(b) => {
                let mut v = json!(*b);
                if let Some(r) = v.get_mut("report") {
                    r.as_object_mut().unwrap().remove("faces");
                }
                Ok(v)
            }
            None => Ok(json!({"ok": false, "error": "not built yet"})),
        },
        "get_scene" => {
            let sc = app.load_scene(part)?;
            Ok(json!({"scene": sc, "resolved": sc.resolve(&app.library)?}))
        }
        "update_scene" => {
            let patch = args
                .get("patch")
                .ok_or_else(|| AppError("update_scene needs `patch`".into()))?;
            let (sc, rev) = app.patch_scene(part, patch)?;
            let mut out = json!({"ok": true, "scene": sc});
            if rev.is_some() {
                out["build"] = build_result(app, part, rev).await;
            }
            Ok(out)
        }
        "list_finishes" => Ok(json!(
            app.library
                .entries
                .iter()
                .map(|(n, e)| json!({"name": n, "label": e.label}))
                .collect::<Vec<_>>()
        )),
        other => Err(AppError(format!("unknown tool `{other}`"))),
    }
}

/// Waits for build `rev` (or reports the current one when nothing changed) and makes
/// it useful to the model: on an error, the script lines around it.
async fn build_result(app: &App, part: &str, rev: Option<u64>) -> Value {
    let res = match rev {
        Some(rev) => app.wait_build(part, rev, BUILD_WAIT).await,
        None => app.latest(part),
    };
    let Some(res) = res else {
        return json!({"ok": false, "error": "the build did not finish in time"});
    };
    let mut v = res.summary();
    if rev.is_none() {
        v["note"] = "nothing changed; this is the current build".into();
    }
    if let Some(line) = res.error.as_ref().and_then(|e| e.line) {
        let src = app.read_script(part).unwrap_or_default();
        let lo = line.saturating_sub(4) as usize;
        let ctx: Vec<String> = src
            .lines()
            .enumerate()
            .skip(lo)
            .take(7)
            .map(|(i, l)| format!("{}{:>4}| {l}", if i + 1 == line as usize { ">" } else { " " }, i + 1))
            .collect();
        v["source_context"] = ctx.join("\n").into();
    }
    v
}

#[derive(Default)]
struct Call {
    id: String,
    name: String,
    args: String,
}

async fn run(
    app: &Arc<App>,
    cfg: &Config,
    part: &str,
    tid: &str,
    text: &str,
    checkpoint_sha: &str,
    token: &CancellationToken,
) -> Result<(), AppError> {
    let mut turns = load_turns(app, part);
    let first = json!({"role": "user", "content": format!("{}\n\n{text}", context(app, part))});
    turns.push(Turn {
        id: tid.into(),
        user: text.into(),
        messages: vec![first],
        done: false,
        error: None,
        checkpoint_sha: checkpoint_sha.into(),
    });
    save_turns(app, part, &turns);
    app.emit(json!({"type": "agent", "part": part, "turn": tid, "kind": "start", "user": text}));

    // Earlier turns: the user's words without the context block, no reasoning text.
    let mut prior = vec![json!({"role": "system", "content": system_prompt(app, part)})];
    let earlier = &turns[..turns.len() - 1];
    for t in earlier.iter().skip(earlier.len().saturating_sub(HISTORY_TURNS)) {
        for (i, m) in t.messages.iter().enumerate() {
            let mut m = m.clone();
            if i == 0 {
                m["content"] = t.user.clone().into();
            }
            if let Some(o) = m.as_object_mut() {
                o.remove("reasoning_content");
            }
            prior.push(m);
        }
        // An interrupted turn can end on unanswered tool calls; the API rejects that.
        if let Some(last) = prior.last()
            && last.get("tool_calls").is_some()
        {
            prior.pop();
        }
    }

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()?;
    for _ in 0..cfg.max_steps {
        let messages: Vec<Value> = prior
            .iter()
            .chain(turns.last().unwrap().messages.iter())
            .cloned()
            .collect();
        let body = json!({"model": cfg.model, "messages": messages, "tools": tools(), "stream": true});
        let (msg, calls) = tokio::select! {
            r = stream_step(&client, cfg, &body, app, part, tid) => r?,
            _ = token.cancelled() => return Err(AppError("stopped".into())),
        };
        turns.last_mut().unwrap().messages.push(msg);
        save_turns(app, part, &turns);
        if calls.is_empty() {
            return Ok(());
        }
        for c in calls {
            let args: Value = serde_json::from_str(if c.args.trim().is_empty() { "{}" } else { &c.args })
                .unwrap_or_else(|e| json!({"__invalid": e.to_string()}));
            app.emit(json!({"type": "agent", "part": part, "turn": tid, "kind": "tool_call",
                            "id": c.id, "name": c.name, "args": args}));
            let result = if let Some(e) = args.get("__invalid") {
                json!({"ok": false, "error": format!("arguments are not valid JSON: {e}")})
            } else {
                tokio::select! {
                    r = call_tool(app, part, &c.name, &args) => r,
                    _ = token.cancelled() => json!({"ok": false, "error": "stopped by the user"}),
                }
            };
            app.emit(
                json!({"type": "agent", "part": part, "turn": tid, "kind": "tool_result",
                            "id": c.id, "name": c.name, "result": result}),
            );
            turns.last_mut().unwrap().messages.push(json!({
                "role": "tool", "tool_call_id": c.id, "content": result.to_string()}));
            save_turns(app, part, &turns);
        }
        if token.is_cancelled() {
            return Err(AppError("stopped".into()));
        }
    }
    Err(AppError(format!("stopped after {} steps", cfg.max_steps)))
}

/// One streamed completion: relays text as it arrives and returns the assistant
/// message (for the history) and its tool calls.
async fn stream_step(
    client: &reqwest::Client,
    cfg: &Config,
    body: &Value,
    app: &App,
    part: &str,
    tid: &str,
) -> Result<(Value, Vec<Call>), AppError> {
    let resp = client
        .post(format!("{}/chat/completions", cfg.base_url))
        .bearer_auth(&cfg.api_key)
        .json(body)
        .send()
        .await
        .map_err(|e| AppError(format!("DeepSeek request failed: {e}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError(format!(
            "DeepSeek {status}: {}",
            text.chars().take(500).collect::<String>()
        )));
    }
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut calls: Vec<Call> = vec![];
    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    let idle = Duration::from_secs(120);
    'outer: loop {
        let chunk = match tokio::time::timeout(idle, stream.next()).await {
            Err(_) => return Err(AppError("DeepSeek stream stalled".into())),
            Ok(None) => break,
            Ok(Some(c)) => c.map_err(|e| AppError(format!("DeepSeek stream: {e}")))?,
        };
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(nl) = buf.find('\n') {
            let line: String = buf.drain(..=nl).collect();
            let Some(data) = line.trim().strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data == "[DONE]" {
                break 'outer;
            }
            let Ok(ev) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            let delta = &ev["choices"][0]["delta"];
            if let Some(t) = delta["reasoning_content"].as_str().filter(|t| !t.is_empty()) {
                reasoning.push_str(t);
                app.emit(json!({"type": "agent", "part": part, "turn": tid, "kind": "reasoning", "text": t}));
            }
            if let Some(t) = delta["content"].as_str().filter(|t| !t.is_empty()) {
                content.push_str(t);
                app.emit(json!({"type": "agent", "part": part, "turn": tid, "kind": "delta", "text": t}));
            }
            for tc in delta["tool_calls"].as_array().into_iter().flatten() {
                let i = tc["index"].as_u64().unwrap_or(calls.len() as u64) as usize;
                while calls.len() <= i {
                    calls.push(Call::default());
                }
                let c = &mut calls[i];
                if let Some(id) = tc["id"].as_str() {
                    c.id = id.into();
                }
                if let Some(n) = tc["function"]["name"].as_str() {
                    c.name.push_str(n);
                }
                if let Some(a) = tc["function"]["arguments"].as_str() {
                    c.args.push_str(a);
                }
            }
        }
    }
    calls.retain(|c| !c.name.is_empty());
    for (i, c) in calls.iter_mut().enumerate() {
        if c.id.is_empty() {
            c.id = format!("call_{i}");
        }
    }
    let mut msg = Map::new();
    msg.insert("role".into(), "assistant".into());
    msg.insert("content".into(), content.into());
    if !reasoning.is_empty() {
        msg.insert("reasoning_content".into(), reasoning.into());
    }
    if !calls.is_empty() {
        msg.insert(
            "tool_calls".into(),
            calls
                .iter()
                .map(|c| json!({"id": c.id, "type": "function", "function": {"name": c.name, "arguments": c.args}}))
                .collect(),
        );
    }
    Ok((Value::Object(msg), calls))
}
