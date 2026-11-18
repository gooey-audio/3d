//! The cad-worker process: locate, spawn, talk JSON lines, kill on overrun.
//!
//! One worker serves requests one at a time. A kernel operation can loop
//! forever inside WASM, so every wait has a deadline; on overrun the process
//! gets SIGKILL and the `Worker` refuses further requests (as after a trap or
//! crash). Protocol: `cad-worker/src/worker.ts`.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use crate::error::{CadError, ErrorKind};
use crate::scratch::TempDir;

/// Request/response shapes this host speaks (the worker's `PROTOCOL`).
pub const PROTOCOL: u64 = 1;
/// Environment variable naming the worker command.
pub const ENV: &str = "GOOEY_CAD_WORKER";
/// The worker's file name next to the `gooey-3d` executable.
pub const BINARY: &str = "gooey-cad-worker";
/// Time from spawn to the worker's `ready` line.
pub const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
/// Time for a worker to exit after its stdin closes before it is killed.
const EXIT_GRACE: Duration = Duration::from_secs(2);
/// Bytes of worker stderr kept for crash messages.
const STDERR_TAIL: usize = 4096;

pub const HOW_TO_BUILD: &str = "\
build the worker with `cad-worker/build.sh` (needs bun, https://bun.sh) and put
dist/gooey-cad-worker next to gooey-3d, or set GOOEY_CAD_WORKER to its path (or to
a command such as \"node /path/to/cad-worker/src/worker.ts\")";

/// How to start a worker: a program and its arguments (no shell).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkerCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
}

impl WorkerCommand {
    pub fn program(path: impl Into<PathBuf>) -> Self {
        WorkerCommand {
            program: path.into(),
            args: vec![],
        }
    }

    /// A command line with shell-style quoting: `node "/my dir/worker.ts"`.
    pub fn parse(line: &str) -> Result<Self, CadError> {
        let bad = || CadError::new(ErrorKind::Worker, format!("{ENV}: cannot parse {line:?}"));
        let mut words = split_words(line).ok_or_else(bad)?.into_iter();
        let program = words.next().ok_or_else(bad)?;
        Ok(WorkerCommand {
            program: program.into(),
            args: words.collect(),
        })
    }

    /// `$GOOEY_CAD_WORKER`, else `gooey-cad-worker` next to the running executable.
    pub fn locate() -> Result<Self, CadError> {
        if let Ok(line) = std::env::var(ENV)
            && !line.trim().is_empty()
        {
            return Self::parse(&line);
        }
        let exe = std::env::current_exe().map_err(|e| CadError::new(ErrorKind::Worker, e.to_string()))?;
        let sibling = exe
            .parent()
            .unwrap_or(Path::new("."))
            .join(format!("{BINARY}{}", std::env::consts::EXE_SUFFIX));
        if sibling.is_file() {
            return Ok(Self::program(sibling));
        }
        Err(CadError::new(
            ErrorKind::Worker,
            format!(
                "no CAD worker: {ENV} is not set and {} does not exist.\n{HOW_TO_BUILD}",
                sibling.display()
            ),
        ))
    }

    pub fn describe(&self) -> String {
        std::iter::once(self.program.display().to_string())
            .chain(self.args.iter().cloned())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// Splits on whitespace, honouring '...', "..." and backslash escapes.
fn split_words(s: &str) -> Option<Vec<String>> {
    let mut words = vec![];
    let mut cur: Option<String> = None;
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match c {
            c if c.is_whitespace() => words.extend(cur.take()),
            '\'' => {
                let w = cur.get_or_insert_with(String::new);
                loop {
                    match chars.next()? {
                        '\'' => break,
                        c => w.push(c),
                    }
                }
            }
            '"' => {
                let w = cur.get_or_insert_with(String::new);
                loop {
                    match chars.next()? {
                        '"' => break,
                        '\\' => w.push(chars.next()?),
                        c => w.push(c),
                    }
                }
            }
            '\\' => cur.get_or_insert_with(String::new).push(chars.next()?),
            c => cur.get_or_insert_with(String::new).push(c),
        }
    }
    words.extend(cur);
    Some(words)
}

enum Event {
    Line(String),
    Eof,
}

/// The worker's start-up line.
#[derive(Clone, Debug)]
pub struct Ready {
    pub protocol: u64,
    /// `{worker, replicad, opencascade, manifold, engine}`
    pub versions: Value,
    pub init_ms: f64,
}

/// A running worker. Dropping it ends the process (killing it if needed).
pub struct Worker {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<Event>,
    stderr: Arc<Mutex<Vec<u8>>>,
    stderr_thread: Option<JoinHandle<()>>,
    command: String,
    next_id: u64,
    /// Why the worker may not be used again (timeout, trap, crash).
    dead: Option<ErrorKind>,
    pub ready: Ready,
    /// Spawn to `ready`.
    pub startup_seconds: f64,
    /// Requests answered (the worker's count), and the OpenCascade heap after the
    /// last one: OCCT's heap never shrinks, so pools recycle on these.
    pub jobs: u64,
    pub heap_mb: f64,
    // Last: removed after the process is gone (field drop order).
    _scratch: TempDir,
}

impl Worker {
    /// Starts a worker and waits up to `startup` for its `ready` line.
    pub fn spawn(cmd: &WorkerCommand, startup: Duration) -> Result<Worker, CadError> {
        // The worker's TMPDIR (where it stages script copies), so a killed
        // worker leaves nothing behind.
        let scratch = TempDir::new_in(&std::env::temp_dir(), "gooey-cad-worker-")?;
        let start = Instant::now();
        let mut child = Command::new(&cmd.program)
            .args(&cmd.args)
            .env("TMPDIR", scratch.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                CadError::new(
                    ErrorKind::Worker,
                    format!("cannot start the CAD worker `{}`: {e}\n{HOW_TO_BUILD}", cmd.describe()),
                )
            })?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("piped stdout");
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(Event::Line(line)).is_err() {
                    return;
                }
            }
            let _ = tx.send(Event::Eof);
        });
        let stderr = Arc::new(Mutex::new(Vec::new()));
        let stderr_thread = child.stderr.take().map(|mut pipe| {
            let tail = stderr.clone();
            std::thread::spawn(move || {
                // Scripts' console output: pass it on, keep the tail for crash reports.
                let mut buf = [0u8; 4096];
                while let Ok(n) = pipe.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let _ = std::io::stderr().write_all(&buf[..n]);
                    let mut t = tail.lock().unwrap();
                    t.extend_from_slice(&buf[..n]);
                    let excess = t.len().saturating_sub(STDERR_TAIL);
                    t.drain(..excess);
                }
            })
        });
        let mut w = Worker {
            child,
            stdin,
            lines,
            stderr,
            stderr_thread,
            command: cmd.describe(),
            next_id: 1,
            dead: None,
            ready: Ready {
                protocol: 0,
                versions: Value::Null,
                init_ms: 0.0,
            },
            startup_seconds: 0.0,
            jobs: 0,
            heap_mb: 0.0,
            _scratch: scratch,
        };
        let deadline = start + startup;
        loop {
            match w.lines.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(Event::Line(line)) => {
                    let msg: Value = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(_) => {
                            eprintln!("{line}");
                            continue;
                        }
                    };
                    if msg.get("ready") != Some(&Value::Bool(true)) {
                        eprintln!("{line}");
                        continue;
                    }
                    let protocol = msg.get("protocol").and_then(Value::as_u64).unwrap_or(0);
                    if protocol != PROTOCOL {
                        w.kill(ErrorKind::Worker);
                        return Err(CadError::new(
                            ErrorKind::Worker,
                            format!(
                                "the CAD worker `{}` speaks protocol {protocol}, this gooey-3d speaks {PROTOCOL}: rebuild it from this checkout's cad-worker/",
                                w.command
                            ),
                        ));
                    }
                    w.ready = Ready {
                        protocol,
                        versions: msg.get("versions").cloned().unwrap_or(Value::Null),
                        init_ms: msg.get("initMs").and_then(Value::as_f64).unwrap_or(0.0),
                    };
                    w.startup_seconds = start.elapsed().as_secs_f64();
                    return Ok(w);
                }
                Ok(Event::Eof) | Err(RecvTimeoutError::Disconnected) => {
                    return Err(w.crashed("during start-up"));
                }
                Err(RecvTimeoutError::Timeout) => {
                    w.kill(ErrorKind::Timeout);
                    return Err(CadError::new(
                        ErrorKind::Timeout,
                        format!(
                            "the CAD worker `{}` was not ready after {} s and was killed",
                            w.command,
                            startup.as_secs_f64()
                        ),
                    ));
                }
            }
        }
    }

    /// False after a timeout, trap or crash: start a new worker.
    pub fn usable(&self) -> bool {
        self.dead.is_none()
    }

    /// Sends one request (an `op` object; the id is added here) and waits up to
    /// `timeout` for its response. `ok:false` responses become `Err`.
    pub fn request(&mut self, mut req: Map<String, Value>, timeout: Duration) -> Result<Map<String, Value>, CadError> {
        if let Some(why) = self.dead {
            return Err(CadError::new(
                ErrorKind::Worker,
                format!("this worker is unusable after a {why}; start a new one"),
            ));
        }
        let id = self.next_id;
        self.next_id += 1;
        req.insert("id".into(), id.into());
        let line = serde_json::to_string(&req).expect("JSON request") + "\n";
        let sent = match self.stdin.as_mut() {
            Some(stdin) => stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush()).is_ok(),
            None => false,
        };
        if !sent {
            return Err(self.crashed("before reading the request"));
        }
        let deadline = Instant::now() + timeout;
        loop {
            match self
                .lines
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                Ok(Event::Line(line)) => {
                    let Ok(Value::Object(msg)) = serde_json::from_str::<Value>(&line) else {
                        eprintln!("{line}"); // a script wrote to stdout directly
                        continue;
                    };
                    if msg.get("id").and_then(Value::as_u64) != Some(id) {
                        eprintln!("{line}");
                        continue;
                    }
                    if let Some(n) = msg.get("jobs").and_then(Value::as_u64) {
                        self.jobs = n;
                    }
                    if let Some(h) = msg.get("heapMB").and_then(Value::as_f64) {
                        self.heap_mb = h;
                    }
                    if msg.get("ok") == Some(&Value::Bool(true)) {
                        return Ok(msg);
                    }
                    let err = CadError::from_worker(msg.get("error"));
                    if err.kind == ErrorKind::Trap {
                        // The worker exits after a trap; make sure of it.
                        self.kill(ErrorKind::Trap);
                    }
                    return Err(err);
                }
                Ok(Event::Eof) | Err(RecvTimeoutError::Disconnected) => {
                    return Err(self.crashed("before answering"));
                }
                Err(RecvTimeoutError::Timeout) => {
                    self.kill(ErrorKind::Timeout);
                    return Err(CadError::new(
                        ErrorKind::Timeout,
                        format!(
                            "no result after {} s; the worker was killed (raise --timeout if the part is only slow)",
                            timeout.as_secs_f64()
                        ),
                    ));
                }
            }
        }
    }

    /// Closes stdin and waits briefly for a clean exit, then kills.
    pub fn shutdown(mut self) {
        self.finish();
    }

    fn finish(&mut self) {
        self.stdin = None;
        if self.dead.is_none() && self.wait_exit(EXIT_GRACE).is_some() {
            return;
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    fn kill(&mut self, why: ErrorKind) {
        self.dead = Some(why);
        self.stdin = None;
        let _ = self.child.kill(); // SIGKILL on Unix
        let _ = self.child.wait();
    }

    fn wait_exit(&mut self, grace: Duration) -> Option<std::process::ExitStatus> {
        let until = Instant::now() + grace;
        loop {
            if let Ok(Some(status)) = self.child.try_wait() {
                return Some(status);
            }
            if Instant::now() >= until {
                return None;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// The process closed stdout: collect its exit status and stderr tail.
    fn crashed(&mut self, when: &str) -> CadError {
        let status = self.wait_exit(Duration::from_secs(1));
        self.kill(ErrorKind::Crash);
        // Let the stderr reader drain what the process wrote last.
        if let Some(t) = &self.stderr_thread {
            let until = Instant::now() + Duration::from_millis(300);
            while !t.is_finished() && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        let tail = String::from_utf8_lossy(&self.stderr.lock().unwrap()).trim().to_string();
        let status = match status {
            Some(s) => s.to_string(),
            None => "still running; killed".into(),
        };
        let mut msg = format!("the CAD worker `{}` died {when} ({status})", self.command);
        if !tail.is_empty() {
            msg.push_str(":\n");
            msg.push_str(&tail);
        }
        CadError::new(ErrorKind::Crash, msg)
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.finish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_words_quotes() {
        assert_eq!(split_words("node /a/worker.ts").unwrap(), ["node", "/a/worker.ts"]);
        assert_eq!(
            split_words(r#"  node "/my dir/w.ts" 'x y' a\ b "#).unwrap(),
            ["node", "/my dir/w.ts", "x y", "a b"]
        );
        assert_eq!(split_words("''").unwrap(), [""]);
        assert!(split_words("node \"unterminated").is_none());
        let c = WorkerCommand::parse("bun run w.ts").unwrap();
        assert_eq!(c.program, PathBuf::from("bun"));
        assert_eq!(c.args, ["run", "w.ts"]);
        assert!(WorkerCommand::parse("   ").is_err());
    }
}
