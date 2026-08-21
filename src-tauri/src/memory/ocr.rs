use std::path::{Path, PathBuf};
use std::process::Command;

/// Resolves a bundled helper binary from the app's Resources directory.
///
/// The OCR and recorder helpers are compiled at build time (see build.rs) and
/// shipped inside the code-signed app bundle, rather than compiled at runtime
/// into a user-writable folder. `resource_dir` points at `Contents/Resources`
/// in a bundled app and at the target dir under `tauri dev`.
pub fn resolve_helper<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    name: &str,
) -> Result<PathBuf, String> {
    use tauri::Manager;

    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| format!("Cannot locate app resources: {e}"))?;
    let binary = resource_dir.join("helpers").join(name);

    if !binary.exists() {
        return Err(format!(
            "Bundled helper '{name}' is missing from the app. Reinstall VanillaShot."
        ));
    }

    Ok(binary)
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
