//! One OS thread that owns a warm cad-worker and builds parts one at a time.
//!
//! Requests are keyed by part (and STEP exports separately), so a burst of edits to
//! one part collapses into a build of the newest: an older queued request is
//! replaced, never run. The worker is spawned on first use and replaced after a
//! timeout, trap or crash, or when it has served many jobs or grown its heap
//! (OpenCascade's heap never shrinks).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use gooey_cad::{CadError, ErrorKind, Options, Report, Worker, WorkerCommand};
use serde_json::{Map, Value};

/// Recycle the worker after this many jobs or this much OpenCascade heap.
const MAX_JOBS: u64 = 300;
const MAX_HEAP_MB: f64 = 2048.0;
pub const BUILD_TIMEOUT: Duration = Duration::from_secs(30);
const PARAMS_TIMEOUT: Duration = Duration::from_secs(10);

pub struct Request {
    pub part: String,
    pub script: PathBuf,
    pub rev: u64,
    /// Parameter overrides.
    pub params: Map<String, Value>,
    /// Where the mesh (and STEP) go; created if missing.
    pub out: PathBuf,
    pub step: bool,
    /// Where the outcome goes; `None` = the builder's callback.
    pub reply: Option<tokio::sync::oneshot::Sender<Outcome>>,
}

pub struct Outcome {
    pub result: Result<Report, CadError>,
    /// `{defaultParams, paramRanges}` when the script loads.
    pub info: Option<Value>,
    pub seconds: f64,
}

#[derive(Default)]
struct Queue {
    pending: BTreeMap<String, Request>,
    /// Keys in arrival order (first come, first built; a replaced request keeps its slot).
    order: Vec<String>,
}

#[derive(Clone)]
pub struct Handle {
    inner: Arc<(Mutex<Queue>, Condvar)>,
}

impl Handle {
    pub fn enqueue(&self, req: Request) {
        let key = if req.step {
            format!("{}#step", req.part)
        } else {
            req.part.clone()
        };
        let (lock, cv) = &*self.inner;
        let mut q = lock.lock().unwrap();
        if !q.pending.contains_key(&key) {
            q.order.push(key.clone());
        }
        if let Some(old) = q.pending.insert(key, req)
            && let Some(tx) = old.reply
        {
            let _ = tx.send(Outcome {
                result: Err(CadError::new(ErrorKind::Io, "superseded by a newer request")),
                info: None,
                seconds: 0.0,
            });
        }
        cv.notify_one();
    }
}

pub fn spawn(worker: Option<WorkerCommand>, on_result: impl Fn(Request, Outcome) + Send + 'static) -> Handle {
    let handle = Handle {
        inner: Arc::new((Mutex::new(Queue::default()), Condvar::new())),
    };
    let inner = handle.inner.clone();
    std::thread::Builder::new()
        .name("cad-builder".into())
        .spawn(move || {
            let mut w: Option<Worker> = None;
            loop {
                let mut req = {
                    let (lock, cv) = &*inner;
                    let mut q = cv.wait_while(lock.lock().unwrap(), |q| q.order.is_empty()).unwrap();
                    let key = q.order.remove(0);
                    q.pending.remove(&key).expect("queued key")
                };
                let outcome = build(&mut w, worker.as_ref(), &req);
                match req.reply.take() {
                    Some(tx) => {
                        let _ = tx.send(outcome);
                    }
                    None => on_result(req, outcome),
                }
            }
        })
        .expect("spawn builder thread");
    handle
}

fn build(slot: &mut Option<Worker>, cmd: Option<&WorkerCommand>, req: &Request) -> Outcome {
    let start = Instant::now();
    let done = |result, info| Outcome {
        result,
        info,
        seconds: start.elapsed().as_secs_f64(),
    };
    if slot
        .as_ref()
        .is_some_and(|w| !w.usable() || w.jobs >= MAX_JOBS || w.heap_mb >= MAX_HEAP_MB)
        && let Some(w) = slot.take()
    {
        w.shutdown();
    }
    if slot.is_none() {
        let Some(cmd) = cmd else {
            return done(
                Err(CadError::new(
                    ErrorKind::Worker,
                    format!(
                        "no CAD worker: set GOOEY_CAD_WORKER or {}",
                        gooey_cad::worker::HOW_TO_BUILD
                    ),
                )),
                None,
            );
        };
        match Worker::spawn(cmd, gooey_cad::STARTUP_TIMEOUT) {
            Ok(w) => *slot = Some(w),
            Err(e) => return done(Err(e), None),
        }
    }
    let w = slot.as_mut().unwrap();
    if let Err(e) = std::fs::create_dir_all(&req.out) {
        return done(
            Err(CadError::new(ErrorKind::Io, format!("{}: {e}", req.out.display()))),
            None,
        );
    }
    let opts = Options {
        params: req.params.clone(),
        step: req.step,
        timeout: BUILD_TIMEOUT,
        ..Options::default()
    };
    let result = gooey_cad::build_with(w, &req.script, &opts, &req.out);
    // The params op only loads the script: cheap, and it still answers when `main` fails.
    let info = if w.usable() {
        let mut q = Map::new();
        q.insert("op".into(), "params".into());
        q.insert("script".into(), req.script.to_string_lossy().into_owned().into());
        w.request(q, PARAMS_TIMEOUT).ok().map(|r| {
            serde_json::json!({
                "defaultParams": r.get("defaultParams").cloned().unwrap_or_default(),
                "paramRanges": r.get("paramRanges").cloned().unwrap_or_default(),
            })
        })
    } else {
        None
    };
    done(result, info)
}
