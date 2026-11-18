//! A directory removed on drop (worker TMPDIRs and output staging).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::{CadError, ErrorKind};

#[derive(Debug)]
pub struct TempDir(PathBuf);

impl TempDir {
    /// A fresh directory `parent/PREFIX<pid>-<n>`.
    pub fn new_in(parent: &Path, prefix: &str) -> Result<TempDir, CadError> {
        static N: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        loop {
            let n = N.fetch_add(1, Ordering::Relaxed);
            let path = parent.join(format!("{prefix}{}-{nanos:x}-{n}", std::process::id()));
            match std::fs::create_dir(&path) {
                Ok(()) => return Ok(TempDir(path)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(CadError::new(ErrorKind::Io, format!("{}: {e}", path.display()))),
            }
        }
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
