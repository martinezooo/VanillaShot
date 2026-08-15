use std::path::{Path, PathBuf};
use std::process::Command;

/// The embedded Swift source for Vision-based OCR.
const OCR_SWIFT_SOURCE: &str = include_str!("../../scripts/ocr_vision.swift");

/// The embedded Swift source for the ScreenCaptureKit video recorder.
const RECORDER_SWIFT_SOURCE: &str = include_str!("../../scripts/vanilla_shoot_recorder.swift");

/// Ensure the compiled OCR binary exists, compiling from source if needed.
/// Returns the absolute path to the binary.
pub fn ensure_ocr_binary(binary_path: &Path) -> Result<PathBuf, String> {
    if binary_path.exists() {
        return Ok(binary_path.to_path_buf());
    }

    if let Some(parent) = binary_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create OCR binary directory: {e}"))?;
    }

    let source_path = binary_path.with_extension("swift");
    std::fs::write(&source_path, OCR_SWIFT_SOURCE)
        .map_err(|e| format!("Cannot write OCR Swift source: {e}"))?;

    let output = Command::new("swiftc")
        .args([
            "-O",
            "-framework",
            "Vision",
            "-framework",
            "CoreGraphics",
            "-framework",
            "ImageIO",
            "-o",
        ])
        .arg(binary_path)
        .arg(&source_path)
        .output()
        .map_err(|e| format!("Cannot run swiftc: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("swiftc compilation failed: {stderr}"));
    }

    Ok(binary_path.to_path_buf())
}

/// Ensure the compiled video recorder binary exists, compiling from source if needed.
pub fn ensure_recorder_binary(binary_path: &Path) -> Result<PathBuf, String> {
    if binary_path.exists() {
        return Ok(binary_path.to_path_buf());
    }

    if let Some(parent) = binary_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create recorder binary directory: {e}"))?;
    }

    let source_path = binary_path.with_extension("swift");
    std::fs::write(&source_path, RECORDER_SWIFT_SOURCE)
        .map_err(|e| format!("Cannot write recorder Swift source: {e}"))?;

    let output = Command::new("swiftc")
        .args([
            "-O",
            "-framework",
            "ScreenCaptureKit",
            "-framework",
            "AVFoundation",
            "-framework",
            "CoreMedia",
            "-framework",
            "CoreGraphics",
            "-framework",
            "CoreImage",
            "-o",
        ])
        .arg(binary_path)
        .arg(&source_path)
        .output()
        .map_err(|e| format!("Cannot run swiftc for recorder: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Recorder compilation failed: {stderr}"));
    }

    Ok(binary_path.to_path_buf())
}

/// Run OCR on the given image file and return the extracted text.
pub fn run_ocr(binary_path: &Path, image_path: &Path) -> Result<String, String> {
    let output = Command::new(binary_path)
        .arg(image_path)
        .output()
        .map_err(|e| format!("OCR binary execution failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("OCR failed: {stderr}"));
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(text)
}
