//! Watches the project directory: a changed `<part>.js` or `<part>.studio.json`
//! (from any editor) queues a build and tells the browser. Writes made by the studio
//! itself also land here; [`App::touch`] ignores them when nothing changed.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use serde_json::json;

use crate::{App, sha256_hex, valid_part};

const DEBOUNCE: Duration = Duration::from_millis(120);

/// Starts the watcher; it lives as long as the returned value.
pub fn start(app: Arc<App>) -> notify::Result<notify::RecommendedWatcher> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<std::path::PathBuf>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            for p in ev.paths {
                let _ = tx.send(p);
            }
        }
    })?;
    watcher.watch(&app.dir, RecursiveMode::NonRecursive)?;
    tokio::spawn(async move {
        while let Some(first) = rx.recv().await {
            let mut paths = BTreeSet::from([first]);
            // Collect the burst an editor's save makes (temp file, rename, chmod).
            while let Ok(Some(p)) = tokio::time::timeout(DEBOUNCE, rx.recv()).await {
                paths.insert(p);
            }
            let mut scripts = BTreeSet::new();
            let mut scenes = BTreeSet::new();
            for p in &paths {
                match classify(p) {
                    Some((part, false)) => {
                        scripts.insert(part);
                    }
                    Some((part, true)) => {
                        scenes.insert(part);
                    }
                    None => {}
                }
            }
            for part in &scripts {
                if let Ok(src) = std::fs::read(app.script_path(part)) {
                    app.emit(json!({"type": "script", "part": part, "sha": sha256_hex(&src)}));
                } else {
                    app.emit(json!({"type": "parts"}));
                }
            }
            for part in &scenes {
                if let Ok(s) = app.load_scene(part) {
                    app.emit_scene(part, &s);
                }
            }
            for part in scripts.union(&scenes) {
                if app.script_path(part).is_file() {
                    let _ = app.touch(part);
                }
            }
        }
    });
    Ok(watcher)
}

/// `(part, is_scene)` for a part script or studio scene path.
fn classify(p: &Path) -> Option<(String, bool)> {
    let name = p.file_name()?.to_str()?;
    if let Some(part) = name.strip_suffix(".studio.json") {
        return valid_part(part).then(|| (part.to_owned(), true));
    }
    let part = name.strip_suffix(".js")?;
    valid_part(part).then(|| (part.to_owned(), false))
}

#[cfg(test)]
mod tests {
    use super::classify;
    use std::path::Path;

    #[test]
    fn classifies_scripts_and_scenes_only() {
        assert_eq!(classify(Path::new("/p/brace.js")), Some(("brace".into(), false)));
        assert_eq!(
            classify(Path::new("/p/brace.studio.json")),
            Some(("brace".into(), true))
        );
        assert_eq!(classify(Path::new("/p/brace.js.tmp-studio")), None);
        assert_eq!(classify(Path::new("/p/.hidden.js")), None);
        assert_eq!(classify(Path::new("/p/notes.md")), None);
    }
}
