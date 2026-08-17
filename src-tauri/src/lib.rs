use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use image::GenericImageView;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

mod memory;

const CAPTURE_READY_EVENT: &str = "capture://ready";
const QUICK_EDITOR_CAPTURE_READY_EVENT: &str = "capture://quick-editor-ready";
const CAPTURE_ERROR_EVENT: &str = "capture://error";
const GLOBAL_SHORTCUT_ACCELERATORS: [&str; 2] = ["cmd+shift+1", "ctrl+shift+1"];
const QUICK_EDITOR_WINDOW_LABEL: &str = "quick-editor";
#[cfg(all(desktop, target_os = "macos"))]
const TRAY_CAPTURE_MENU_ID: &str = "tray_capture_region";
#[cfg(all(desktop, target_os = "macos"))]
const TRAY_QUIT_MENU_ID: &str = "tray_quit";
#[cfg(all(desktop, target_os = "macos"))]
const TRAY_MEMORY_TOGGLE_ID: &str = "tray_memory_toggle";
#[cfg(all(desktop, target_os = "macos"))]
const TRAY_SHOW_MENU_ID: &str = "tray_show";
#[cfg(all(desktop, target_os = "macos"))]
const TRAY_SCREEN_RECORDING_SETTINGS_ID: &str = "tray_screen_recording_settings";

#[derive(Default)]
struct PendingQuickCaptureState {
    payload: Mutex<Option<CaptureReadyPayload>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureError {
    code: String,
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopCursorPoint {
    x: f64,
    y: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureReadyPayload {
    data_url: String,
    cursor: Option<DesktopCursorPoint>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedCapturePayload {
    image_path: String,
    note_path: Option<String>,
}

impl CaptureError {
    fn cancelled(message: impl Into<String>) -> Self {
        Self {
            code: "CaptureCancelled".to_string(),
            message: message.into(),
        }
    }

    fn failed(message: impl Into<String>) -> Self {
        Self {
            code: "CaptureFailed".to_string(),
            message: message.into(),
        }
    }
}

#[tauri::command]
fn capture_region(app_handle: tauri::AppHandle) -> Result<CaptureReadyPayload, CaptureError> {
    let data_url = capture_region_with_window(&app_handle)?;
    let cursor = app_handle
        .cursor_position()
        .ok()
        .map(|position| DesktopCursorPoint {
            x: position.x,
            y: position.y,
        });

    Ok(CaptureReadyPayload { data_url, cursor })
}

#[tauri::command]
fn save_capture_png(
    data_url: String,
    note_text: Option<String>,
) -> Result<SavedCapturePayload, CaptureError> {
    save_capture_png_impl(&data_url, note_text.as_deref())
}

#[tauri::command]
fn copy_capture_png(data_url: String) -> Result<(), CaptureError> {
    copy_capture_png_impl(&data_url)
}

#[tauri::command]
fn show_main_capture_window(app_handle: tauri::AppHandle) {
    show_main_window(&app_handle);
}

#[tauri::command]
fn hide_main_capture_window(app_handle: tauri::AppHandle) {
    hide_main_window(&app_handle);
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn open_screen_recording_settings() -> Result<(), CaptureError> {
    open_screen_recording_settings_impl()
}

/// Reports whether macOS has granted Screen Recording access.
///
/// `CGPreflightScreenCaptureAccess` answers without prompting, so the settings
/// window can show the real state instead of only offering a button that may
/// not be needed.
#[cfg(target_os = "macos")]
fn screen_recording_access_granted_impl() -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
    }

    unsafe { CGPreflightScreenCaptureAccess() }
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn screen_recording_access_granted() -> bool {
    screen_recording_access_granted_impl()
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn screen_recording_access_granted() -> bool {
    true
}

/// Where exported PNGs land, so the settings window can name the folder.
#[tauri::command]
fn capture_output_dir() -> String {
    preferred_output_dir().to_string_lossy().to_string()
}

/// Opens the project page.
///
/// The URL is fixed here rather than passed in from the webview: a command that
/// forwards an arbitrary string to `open` would hand anything running in the
/// page a way to launch external handlers.
#[tauri::command]
fn open_project_page() -> Result<(), CaptureError> {
    const PROJECT_URL: &str = "https://github.com/hack-jitsu/Repshot";

    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/open")
            .arg(PROJECT_URL)
            .status()
            .map_err(|error| CaptureError::failed(format!("Could not open the project page: {error}")))?;

        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    Err(CaptureError::failed("Opening links is supported only on macOS in this release"))
}

#[tauri::command]
fn open_quick_capture_window(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, PendingQuickCaptureState>,
    data_url: String,
    cursor: Option<DesktopCursorPoint>,
) -> Result<(), CaptureError> {
    let _ = decode_png_dimensions(&data_url)?;
    let cursor = cursor.or_else(|| {
        app_handle
            .cursor_position()
            .ok()
            .map(|position| DesktopCursorPoint {
                x: position.x,
                y: position.y,
            })
    });

    let frame = compute_quick_editor_window_frame(&app_handle, cursor.as_ref())?;
    let payload = CaptureReadyPayload { data_url, cursor };

    if let Some(existing) = app_handle.get_webview_window(QUICK_EDITOR_WINDOW_LABEL) {
        let _ = existing.emit(QUICK_EDITOR_CAPTURE_READY_EVENT, payload);
        return Ok(());
    }

    {
        let mut pending = state
            .payload
            .lock()
            .map_err(|_| CaptureError::failed("Could not store pending quick capture payload"))?;
        *pending = Some(payload.clone());
    }

    let mut builder = WebviewWindowBuilder::new(
        &app_handle,
        QUICK_EDITOR_WINDOW_LABEL,
        WebviewUrl::default(),
    )
    .title("VanillaShot Quick Editor")
    .inner_size(frame.width, frame.height)
    .position(frame.x, frame.y)
    .resizable(false)
    .focused(false)
    .visible(false)
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .background_color(tauri::window::Color(0, 0, 0, 0));

    #[cfg(target_os = "macos")]
    {
        builder = builder.visible_on_all_workspaces(true);
    }

    let _window = builder.build().map_err(|error| {
        CaptureError::failed(format!("Could not open quick editor window: {error}"))
    })?;
    Ok(())
}

#[tauri::command]
fn take_pending_quick_capture(
    window: WebviewWindow,
    state: tauri::State<'_, PendingQuickCaptureState>,
) -> Result<Option<CaptureReadyPayload>, CaptureError> {
    if window.label() != QUICK_EDITOR_WINDOW_LABEL {
        return Ok(None);
    }

    let mut pending = state
        .payload
        .lock()
        .map_err(|_| CaptureError::failed("Could not read pending quick capture payload"))?;

    Ok(pending.take())
}

fn capture_region_impl() -> Result<String, CaptureError> {
    #[cfg(target_os = "macos")]
    {
        capture_region_macos()
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err(CaptureError::failed(
            "Native region capture is supported only on macOS in this release",
        ))
    }
}

fn capture_region_with_window<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
) -> Result<String, CaptureError> {
    let was_visible = app_handle
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);

    if was_visible {
        hide_main_window(app_handle);
        std::thread::sleep(Duration::from_millis(150));
    }

    match capture_region_impl() {
        Ok(data_url) => Ok(data_url),
        Err(error) => {
            if was_visible {
                show_main_window(app_handle);
            }
            Err(error)
        }
    }
}

#[cfg(target_os = "macos")]
fn capture_region_macos() -> Result<String, CaptureError> {
    // Ask before launching screencapture. Without Screen Recording it exits 1
    // with no stderr, which is indistinguishable from the user pressing Escape,
    // so the capture would fail silently and look like nothing happened.
    if !screen_recording_access_granted_impl() {
        return Err(CaptureError::failed(screen_recording_permission_message()));
    }

    let epoch_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let file_path = std::env::temp_dir().join(format!(
        "vanilla-shot-region-{}-{}.png",
        std::process::id(),
        epoch_ms
    ));

    let output = Command::new("/usr/sbin/screencapture")
        .args(["-i", "-x", "-r"])
        .arg(&file_path)
        .output()
        .map_err(|error| {
            CaptureError::failed(format!("Failed to launch screencapture: {error}"))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let _ = fs::remove_file(&file_path);

        if is_screen_capture_permission_error(&stderr) {
            return Err(CaptureError::failed(screen_recording_permission_message()));
        }

        if is_capture_cancelled(output.status.code(), &stderr) {
            return Err(CaptureError::cancelled("Capture cancelled"));
        }

        let status = output
            .status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "unknown".to_string());

        let detail = if stderr.is_empty() {
            String::new()
        } else {
            format!(": {stderr}")
        };

        return Err(CaptureError::failed(format!(
            "screencapture exited with status {status}{detail}"
        )));
    }

    let bytes = fs::read(&file_path)
        .map_err(|error| CaptureError::failed(format!("Failed to read capture image: {error}")))?;
    let _ = fs::remove_file(&file_path);

    if bytes.is_empty() {
        return Err(CaptureError::failed(format!(
            "Capture produced an empty image. {}",
            screen_recording_permission_message()
        )));
    }

    Ok(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
}

fn save_capture_png_impl(
    data_url: &str,
    note_text: Option<&str>,
) -> Result<SavedCapturePayload, CaptureError> {
    let image_bytes = decode_png_data_url(data_url)?;
    let output_dir = preferred_output_dir();

    fs::create_dir_all(&output_dir).map_err(|error| {
        CaptureError::failed(format!("Failed to create output directory: {error}"))
    })?;

    let output_path = output_dir.join(format!("vanilla-shot-{}-{}.png", std::process::id(), epoch_millis()));

    fs::write(&output_path, image_bytes)
        .map_err(|error| CaptureError::failed(format!("Failed to write PNG file: {error}")))?;

    let note_path = persist_capture_note(&output_path, note_text)?;

    Ok(SavedCapturePayload {
        image_path: output_path.to_string_lossy().to_string(),
        note_path,
    })
}

fn persist_capture_note(
    image_path: &Path,
    note_text: Option<&str>,
) -> Result<Option<String>, CaptureError> {
    let Some(trimmed_note) = note_text.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    let note_path = image_path.with_extension("txt");
    let image_name = image_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("capture.png");

    let note_body = format!(
        "VanillaShot note for {image_name}\nImage path: {}\n\n{trimmed_note}\n",
        image_path.to_string_lossy()
    );

    fs::write(&note_path, note_body)
        .map_err(|error| CaptureError::failed(format!("Failed to write note file: {error}")))?;

    Ok(Some(note_path.to_string_lossy().to_string()))
}

fn copy_capture_png_impl(data_url: &str) -> Result<(), CaptureError> {
    let image_bytes = decode_png_data_url(data_url)?;
    let decoded = image::load_from_memory_with_format(&image_bytes, image::ImageFormat::Png)
        .map_err(|error| {
            CaptureError::failed(format!("Failed to decode PNG for clipboard: {error}"))
        })?;
    let rgba = decoded.to_rgba8();
    let (width, height) = rgba.dimensions();

    let width_usize = usize::try_from(width)
        .map_err(|_| CaptureError::failed("Clipboard copy failed: image width is too large"))?;
    let height_usize = usize::try_from(height)
        .map_err(|_| CaptureError::failed("Clipboard copy failed: image height is too large"))?;

    let mut clipboard = arboard::Clipboard::new()
        .map_err(|error| CaptureError::failed(format!("Failed to access clipboard: {error}")))?;

    clipboard
        .set_image(arboard::ImageData {
            width: width_usize,
            height: height_usize,
            bytes: Cow::Owned(rgba.into_raw()),
        })
        .map_err(|error| {
            CaptureError::failed(format!("Failed to copy image to clipboard: {error}"))
        })
}

fn decode_png_data_url(data_url: &str) -> Result<Vec<u8>, CaptureError> {
    const PREFIX: &str = "data:image/png;base64,";

    let encoded = data_url
        .strip_prefix(PREFIX)
        .ok_or_else(|| CaptureError::failed("Expected PNG data URL payload"))?;

    STANDARD
        .decode(encoded)
        .map_err(|error| CaptureError::failed(format!("Failed to decode PNG payload: {error}")))
}

fn decode_png_dimensions(data_url: &str) -> Result<(u32, u32), CaptureError> {
    let image_bytes = decode_png_data_url(data_url)?;
    let decoded = image::load_from_memory_with_format(&image_bytes, image::ImageFormat::Png)
        .map_err(|error| {
            CaptureError::failed(format!("Failed to decode PNG dimensions: {error}"))
        })?;

    Ok(decoded.dimensions())
}

fn preferred_output_dir() -> PathBuf {
    if let Some(home_dir) = std::env::var_os("HOME").map(PathBuf::from) {
        return home_dir.join("Pictures");
    }

    std::env::temp_dir()
}

fn epoch_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

struct QuickEditorWindowFrame {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn compute_quick_editor_window_frame<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    cursor: Option<&DesktopCursorPoint>,
) -> Result<QuickEditorWindowFrame, CaptureError> {
    let monitors = app_handle
        .available_monitors()
        .map_err(|error| CaptureError::failed(format!("Could not inspect monitors: {error}")))?;
    let mut anchor_monitor = app_handle.primary_monitor().map_err(|error| {
        CaptureError::failed(format!("Could not inspect primary monitor: {error}"))
    })?;

    if let Some(cursor) = cursor {
        if let Some(found_monitor) = monitors.iter().find(|monitor| {
            let x = f64::from(monitor.position().x);
            let y = f64::from(monitor.position().y);
            let width = f64::from(monitor.size().width);
            let height = f64::from(monitor.size().height);

            cursor.x >= x && cursor.x < x + width && cursor.y >= y && cursor.y < y + height
        }) {
            anchor_monitor = Some(found_monitor.clone());
        }
    }

    let monitor = anchor_monitor
        .ok_or_else(|| CaptureError::failed("No monitor available for quick editor placement"))?;
    let scale_factor = monitor.scale_factor();
    let work_area = monitor.work_area();

    let work_x = f64::from(work_area.position.x) / scale_factor;
    let work_y = f64::from(work_area.position.y) / scale_factor;
    let work_width = f64::from(work_area.size.width) / scale_factor;
    let work_height = f64::from(work_area.size.height) / scale_factor;

    Ok(QuickEditorWindowFrame {
        x: work_x.round(),
        y: work_y.round(),
        width: work_width.round(),
        height: work_height.round(),
    })
}

fn show_main_window<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) {
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn hide_main_window<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) {
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.hide();
    }
}

fn start_background_capture(app_handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        match capture_region_with_window(&app_handle) {
            Ok(data_url) => {
                let cursor = app_handle
                    .cursor_position()
                    .ok()
                    .map(|position| DesktopCursorPoint {
                        x: position.x,
                        y: position.y,
                    });
                let payload = CaptureReadyPayload { data_url, cursor };
                let _ = app_handle.emit(CAPTURE_READY_EVENT, payload);
            }
            Err(error) => {
                if error.code != "CaptureCancelled" {
                    show_main_window(&app_handle);
                }
                let _ = app_handle.emit(CAPTURE_ERROR_EVENT, error);
            }
        }
    });
}

#[cfg(all(desktop, target_os = "macos"))]
fn build_tray_menu(
    app_handle: &tauri::AppHandle,
    memory_label: &str,
) -> Result<tauri::menu::Menu<tauri::Wry>, tauri::Error> {
    let capture_item = tauri::menu::MenuItem::with_id(
        app_handle,
        TRAY_CAPTURE_MENU_ID,
        "Capture Region…",
        true,
        Option::<&str>::None,
    )?;
    let memory_item = tauri::menu::MenuItem::with_id(
        app_handle,
        TRAY_MEMORY_TOGGLE_ID,
        memory_label,
        true,
        Option::<&str>::None,
    )?;
    let show_item = tauri::menu::MenuItem::with_id(
        app_handle,
        TRAY_SHOW_MENU_ID,
        "Settings",
        true,
        Option::<&str>::None,
    )?;
    let screen_recording_settings_item = tauri::menu::MenuItem::with_id(
        app_handle,
        TRAY_SCREEN_RECORDING_SETTINGS_ID,
        "Screen Recording Settings…",
        true,
        Option::<&str>::None,
    )?;
    let quit_item = tauri::menu::MenuItem::with_id(
        app_handle,
        TRAY_QUIT_MENU_ID,
        "Quit VanillaShot",
        true,
        Option::<&str>::None,
    )?;

    let separator_primary = tauri::menu::PredefinedMenuItem::separator(app_handle)?;
    let separator_secondary = tauri::menu::PredefinedMenuItem::separator(app_handle)?;

    tauri::menu::Menu::with_items(
        app_handle,
        &[
            &capture_item,
            &memory_item,
            &separator_primary,
            &show_item,
            &screen_recording_settings_item,
            &separator_secondary,
            &quit_item,
        ],
    )
}

#[cfg(all(desktop, target_os = "macos"))]
fn tray_memory_label(app_handle: &tauri::AppHandle) -> &'static str {
    let state = app_handle.state::<memory::MemoryState>();
    if state.is_recording() {
        "⏹ Stop Memory"
    } else {
        "▶ Start Memory"
    }
}

#[cfg(all(desktop, target_os = "macos"))]
pub(crate) fn refresh_tray_menu(app_handle: &tauri::AppHandle) {
    if let Some(tray) = app_handle.tray_by_id("vanilla-shot-menubar") {
        if let Ok(menu) = build_tray_menu(app_handle, tray_memory_label(app_handle)) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

#[cfg(target_os = "macos")]
fn is_capture_cancelled(exit_code: Option<i32>, stderr: &str) -> bool {
    if exit_code == Some(1) {
        return true;
    }

    stderr.to_ascii_lowercase().contains("cancel")
}

#[cfg(target_os = "macos")]
fn is_screen_capture_permission_error(stderr: &str) -> bool {
    let normalized = stderr.to_ascii_lowercase();
    normalized.contains("not authorized")
        || normalized.contains("not permitted")
        || normalized.contains("permission")
        || normalized.contains("privacy")
        || normalized.contains("screen recording")
}

#[cfg(target_os = "macos")]
fn screen_recording_permission_message() -> &'static str {
    "VanillaShot needs macOS Screen Recording permission. Open System Settings > Privacy & Security > Screen & System Audio Recording, enable VanillaShot, then restart VanillaShot."
}

#[cfg(target_os = "macos")]
fn open_screen_recording_settings_impl() -> Result<(), CaptureError> {
    Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        .status()
        .map_err(|error| {
            CaptureError::failed(format!("Could not open Screen Recording settings: {error}"))
        })?;

    Ok(())
}

/// Handles one `vanillashot://` URL.
///
/// Any process on the machine can open a deep link, so the surface is kept to a
/// closed set of verbs that the tray menu already exposes. Nothing here accepts
/// a path, a payload, or anything else an untrusted caller could steer.
#[cfg(desktop)]
fn handle_deep_link(app_handle: &tauri::AppHandle, raw_url: &str) {
    let Some(action) = raw_url.trim().to_ascii_lowercase().strip_prefix("vanillashot://").map(
        |action| action.trim_matches('/').to_string(),
    ) else {
        return;
    };

    match action.as_str() {
        "capture" => start_background_capture(app_handle.clone()),
        "show" => show_main_window(app_handle),
        "memory/start" | "memory/stop" | "memory/toggle" => {
            let handle = app_handle.clone();
            let action = action.clone();
            tauri::async_runtime::spawn(async move {
                let recording = handle.state::<memory::MemoryState>().is_recording();
                // start and stop are idempotent; only toggle flips state.
                let start = match action.as_str() {
                    "memory/start" => !recording,
                    "memory/stop" => false,
                    _ => !recording,
                };
                let stop = match action.as_str() {
                    "memory/start" => false,
                    "memory/stop" => recording,
                    _ => recording,
                };

                if start {
                    let _ = memory::commands::memory_start(handle.state(), handle.clone()).await;
                } else if stop {
                    let _ = memory::commands::memory_stop(handle.state(), handle.clone()).await;
                }

                #[cfg(target_os = "macos")]
                refresh_tray_menu(&handle);
            });
        }
        other => {
            log::warn!("Ignoring unknown deep link action: vanillashot://{other}");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PendingQuickCaptureState::default())
        .manage(memory::MemoryState::new())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;

                app.handle().plugin(tauri_plugin_deep_link::init())?;

                let deep_link_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        handle_deep_link(&deep_link_handle, url.as_str());
                    }
                });
            }

            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Builder as ShortcutBuilder, ShortcutState};

                if let Some(main_window) = app.get_webview_window("main") {
                    let app_handle = app.handle().clone();
                    let _ = main_window.hide();
                    main_window.on_window_event(move |event| {
                        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            hide_main_window(&app_handle);
                        }
                    });
                }

                app.handle().plugin(
                    ShortcutBuilder::new()
                        .with_shortcuts(GLOBAL_SHORTCUT_ACCELERATORS)?
                        .with_handler(|app, _shortcut, event| {
                            if event.state != ShortcutState::Pressed {
                                return;
                            }

                            start_background_capture(app.clone());
                        })
                        .build(),
                )?;
            }

            #[cfg(all(desktop, target_os = "macos"))]
            {
                use tauri::tray::TrayIconBuilder;

                // Keep VanillaShot as a background utility (menu bar style) instead of a regular Dock app.
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);

                if let Some(main_window) = app.get_webview_window("main") {
                    let _ = main_window.set_skip_taskbar(true);
                }

                let tray_menu = build_tray_menu(app.handle(), tray_memory_label(app.handle()))?;

                let tray_icon = app
                    .default_window_icon()
                    .cloned()
                    .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;

                let _ = TrayIconBuilder::with_id("vanilla-shot-menubar")
                    .icon(tray_icon)
                    .tooltip("VanillaShot")
                    .menu(&tray_menu)
                    .show_menu_on_left_click(true)
                    .on_menu_event(move |app_handle, menu_event| {
                        if menu_event.id == TRAY_QUIT_MENU_ID {
                            app_handle.exit(0);
                            return;
                        }

                        if menu_event.id == TRAY_CAPTURE_MENU_ID {
                            start_background_capture(app_handle.clone());
                            return;
                        }

                        if menu_event.id == TRAY_MEMORY_TOGGLE_ID {
                            let handle = app_handle.clone();
                            tauri::async_runtime::spawn(async move {
                                let state = handle.state::<memory::MemoryState>();
                                if state.is_recording() {
                                    let _ = memory::commands::memory_stop(
                                        handle.state(),
                                        handle.clone(),
                                    )
                                    .await;
                                } else {
                                    let _ = memory::commands::memory_start(
                                        handle.state(),
                                        handle.clone(),
                                    )
                                    .await;
                                }
                                refresh_tray_menu(&handle);
                            });
                            return;
                        }

                        if menu_event.id == TRAY_SHOW_MENU_ID {
                            show_main_window(app_handle);
                            return;
                        }

                        if menu_event.id == TRAY_SCREEN_RECORDING_SETTINGS_ID {
                            let _ = open_screen_recording_settings_impl();
                        }
                    })
                    .build(app.handle())?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            capture_region,
            save_capture_png,
            copy_capture_png,
            show_main_capture_window,
            hide_main_capture_window,
            open_screen_recording_settings,
            screen_recording_access_granted,
            capture_output_dir,
            open_project_page,
            open_quick_capture_window,
            take_pending_quick_capture,
            memory::commands::memory_start,
            memory::commands::memory_stop,
            memory::commands::memory_status,
            memory::commands::memory_open_path_in_finder,
            memory::commands::memory_search,
            memory::commands::memory_get_frame,
            memory::commands::memory_get_timeline,
            memory::commands::memory_get_segment,
            memory::commands::memory_purge
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
