pub mod capture;
pub mod commands;
pub mod db;
pub mod ocr;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use tokio::sync::Mutex as TokioMutex;

use crate::memory::db::MemoryDb;

/// Duration of a single video segment in seconds (5 minutes).
pub const DEFAULT_SEGMENT_DURATION_SECS: u64 = 300;

/// How often the recorder extracts a JPEG keyframe for OCR (seconds).
pub const DEFAULT_FRAME_INTERVAL_SECS: u64 = 10;

/// Default retention period in days.
pub const DEFAULT_RETENTION_DAYS: u32 = 30;

/// Shared state for the memory subsystem, managed by Tauri.
pub struct MemoryState {
    pub db: Arc<TokioMutex<Option<MemoryDb>>>,
    pub recording: Arc<AtomicBool>,
    pub recording_started_at: Arc<TokioMutex<Option<String>>>,
    pub cancel_token: Arc<TokioMutex<Option<tokio::sync::watch::Sender<bool>>>>,
    pub data_dir: PathBuf,
    pub segment_duration_secs: Arc<AtomicU64>,
    pub frame_interval_secs: Arc<AtomicU64>,
    pub retention_days: Arc<AtomicU32>,
}

impl MemoryState {
    pub fn new() -> Self {
        let data_dir = memory_data_dir();
        Self {
            db: Arc::new(TokioMutex::new(None)),
            recording: Arc::new(AtomicBool::new(false)),
            recording_started_at: Arc::new(TokioMutex::new(None)),
            cancel_token: Arc::new(TokioMutex::new(None)),
            data_dir,
            segment_duration_secs: Arc::new(AtomicU64::new(DEFAULT_SEGMENT_DURATION_SECS)),
            frame_interval_secs: Arc::new(AtomicU64::new(DEFAULT_FRAME_INTERVAL_SECS)),
            retention_days: Arc::new(AtomicU32::new(DEFAULT_RETENTION_DAYS)),
        }
    }

    pub fn is_recording(&self) -> bool {
        self.recording.load(Ordering::Relaxed)
    }

    /// Directory for video segments (MOV files).
    pub fn segments_dir(&self) -> PathBuf {
        self.data_dir.join("segments")
    }

    /// Directory for extracted JPEG keyframes.
    pub fn frames_dir(&self) -> PathBuf {
        self.data_dir.join("frames")
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("memory.db")
    }

    /// Path to the compiled OCR binary.
    pub fn ocr_binary_path(&self) -> PathBuf {
        self.data_dir.join("bin").join("ocr_vision")
    }

    /// Path to the compiled screen recorder binary.
    pub fn recorder_binary_path(&self) -> PathBuf {
        self.data_dir.join("bin").join("vanilla_shot_recorder")
    }
}

/// Resolve the base data directory for VanillaShot Memory.
///
/// The app has been renamed several times (Vulshot -> AYE -> Vanilla Shoot ->
/// VanillaShot). Each old location is migrated in turn so an existing install
/// keeps its history; if a rename fails, the old directory is used as-is rather
/// than silently starting an empty store next to the user's recordings.
fn memory_data_dir() -> PathBuf {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return std::env::temp_dir().join("vanilla-shot-memory");
    };

    let pictures_dir = home.join("Pictures").join("VanillaShot Memory");

    if pictures_dir.exists() {
        return pictures_dir;
    }

    // Newest first, so a machine carrying several old directories adopts the
    // most recent history.
    let legacy_dirs = [
        home.join("Pictures").join("Vanilla Shoot Memory"),
        home.join("Pictures").join("AYE Memory"),
        home.join("Pictures").join("Vulshot Memory"),
        home.join("Library")
            .join("Application Support")
            .join("com.vulshot")
            .join("memory"),
    ];

    for legacy_dir in legacy_dirs {
        if !legacy_dir.exists() {
            continue;
        }

        if let Some(parent) = pictures_dir.parent() {
            let _ = fs::create_dir_all(parent);
        }

        if fs::rename(&legacy_dir, &pictures_dir).is_err() {
            return legacy_dir;
        }

        return pictures_dir;
    }

    pictures_dir
}
