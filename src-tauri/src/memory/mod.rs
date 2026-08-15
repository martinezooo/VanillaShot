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
        self.data_dir.join("bin").join("aye_recorder")
    }
}

/// Resolve the base data directory for AYE Memory.
fn memory_data_dir() -> PathBuf {
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        let pictures_dir = home.join("Pictures").join("AYE Memory");
        let previous_pictures_dir = home.join("Pictures").join("Vulshot Memory");
        let legacy_dir = home
            .join("Library")
            .join("Application Support")
            .join("com.vulshot")
            .join("memory");

        if !pictures_dir.exists()
            && previous_pictures_dir.exists()
            && fs::rename(&previous_pictures_dir, &pictures_dir).is_err()
        {
            return previous_pictures_dir;
        }

        if !pictures_dir.exists() && legacy_dir.exists() {
            if let Some(parent) = pictures_dir.parent() {
                let _ = fs::create_dir_all(parent);
            }

            if fs::rename(&legacy_dir, &pictures_dir).is_err() {
                return legacy_dir;
            }
        }

        return pictures_dir;
    }
    std::env::temp_dir().join("aye-memory")
}
