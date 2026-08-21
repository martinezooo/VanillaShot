use serde::Serialize;
use std::path::PathBuf;

use crate::memory::capture;
use crate::memory::db::{Frame, MemoryDb, MemoryStats, Segment};
use crate::memory::MemoryState;

/// Error type returned by memory commands.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryError {
    pub message: String,
}

impl From<String> for MemoryError {
    fn from(message: String) -> Self {
        Self { message }
    }
}

/// Status payload returned by `memory_status`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStatusPayload {
    pub recording: bool,
    pub recording_started_at: Option<String>,
    pub stats: Option<MemoryStats>,
    pub data_dir: String,
    pub segment_duration_secs: u64,
    pub frame_interval_secs: u64,
    pub retention_days: u32,
}

/// Frame with base64-encoded image for `memory_get_frame`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameWithImage {
    #[serde(flatten)]
    pub frame: Frame,
    /// Base64 JPEG data URL, or empty if file is missing.
    pub image_data_url: String,
    /// Parent video segment (if resolvable).
    pub segment: Option<Segment>,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn memory_start(
    state: tauri::State<'_, MemoryState>,
    app_handle: tauri::AppHandle,
) -> Result<String, MemoryError> {
    if state.is_recording() {
        return Ok("Already recording".into());
    }

    let cancel_tx = capture::start_capture_loop(&state).await?;

    {
        let mut token = state.cancel_token.lock().await;
        *token = Some(cancel_tx);
    }

    #[cfg(all(desktop, target_os = "macos"))]
    crate::refresh_tray_menu(&app_handle);

    Ok("Memory recording started".into())
}

#[tauri::command]
pub async fn memory_stop(
    state: tauri::State<'_, MemoryState>,
    app_handle: tauri::AppHandle,
) -> Result<String, MemoryError> {
    if !state.is_recording() {
        return Ok("Not recording".into());
    }

    let token = {
        let mut guard = state.cancel_token.lock().await;
        guard.take()
    };

    if let Some(tx) = token {
        let _ = tx.send(true);
    }

    // Wait for the capture loop to actually clear the recording flag, so the
    // reported "stopped" is true rather than optimistic. Bounded so a wedged
    // recorder cannot hang the command.
    for _ in 0..100 {
        if !state.is_recording() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    #[cfg(all(desktop, target_os = "macos"))]
    crate::refresh_tray_menu(&app_handle);

    Ok("Memory recording stopped".into())
}

#[tauri::command]
pub async fn memory_status(
    state: tauri::State<'_, MemoryState>,
) -> Result<MemoryStatusPayload, MemoryError> {
    let recording = state.is_recording();
    let recording_started_at = state.recording_started_at.lock().await.clone();
    let seg_dur = state
        .segment_duration_secs
        .load(std::sync::atomic::Ordering::Relaxed);
    let frame_int = state
        .frame_interval_secs
        .load(std::sync::atomic::Ordering::Relaxed);
    let retention = state
        .retention_days
        .load(std::sync::atomic::Ordering::Relaxed);

    // stats() walks every segment and frame file on disk (a stat() per file).
    // Doing that while holding the live DB mutex would stall the capture loop,
    // which needs the same lock to insert frames. Use a short-lived read-only
    // connection instead, so status polls never contend with recording.
    let stats = if state.db_path().exists() {
        let db_path = state.db_path();
        tokio::task::spawn_blocking(move || MemoryDb::open(&db_path).and_then(|db| db.stats()))
            .await
            .map_err(|e| MemoryError::from(format!("Stats task failed: {e}")))?
            .ok()
    } else {
        None
    };

    Ok(MemoryStatusPayload {
        recording,
        recording_started_at,
        stats,
        data_dir: state.data_dir.to_string_lossy().to_string(),
        segment_duration_secs: seg_dur,
        frame_interval_secs: frame_int,
        retention_days: retention,
    })
}

#[tauri::command]
pub async fn memory_search(
    state: tauri::State<'_, MemoryState>,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<Frame>, MemoryError> {
    let limit = limit.unwrap_or(20).min(200);
    let db = ensure_db(&state).await?;
    let results = db.search(&query, limit)?;
    Ok(results)
}

#[tauri::command]
pub async fn memory_open_path_in_finder(path: String) -> Result<String, MemoryError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Path is empty".to_string().into());
    }

    let requested_path = PathBuf::from(trimmed);
    let open_target = if requested_path.is_dir() {
        requested_path.clone()
    } else if requested_path.is_file() {
        requested_path
            .parent()
            .map(PathBuf::from)
            .ok_or_else(|| "Could not resolve the parent folder".to_string())?
    } else if let Some(parent) = requested_path.parent().filter(|parent| parent.exists()) {
        parent.to_path_buf()
    } else {
        return Err(format!("Path does not exist: {}", requested_path.display()).into());
    };

    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .arg(&open_target)
            .status()
            .map_err(|e| format!("Could not open Finder: {e}"))?;

        if !status.success() {
            return Err(format!("Finder could not open {}", open_target.display()).into());
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        return Err("Opening Finder is supported only on macOS."
            .to_string()
            .into());
    }

    Ok(format!("Opened {}", open_target.display()))
}

#[tauri::command]
pub async fn memory_get_frame(
    state: tauri::State<'_, MemoryState>,
    id: i64,
) -> Result<Option<FrameWithImage>, MemoryError> {
    let db = ensure_db(&state).await?;
    let frame = match db.get_frame(id)? {
        Some(f) => f,
        None => return Ok(None),
    };

    let image_data_url = match std::fs::read(&frame.frame_path) {
        Ok(bytes) => {
            use base64::Engine;
            let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
            format!("data:image/jpeg;base64,{encoded}")
        }
        Err(_) => String::new(),
    };

    let segment = db.get_segment(frame.segment_id).unwrap_or(None);

    Ok(Some(FrameWithImage {
        frame,
        image_data_url,
        segment,
    }))
}

#[tauri::command]
pub async fn memory_get_timeline(
    state: tauri::State<'_, MemoryState>,
    start: String,
    end: String,
    limit: Option<u32>,
) -> Result<Vec<Frame>, MemoryError> {
    let limit = limit.unwrap_or(50).min(500);
    let db = ensure_db(&state).await?;
    let frames = db.get_timeline(&start, &end, limit)?;
    Ok(frames)
}

#[tauri::command]
pub async fn memory_purge(
    state: tauri::State<'_, MemoryState>,
    days: Option<u32>,
) -> Result<u64, MemoryError> {
    let days = days.unwrap_or(
        state
            .retention_days
            .load(std::sync::atomic::Ordering::Relaxed),
    );
    let db = ensure_db(&state).await?;
    let deleted = db.purge_older_than(days)?;
    Ok(deleted)
}

#[tauri::command]
pub async fn memory_get_segment(
    state: tauri::State<'_, MemoryState>,
    id: i64,
) -> Result<Option<Segment>, MemoryError> {
    let db = ensure_db(&state).await?;
    Ok(db.get_segment(id)?)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Ensure the database is available (opening it if needed for read-only queries).
async fn ensure_db(state: &MemoryState) -> Result<EnsuredDb<'_>, MemoryError> {
    let guard = state.db.lock().await;
    if guard.is_some() {
        // DB is already open via the capture loop.
        return Ok(EnsuredDb::Shared(guard));
    }
    drop(guard);

    // Open a temporary read-only connection.
    if state.db_path().exists() {
        let db = MemoryDb::open(&state.db_path())?;
        return Ok(EnsuredDb::Owned(db));
    }

    Err(MemoryError {
        message: "Memory database does not exist. Start recording first.".into(),
    })
}

/// A helper enum so we can use the DB whether it comes from shared state or a fresh open.
enum EnsuredDb<'a> {
    Shared(tokio::sync::MutexGuard<'a, Option<MemoryDb>>),
    Owned(MemoryDb),
}

impl<'a> std::ops::Deref for EnsuredDb<'a> {
    type Target = MemoryDb;

    fn deref(&self) -> &MemoryDb {
        match self {
            EnsuredDb::Shared(guard) => guard.as_ref().unwrap(),
            EnsuredDb::Owned(db) => db,
        }
    }
}
