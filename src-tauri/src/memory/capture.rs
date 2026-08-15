use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex as TokioMutex;

use crate::memory::db::MemoryDb;
use crate::memory::ocr;
use crate::memory::MemoryState;

/// Generate a segment name based on UTC time.
fn segment_name() -> String {
    chrono::Utc::now().format("seg-%Y%m%d-%H%M%S").to_string()
}

/// Start the background video capture loop. Returns a cancel sender.
pub async fn start_capture_loop(
    state: &MemoryState,
) -> Result<tokio::sync::watch::Sender<bool>, String> {
    let segments_dir = state.segments_dir();
    let frames_dir = state.frames_dir();
    std::fs::create_dir_all(&segments_dir)
        .map_err(|e| format!("Cannot create segments directory: {e}"))?;
    std::fs::create_dir_all(&frames_dir)
        .map_err(|e| format!("Cannot create frames directory: {e}"))?;

    // Compile helper binaries (one-time).
    let recorder_bin = ocr::ensure_recorder_binary(&state.recorder_binary_path())?;
    let ocr_bin = ocr::ensure_ocr_binary(&state.ocr_binary_path())?;

    // Open (or create) the database.
    {
        let mut db_guard = state.db.lock().await;
        if db_guard.is_none() {
            *db_guard = Some(MemoryDb::open(&state.db_path())?);
        }
    }

    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);

    let recording_flag = Arc::clone(&state.recording);
    let recording_started_at = Arc::clone(&state.recording_started_at);
    let segment_duration = Arc::clone(&state.segment_duration_secs);
    let frame_interval = Arc::clone(&state.frame_interval_secs);
    let retention_days = Arc::clone(&state.retention_days);
    let db = Arc::clone(&state.db);

    recording_flag.store(true, Ordering::Relaxed);
    {
        let mut started_at = recording_started_at.lock().await;
        *started_at = Some(chrono::Utc::now().to_rfc3339());
    }

    tokio::spawn(async move {
        let mut segment_count: u64 = 0;
        let mut cancel_rx = cancel_rx;

        loop {
            if *cancel_rx.borrow() {
                break;
            }

            let seg_name = segment_name();
            let video_path = segments_dir.join(format!("{seg_name}.mov"));
            let seg_frames_dir = frames_dir.join(&seg_name);
            let _ = std::fs::create_dir_all(&seg_frames_dir);

            let dur = segment_duration.load(Ordering::Relaxed);
            let fi = frame_interval.load(Ordering::Relaxed);

            let segment_request = SegmentRecordRequest {
                recorder_bin: &recorder_bin,
                ocr_bin: &ocr_bin,
                video_path: &video_path,
                frames_dir: &seg_frames_dir,
                duration_secs: dur,
                frame_interval_secs: fi,
                db: &db,
            };

            let result = record_one_segment(segment_request, &mut cancel_rx).await;

            match result {
                Ok(seg_id) => {
                    log::info!("Memory: finished segment #{seg_id} ({seg_name})");
                }
                Err(e) => {
                    log::warn!("Memory: segment {seg_name} failed: {e}");
                }
            }

            segment_count += 1;

            // Auto-purge every 6 segments (~30 minutes at 5-min segments).
            if segment_count % 6 == 0 {
                let days = retention_days.load(Ordering::Relaxed);
                if let Some(db_ref) = &*db.lock().await {
                    if let Err(e) = db_ref.purge_older_than(days) {
                        log::warn!("Memory auto-purge failed: {e}");
                    }
                }
            }
        }

        recording_flag.store(false, Ordering::Relaxed);
        {
            let mut started_at = recording_started_at.lock().await;
            *started_at = None;
        }
        log::info!("Memory capture loop stopped after {segment_count} segments");
    });

    Ok(cancel_tx)
}

/// Record a single video segment, streaming keyframes for OCR in real time.
struct SegmentRecordRequest<'a> {
    recorder_bin: &'a Path,
    ocr_bin: &'a Path,
    video_path: &'a Path,
    frames_dir: &'a Path,
    duration_secs: u64,
    frame_interval_secs: u64,
    db: &'a Arc<TokioMutex<Option<MemoryDb>>>,
}

async fn record_one_segment(
    request: SegmentRecordRequest<'_>,
    cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<i64, String> {
    let start_time = chrono::Utc::now();
    let start_time_str = start_time.to_rfc3339();

    // Insert segment record.
    let segment_id = {
        let guard = request.db.lock().await;
        guard
            .as_ref()
            .ok_or("DB not initialized")?
            .insert_segment(&start_time_str, &request.video_path.to_string_lossy())?
    };

    // Spawn the recorder child process.
    let mut child = tokio::process::Command::new(request.recorder_bin)
        .arg(request.video_path)
        .arg(request.frames_dir)
        .arg(request.duration_secs.to_string())
        .arg(request.frame_interval_secs.to_string())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Cannot spawn recorder: {e}"))?;

    let stdout = child.stdout.take().ok_or("No recorder stdout")?;
    let mut stdin = child.stdin.take().ok_or("No recorder stdin")?;
    let mut reader = BufReader::new(stdout).lines();

    // Read keyframe paths from recorder stdout and OCR them in real time.
    loop {
        tokio::select! {
            line = reader.next_line() => {
                match line {
                    Ok(Some(line)) => {
                        process_frame_line(&line, segment_id, request.ocr_bin, request.db).await;
                    }
                    Ok(None) => break, // recorder exited
                    Err(e) => {
                        log::warn!("Memory: stdout read error: {e}");
                        break;
                    }
                }
            }
            _ = cancel_rx.changed() => {
                if *cancel_rx.borrow() {
                    // Send stop command to recorder.
                    let _ = stdin.write_all(b"stop\n").await;
                    let _ = stdin.flush().await;
                    // Drain remaining stdout lines.
                    while let Ok(Some(line)) = reader.next_line().await {
                        process_frame_line(&line, segment_id, request.ocr_bin, request.db).await;
                    }
                    break;
                }
            }
        }
    }

    // Wait for recorder to exit.
    let _ = child.wait().await;

    // Finalize segment.
    let end_time = chrono::Utc::now();
    let duration = (end_time - start_time).num_milliseconds() as f64 / 1000.0;
    {
        let guard = request.db.lock().await;
        if let Some(db_ref) = guard.as_ref() {
            let _ = db_ref.finalize_segment(segment_id, &end_time.to_rfc3339(), duration);
        }
    }

    Ok(segment_id)
}

/// Process a single frame line from the recorder: "<path>\t<offset>".
async fn process_frame_line(
    line: &str,
    segment_id: i64,
    ocr_bin: &Path,
    db: &Arc<TokioMutex<Option<MemoryDb>>>,
) {
    let parts: Vec<&str> = line.splitn(2, '\t').collect();
    if parts.len() < 2 {
        return;
    }

    let frame_path = parts[0].to_string();
    let offset_secs: f64 = parts[1].parse().unwrap_or(0.0);
    let timestamp = chrono::Utc::now().to_rfc3339();

    // Run OCR in a blocking thread.
    let ocr_bin_clone = ocr_bin.to_path_buf();
    let frame_path_clone = frame_path.clone();
    let ocr_text = tokio::task::spawn_blocking(move || {
        ocr::run_ocr(&ocr_bin_clone, &std::path::PathBuf::from(&frame_path_clone))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default();

    // Insert into DB.
    let guard = db.lock().await;
    if let Some(db_ref) = guard.as_ref() {
        match db_ref.insert_frame(segment_id, &timestamp, offset_secs, &frame_path, &ocr_text) {
            Ok(id) => log::info!(
                "Memory: frame #{id} ({} chars OCR, offset {offset_secs:.1}s)",
                ocr_text.len()
            ),
            Err(e) => log::warn!("Memory: frame insert failed: {e}"),
        }
    }
}
