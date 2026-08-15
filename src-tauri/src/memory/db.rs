use std::path::Path;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// A recorded video segment.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub id: i64,
    pub start_time: String,
    pub end_time: Option<String>,
    pub video_path: String,
    pub duration_secs: Option<f64>,
}

/// A single JPEG keyframe extracted from a video segment.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub id: i64,
    pub segment_id: i64,
    /// ISO-8601 UTC timestamp of the keyframe.
    pub timestamp: String,
    /// Offset in seconds from the start of the parent segment.
    pub offset_secs: f64,
    /// Absolute path to the extracted JPEG on disk.
    pub frame_path: String,
    /// Extracted OCR text (may be empty).
    pub ocr_text: String,
}

/// Aggregated statistics about the memory store.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStats {
    pub segment_count: u64,
    pub frame_count: u64,
    pub disk_usage_bytes: u64,
    pub oldest_frame: Option<String>,
    pub newest_frame: Option<String>,
}

/// Wrapper around a SQLite connection for the memory database.
pub struct MemoryDb {
    conn: Connection,
}

impl MemoryDb {
    /// Open (or create) the database at the given path and initialize the schema.
    pub fn open(db_path: &Path) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create DB directory: {e}"))?;
        }

        let conn = Connection::open(db_path).map_err(|e| format!("Cannot open memory DB: {e}"))?;

        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
            .map_err(|e| format!("Cannot set DB pragmas: {e}"))?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS segments (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                start_time    TEXT NOT NULL,
                end_time      TEXT,
                video_path    TEXT NOT NULL,
                duration_secs REAL
            );

            CREATE INDEX IF NOT EXISTS idx_segments_start ON segments(start_time);

            CREATE TABLE IF NOT EXISTS frames (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                segment_id  INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
                timestamp   TEXT NOT NULL,
                offset_secs REAL NOT NULL DEFAULT 0,
                frame_path  TEXT NOT NULL,
                ocr_text    TEXT NOT NULL DEFAULT ''
            );

            CREATE INDEX IF NOT EXISTS idx_frames_timestamp ON frames(timestamp);
            CREATE INDEX IF NOT EXISTS idx_frames_segment ON frames(segment_id);

            CREATE VIRTUAL TABLE IF NOT EXISTS frames_fts USING fts5(
                ocr_text,
                content='frames',
                content_rowid='id'
            );

            CREATE TRIGGER IF NOT EXISTS frames_ai AFTER INSERT ON frames BEGIN
                INSERT INTO frames_fts(rowid, ocr_text) VALUES (new.id, new.ocr_text);
            END;

            CREATE TRIGGER IF NOT EXISTS frames_ad AFTER DELETE ON frames BEGIN
                INSERT INTO frames_fts(frames_fts, rowid, ocr_text) VALUES ('delete', old.id, old.ocr_text);
            END;

            CREATE TRIGGER IF NOT EXISTS frames_au AFTER UPDATE ON frames BEGIN
                INSERT INTO frames_fts(frames_fts, rowid, ocr_text) VALUES ('delete', old.id, old.ocr_text);
                INSERT INTO frames_fts(rowid, ocr_text) VALUES (new.id, new.ocr_text);
            END;",
        )
        .map_err(|e| format!("Cannot initialize memory schema: {e}"))?;

        Ok(Self { conn })
    }

    // -----------------------------------------------------------------------
    // Segments
    // -----------------------------------------------------------------------

    /// Insert a new video segment (end_time and duration filled in later).
    pub fn insert_segment(&self, start_time: &str, video_path: &str) -> Result<i64, String> {
        self.conn
            .execute(
                "INSERT INTO segments (start_time, video_path) VALUES (?1, ?2)",
                params![start_time, video_path],
            )
            .map_err(|e| format!("Cannot insert segment: {e}"))?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Finalize a segment with its end time and duration.
    pub fn finalize_segment(
        &self,
        id: i64,
        end_time: &str,
        duration_secs: f64,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE segments SET end_time = ?1, duration_secs = ?2 WHERE id = ?3",
                params![end_time, duration_secs, id],
            )
            .map_err(|e| format!("Cannot finalize segment: {e}"))?;
        Ok(())
    }

    /// Get a segment by ID.
    pub fn get_segment(&self, id: i64) -> Result<Option<Segment>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, start_time, end_time, video_path, duration_secs FROM segments WHERE id = ?1")
            .map_err(|e| format!("Get segment error: {e}"))?;
        let mut rows = stmt
            .query_map(params![id], |row| {
                Ok(Segment {
                    id: row.get(0)?,
                    start_time: row.get(1)?,
                    end_time: row.get(2)?,
                    video_path: row.get(3)?,
                    duration_secs: row.get(4)?,
                })
            })
            .map_err(|e| format!("Get segment query error: {e}"))?;
        match rows.next() {
            Some(Ok(s)) => Ok(Some(s)),
            Some(Err(e)) => Err(format!("Row read error: {e}")),
            None => Ok(None),
        }
    }

    // -----------------------------------------------------------------------
    // Frames
    // -----------------------------------------------------------------------

    /// Insert a new keyframe extracted from a video segment.
    pub fn insert_frame(
        &self,
        segment_id: i64,
        timestamp: &str,
        offset_secs: f64,
        frame_path: &str,
        ocr_text: &str,
    ) -> Result<i64, String> {
        self.conn
            .execute(
                "INSERT INTO frames (segment_id, timestamp, offset_secs, frame_path, ocr_text)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![segment_id, timestamp, offset_secs, frame_path, ocr_text],
            )
            .map_err(|e| format!("Cannot insert frame: {e}"))?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Full-text search across OCR text. Returns up to `limit` frames.
    pub fn search(&self, query: &str, limit: u32) -> Result<Vec<Frame>, String> {
        let sanitized = sanitize_fts_query(query);
        if sanitized.is_empty() {
            return Ok(vec![]);
        }

        let mut stmt = self
            .conn
            .prepare(
                "SELECT f.id, f.segment_id, f.timestamp, f.offset_secs, f.frame_path, f.ocr_text
                 FROM frames_fts AS fts
                 JOIN frames AS f ON f.id = fts.rowid
                 WHERE frames_fts MATCH ?1
                 ORDER BY f.timestamp DESC
                 LIMIT ?2",
            )
            .map_err(|e| format!("Search prepare error: {e}"))?;

        let rows = stmt
            .query_map(params![sanitized, limit], row_to_frame)
            .map_err(|e| format!("Search query error: {e}"))?;

        collect_rows(rows)
    }

    /// Get frames within a time range.
    pub fn get_timeline(&self, start: &str, end: &str, limit: u32) -> Result<Vec<Frame>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, segment_id, timestamp, offset_secs, frame_path, ocr_text
                 FROM frames
                 WHERE timestamp >= ?1 AND timestamp <= ?2
                 ORDER BY timestamp DESC
                 LIMIT ?3",
            )
            .map_err(|e| format!("Timeline prepare error: {e}"))?;

        let rows = stmt
            .query_map(params![start, end, limit], row_to_frame)
            .map_err(|e| format!("Timeline query error: {e}"))?;

        collect_rows(rows)
    }

    /// Get a single frame by ID.
    pub fn get_frame(&self, id: i64) -> Result<Option<Frame>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, segment_id, timestamp, offset_secs, frame_path, ocr_text
                 FROM frames WHERE id = ?1",
            )
            .map_err(|e| format!("Get frame prepare error: {e}"))?;

        let mut rows = stmt
            .query_map(params![id], row_to_frame)
            .map_err(|e| format!("Get frame error: {e}"))?;

        match rows.next() {
            Some(Ok(frame)) => Ok(Some(frame)),
            Some(Err(e)) => Err(format!("Row read error: {e}")),
            None => Ok(None),
        }
    }

    /// Delete old segments and their frames, removing files from disk.
    pub fn purge_older_than(&self, days: u32) -> Result<u64, String> {
        let cutoff = chrono::Utc::now() - chrono::Duration::days(i64::from(days));
        let cutoff_str = cutoff.to_rfc3339();

        // Collect file paths to remove.
        let mut frame_stmt = self
            .conn
            .prepare("SELECT frame_path FROM frames WHERE timestamp < ?1")
            .map_err(|e| format!("Purge frames prepare: {e}"))?;
        let frame_paths: Vec<String> = frame_stmt
            .query_map(params![cutoff_str], |row| row.get(0))
            .map_err(|e| format!("Purge frames query: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        for p in &frame_paths {
            let _ = std::fs::remove_file(p);
        }

        let mut seg_stmt = self
            .conn
            .prepare("SELECT video_path FROM segments WHERE start_time < ?1")
            .map_err(|e| format!("Purge segments prepare: {e}"))?;
        let seg_paths: Vec<String> = seg_stmt
            .query_map(params![cutoff_str], |row| row.get(0))
            .map_err(|e| format!("Purge segments query: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        for p in &seg_paths {
            let _ = std::fs::remove_file(p);
        }

        // Delete DB rows (CASCADE deletes frames too).
        self.conn
            .execute(
                "DELETE FROM frames WHERE timestamp < ?1",
                params![cutoff_str],
            )
            .map_err(|e| format!("Purge frames delete: {e}"))?;
        let deleted = self
            .conn
            .execute(
                "DELETE FROM segments WHERE start_time < ?1",
                params![cutoff_str],
            )
            .map_err(|e| format!("Purge segments delete: {e}"))?;

        Ok(deleted as u64)
    }

    /// Aggregate statistics.
    pub fn stats(&self) -> Result<MemoryStats, String> {
        let segment_count: u64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM segments", [], |row| row.get(0))
            .map_err(|e| format!("Stats segment count: {e}"))?;

        let frame_count: u64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM frames", [], |row| row.get(0))
            .map_err(|e| format!("Stats frame count: {e}"))?;

        let oldest_frame: Option<String> = self
            .conn
            .query_row("SELECT MIN(timestamp) FROM frames", [], |row| row.get(0))
            .map_err(|e| format!("Stats oldest: {e}"))?;

        let newest_frame: Option<String> = self
            .conn
            .query_row("SELECT MAX(timestamp) FROM frames", [], |row| row.get(0))
            .map_err(|e| format!("Stats newest: {e}"))?;

        // Disk usage from video segments + frame JPEGs.
        let mut disk: u64 = 0;
        let mut vp_stmt = self
            .conn
            .prepare("SELECT video_path FROM segments")
            .map_err(|e| format!("Stats video paths: {e}"))?;
        disk += vp_stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| format!("Stats video query: {e}"))?
            .filter_map(|r| r.ok())
            .filter_map(|p| std::fs::metadata(&p).ok())
            .map(|m| m.len())
            .sum::<u64>();
        let mut fp_stmt = self
            .conn
            .prepare("SELECT frame_path FROM frames")
            .map_err(|e| format!("Stats frame paths: {e}"))?;
        disk += fp_stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| format!("Stats frame query: {e}"))?
            .filter_map(|r| r.ok())
            .filter_map(|p| std::fs::metadata(&p).ok())
            .map(|m| m.len())
            .sum::<u64>();

        Ok(MemoryStats {
            segment_count,
            frame_count,
            disk_usage_bytes: disk,
            oldest_frame,
            newest_frame,
        })
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn row_to_frame(row: &rusqlite::Row<'_>) -> rusqlite::Result<Frame> {
    Ok(Frame {
        id: row.get(0)?,
        segment_id: row.get(1)?,
        timestamp: row.get(2)?,
        offset_secs: row.get(3)?,
        frame_path: row.get(4)?,
        ocr_text: row.get(5)?,
    })
}

fn collect_rows(
    rows: rusqlite::MappedRows<'_, impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<Frame>>,
) -> Result<Vec<Frame>, String> {
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("Row read error: {e}"))?);
    }
    Ok(out)
}

/// Sanitize user input for FTS5 MATCH queries.
fn sanitize_fts_query(input: &str) -> String {
    let tokens: Vec<String> = input
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|t| {
            let cleaned: String = t
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-' || *c == '.')
                .collect();
            if cleaned.is_empty() {
                String::new()
            } else {
                format!("\"{cleaned}\"")
            }
        })
        .filter(|t| t.len() > 2)
        .collect();
    tokens.join(" ")
}
