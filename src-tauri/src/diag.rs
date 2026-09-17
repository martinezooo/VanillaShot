//! Diagnostics: a log file the user can actually reach.
//!
//! Capture happens with no window on screen, so when it goes wrong there is
//! nowhere to show the reason. Every step of the capture path therefore writes
//! to a log file on disk, in release builds as well as debug, and Settings
//! shows where that file is.
//!
//! On macOS the file is `~/Library/Logs/com.hackjitsu.vanillashot/`.

use serde::Serialize;
use std::path::PathBuf;
use tauri::{Manager, Runtime};
use tauri_plugin_log::{Builder as LogBuilder, RotationStrategy, Target, TargetKind};

/// Log target names, so a line says which part of the app wrote it.
pub const CAPTURE: &str = "capture";
pub const DISPLAY: &str = "display";
pub const OVERLAY: &str = "overlay";
pub const WEBVIEW: &str = "webview";

const LOG_FILE_STEM: &str = "vanillashot";
const MAX_FILE_SIZE: u128 = 2 * 1024 * 1024;
const KEEP_LOGS: usize = 3;

/// A webview message longer than this is cut. Decoded barcode payloads and OCR
/// text can reach the log through an error message, and they are as long as an
/// attacker wants them to be.
const MAX_WEBVIEW_MESSAGE: usize = 1500;

/// Builds the log plugin.
///
/// Unconditional, unlike the usual `cfg!(debug_assertions)` guard. A release
/// build is the only one the user runs, so it is the only one whose failures
/// are worth recording.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    // `VANILLASHOT_LOG=debug` (or `trace`) turns up the detail when a report
    // needs more than the default.
    let level = match std::env::var("VANILLASHOT_LOG").as_deref() {
        Ok("trace") => log::LevelFilter::Trace,
        Ok("debug") => log::LevelFilter::Debug,
        Ok("warn") => log::LevelFilter::Warn,
        _ => log::LevelFilter::Info,
    };

    let mut targets = vec![Target::new(TargetKind::LogDir {
        file_name: Some(LOG_FILE_STEM.to_string()),
    })];
    if cfg!(debug_assertions) {
        targets.push(Target::new(TargetKind::Stdout));
    }

    LogBuilder::new()
        .level(level)
        // Timestamps in local time. A report is read next to the clock the user
        // was looking at, and UTC makes matching an event to a moment harder
        // than it needs to be.
        .format(|out, message, record| {
            out.finish(format_args!(
                "[{}][{}][{}] {}",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
                record.level(),
                record.target(),
                message
            ))
        })
        .max_file_size(MAX_FILE_SIZE)
        .rotation_strategy(RotationStrategy::KeepSome(KEEP_LOGS))
        .targets(targets)
        .build()
}

/// Where the current log file lives, if the log directory is resolvable.
pub fn log_file_path<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_log_dir()
        .ok()
        .map(|dir| dir.join(format!("{LOG_FILE_STEM}.log")))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsInfo {
    pub log_path: Option<String>,
    pub version: String,
    pub level: String,
}

/// What Settings needs to point the user at the log.
#[tauri::command]
pub fn diagnostics_info(app: tauri::AppHandle) -> DiagnosticsInfo {
    DiagnosticsInfo {
        log_path: log_file_path(&app).map(|p| p.display().to_string()),
        version: app.package_info().version.to_string(),
        level: log::max_level().to_string(),
    }
}

/// The tail of the log, for the "Copy report" button. Reading it here rather
/// than from the webview keeps the path out of the page: the page asks for the
/// log, it does not get to say which file that is.
#[tauri::command]
pub fn diagnostics_read_log(app: tauri::AppHandle, lines: Option<usize>) -> Result<String, String> {
    let wanted = lines.unwrap_or(200).clamp(1, 2000);
    let Some(path) = log_file_path(&app) else {
        return Err("Could not resolve the log directory".to_string());
    };
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    let collected: Vec<&str> = text.lines().collect();
    let start = collected.len().saturating_sub(wanted);
    Ok(collected[start..].join("\n"))
}

/// Strips anything that could forge a log line, and caps the length.
///
/// Text from the webview can carry a decoded barcode payload or OCR output, so
/// it is attacker-controlled. A newline in it would otherwise let that text
/// write what looks like its own timestamped entry.
fn sanitize(value: &str, max: usize) -> String {
    let mut out = String::with_capacity(value.len().min(max));
    for ch in value.chars() {
        if out.chars().count() >= max {
            out.push_str(" [cut]");
            break;
        }
        match ch {
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push(' '),
            c if c.is_control() => out.push('\u{fffd}'),
            c => out.push(c),
        }
    }
    out
}

/// The webview's way into the same log file.
///
/// The overlay runs with no window the user can see and no console anyone will
/// open, so a thrown exception there is invisible. This is how it gets on the
/// record.
#[tauri::command]
pub fn log_from_webview(window: tauri::WebviewWindow, level: String, scope: String, message: String) {
    let scope = sanitize(&scope, 40);
    let message = sanitize(&message, MAX_WEBVIEW_MESSAGE);
    let line = format!("[{}/{}] {}", window.label(), scope, message);
    match level.as_str() {
        "error" => log::error!(target: WEBVIEW, "{line}"),
        "warn" => log::warn!(target: WEBVIEW, "{line}"),
        "debug" => log::debug!(target: WEBVIEW, "{line}"),
        _ => log::info!(target: WEBVIEW, "{line}"),
    }
}

#[cfg(test)]
mod tests {
    use super::sanitize;

    #[test]
    fn sanitize_neutralises_line_breaks() {
        let forged = "ok\n[2026-01-01 00:00:00][ERROR][capture] fake";
        let cleaned = sanitize(forged, 200);
        assert!(!cleaned.contains('\n'));
        assert!(cleaned.contains("\\n"));
    }

    #[test]
    fn sanitize_caps_length() {
        let cleaned = sanitize(&"a".repeat(5000), 100);
        assert!(cleaned.chars().count() <= 106);
        assert!(cleaned.ends_with("[cut]"));
    }

    #[test]
    fn sanitize_replaces_control_characters() {
        let cleaned = sanitize("a\u{200b}b\u{0007}c", 100);
        assert!(!cleaned.contains('\u{0007}'));
        assert!(cleaned.contains('a') && cleaned.contains('c'));
    }
}
