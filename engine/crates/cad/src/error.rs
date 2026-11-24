//! Errors from a part build, as `{kind, message, line, column}`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What went wrong. [`ErrorKind::exit_code`] maps kinds to `gooey-3d cad` exit codes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ErrorKind {
    /// The script threw, could not be read, or broke a script convention.
    Script,
    /// The script does not parse.
    Syntax,
    /// Unknown, mistyped, non-finite or out-of-range parameters.
    Params,
    /// An OpenCascade operation failed (e.g. a fillet too large for its faces).
    Kernel,
    /// Too many B-rep faces or triangles.
    Limits,
    /// The solid is broken: BRepCheck failed, the mesh is open, or Manifold rejects it.
    Invalid,
    /// The script's `expect` (pieces, genus) does not match the result.
    Expect,
    /// Two assembly parts occupy the same space.
    Interference,
    /// Reading the script or writing outputs failed.
    Io,
    /// The worker did not start or answer in time and was killed.
    Timeout,
    /// The kernel trapped (WASM runtime error); the worker exits after answering.
    Trap,
    /// The worker died without answering.
    Crash,
    /// No worker found, it cannot be started, or it speaks another protocol.
    Worker,
    /// The worker sent something the host does not understand (or vice versa).
    Protocol,
}

impl ErrorKind {
    /// 2 for problems with the script or its inputs, 3 for timeouts, 4 for the worker.
    pub fn exit_code(self) -> u8 {
        match self {
            ErrorKind::Timeout => 3,
            ErrorKind::Trap | ErrorKind::Crash | ErrorKind::Worker | ErrorKind::Protocol => 4,
            _ => 2,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ErrorKind::Script => "script",
            ErrorKind::Syntax => "syntax",
            ErrorKind::Params => "params",
            ErrorKind::Kernel => "kernel",
            ErrorKind::Limits => "limits",
            ErrorKind::Invalid => "invalid",
            ErrorKind::Expect => "expect",
            ErrorKind::Interference => "interference",
            ErrorKind::Io => "io",
            ErrorKind::Timeout => "timeout",
            ErrorKind::Trap => "trap",
            ErrorKind::Crash => "crash",
            ErrorKind::Worker => "worker",
            ErrorKind::Protocol => "protocol",
        }
    }
}

impl std::fmt::Display for ErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A build failure. `line`/`column` (1-based) point into the part script when known.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CadError {
    pub kind: ErrorKind,
    pub message: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
    /// Source file when available, including imported modules.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    /// The JavaScript stack, when the worker sent one; not serialized.
    #[serde(skip)]
    pub stack: Option<String>,
}

impl CadError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        CadError {
            kind,
            message: message.into(),
            line: None,
            column: None,
            file: None,
            stack: None,
        }
    }

    pub fn exit_code(&self) -> u8 {
        self.kind.exit_code()
    }

    /// From the worker's `error` object. Unknown kinds are protocol errors.
    pub(crate) fn from_worker(v: Option<&Value>) -> Self {
        let Some(v) = v else {
            return CadError::new(ErrorKind::Protocol, "worker reported failure without an `error`");
        };
        let kind = match v.get("kind").and_then(Value::as_str).unwrap_or("") {
            "script" => ErrorKind::Script,
            "syntax" => ErrorKind::Syntax,
            "params" => ErrorKind::Params,
            "kernel" => ErrorKind::Kernel,
            "limits" => ErrorKind::Limits,
            "trap" => ErrorKind::Trap,
            _ => ErrorKind::Protocol,
        };
        let num = |k: &str| v.get(k).and_then(Value::as_u64).map(|n| n as u32);
        CadError {
            kind,
            message: v
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("(no message)")
                .to_string(),
            line: num("line"),
            column: num("column"),
            file: v.get("file").and_then(Value::as_str).map(str::to_string),
            stack: v.get("stack").and_then(Value::as_str).map(str::to_string),
        }
    }

    pub(crate) fn in_file(mut self, file: &str) -> Self {
        self.file.get_or_insert_with(|| file.to_string());
        self
    }
}

impl std::fmt::Display for CadError {
    /// `part.js:57:36: kernel error: OpenCascade StdFail_NotDone: ...`
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(file) = &self.file {
            write!(f, "{file}:")?;
            if let Some(line) = self.line {
                write!(f, "{line}:")?;
                if let Some(col) = self.column {
                    write!(f, "{col}:")?;
                }
            }
            f.write_str(" ")?;
        }
        write!(f, "{} error: {}", self.kind, self.message)
    }
}

impl std::error::Error for CadError {}
