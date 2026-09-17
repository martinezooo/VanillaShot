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

mod diag;
mod memory;

#[allow(dead_code)] // used only by the non-macOS capture path
const CAPTURE_READY_EVENT: &str = "capture://ready";
const QUICK_EDITOR_CAPTURE_READY_EVENT: &str = "capture://quick-editor-ready";
const CAPTURE_ERROR_EVENT: &str = "capture://error";
const GLOBAL_SHORTCUT_ACCELERATORS: [&str; 2] = ["cmd+shift+1", "ctrl+shift+1"];
const QUICK_EDITOR_WINDOW_LABEL: &str = "quick-editor";
const CAPTURE_OVERLAY_WINDOW_LABEL: &str = "capture-overlay";
const FROZEN_PAYLOAD_EVENT: &str = "frozen://payload";
#[cfg(all(desktop, target_os = "macos"))]
const TRAY_CAPTURE_MENU_ID: &str = "tray_capture_region";
#[cfg(all(desktop, target_os = "macos"))]
const TRAY_QUIT_MENU_ID: &str = "tray_quit";
#[cfg(all(desktop, target_os = "macos"))]
const TRAY_MEMORY_TOGGLE_ID: &str = "tray_memory_toggle";
#[cfg(all(desktop, target_os = "macos"))]
const TRAY_SHOW_MENU_ID: &str = "tray_show";

#[derive(Default)]
struct PendingQuickCaptureState {
    payload: Mutex<Option<CaptureReadyPayload>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FrozenCapturePayload {
    image_data_url: String,
    width: u32,
    height: u32,
    scale_factor: f64,
    cursor: Option<DesktopCursorPoint>,
}

#[derive(Default)]
struct PendingFrozenCaptureState {
    payload: Mutex<Option<FrozenCapturePayload>>,
}

/// Counts captures, so the watchdog can tell "the overlay never appeared" from
/// "the overlay appeared and the user was quick".
///
/// Asking the window whether it is visible cannot tell those apart: a finished
/// or cancelled capture hides the overlay again, so a user who selects inside
/// the timeout looks exactly like one who never saw it. That mistake produced
/// 32 false alarms before this counter replaced it.
#[cfg(target_os = "macos")]
static CAPTURE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(target_os = "macos")]
static OVERLAY_SHOWN_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

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
    const PROJECT_URL: &str = "https://github.com/martinezooo/VanillaShot";

    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/open")
            .arg(PROJECT_URL)
            .status()
            .map_err(|error| CaptureError::failed(format!("Could not open the project page: {error}")))?;

        Ok(())
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
        log::info!(target: diag::CAPTURE, "Handing the capture to the open editor window");
        // Before the payload, not after: the editor reveals itself as soon as
        // it has the image, and it must already be on the right display by then.
        #[cfg(target_os = "macos")]
        place_editor_under_pointer(&existing);
        if let Err(e) = existing.emit(QUICK_EDITOR_CAPTURE_READY_EVENT, payload) {
            log::error!(target: diag::CAPTURE, "The editor window did not take the capture: {e}");
        }
        return Ok(());
    }

    // No editor window yet, so this capture waits in the pending slot until the
    // new window's webview has booted and collects it. That handover is slower
    // and has more that can go wrong than handing it to an open window.
    log::info!(target: diag::CAPTURE, "No editor window yet, building one (cold start)");

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
    // This window is intentionally reused while hidden. It must still receive
    // the next capture event. WebKit's default inactive policy may suspend or
    // unload a hidden view, leaving the editor unable to wake itself back up.
    .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
    .background_color(tauri::window::Color(0, 0, 0, 0));

    #[cfg(target_os = "macos")]
    {
        builder = builder.visible_on_all_workspaces(true);
    }

    let _window = builder.build().map_err(|error| {
        log::error!(target: diag::CAPTURE, "Could not build the editor window: {error}");
        CaptureError::failed(format!("Could not open quick editor window: {error}"))
    })?;
    // The builder works in logical units, which the toolkit converts through
    // the scale factor of whichever display it thinks the new window is on.
    // Restate the frame in points so it lands on the display the capture came
    // from, whatever that conversion did.
    #[cfg(target_os = "macos")]
    place_editor_under_pointer(&_window);
    log::info!(
        target: diag::CAPTURE,
        "Editor window built, waiting for its webview to collect the capture"
    );
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

/// Geometry of one display, in the coordinate space `screencapture -R` uses.
///
/// Bounds are in global points with the main display's top-left at the origin,
/// which is what Core Graphics reports and what the screencapture region flag
/// expects. `scale` is the display's own backing factor, native pixels per
/// point, which differs per display on a mixed-DPI desktop.
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy)]
struct DisplayGeometry {
    id: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
}

#[cfg(target_os = "macos")]
impl DisplayGeometry {
    /// One-line form for the log. Every capture problem so far has been a
    /// coordinate problem, so the numbers go on the record every time.
    fn describe(&self) -> String {
        format!(
            "#{} {:.0}x{:.0} at ({:.0},{:.0}) scale {:.2} ({:.0}x{:.0} px)",
            self.id,
            self.width,
            self.height,
            self.x,
            self.y,
            self.scale,
            self.width * self.scale,
            self.height * self.scale
        )
    }

    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }
}

/// Core Graphics display and pointer queries.
///
/// The window toolkit reports each monitor's origin scaled by that monitor's
/// own backing factor, while the pointer comes back scaled by the main
/// display's. On a mixed-DPI setup, a 2x laptop next to a 1x ultrawide, those
/// two spaces disagree and every hit test lands on the main display. Core
/// Graphics reports both in global points, so they agree by construction, and
/// it is the same space `screencapture -R` reads.
#[cfg(target_os = "macos")]
mod cg {
    use super::DisplayGeometry;

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct CGPoint {
        pub x: f64,
        pub y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGSize {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventCreate(source: *const std::ffi::c_void) -> *mut std::ffi::c_void;
        fn CGEventGetLocation(event: *mut std::ffi::c_void) -> CGPoint;
        fn CGGetActiveDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
        fn CGDisplayBounds(display: u32) -> CGRect;
        fn CGMainDisplayID() -> u32;
        fn CGDisplayCopyDisplayMode(display: u32) -> *mut std::ffi::c_void;
        fn CGDisplayModeGetPixelWidth(mode: *mut std::ffi::c_void) -> usize;
        fn CGDisplayModeRelease(mode: *mut std::ffi::c_void);
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *mut std::ffi::c_void);
    }

    /// Where the pointer is, in global points.
    pub fn pointer_location() -> Option<CGPoint> {
        unsafe {
            let event = CGEventCreate(std::ptr::null());
            if event.is_null() {
                return None;
            }
            let point = CGEventGetLocation(event);
            CFRelease(event);
            Some(point)
        }
    }

    fn describe(id: u32) -> Option<DisplayGeometry> {
        unsafe {
            let b = CGDisplayBounds(id);
            if b.size.width <= 0.0 || b.size.height <= 0.0 {
                return None;
            }
            let mode = CGDisplayCopyDisplayMode(id);
            if mode.is_null() {
                return None;
            }
            let native_width = CGDisplayModeGetPixelWidth(mode) as u32;
            CGDisplayModeRelease(mode);
            Some(DisplayGeometry {
                id,
                x: b.origin.x,
                y: b.origin.y,
                width: b.size.width,
                height: b.size.height,
                scale: f64::from(native_width) / b.size.width,
            })
        }
    }

    /// Every display currently attached, in the order Core Graphics lists them.
    pub fn active_displays() -> Vec<DisplayGeometry> {
        unsafe {
            let mut count: u32 = 0;
            if CGGetActiveDisplayList(0, std::ptr::null_mut(), &mut count) != 0 || count == 0 {
                return Vec::new();
            }
            let mut ids = vec![0u32; count as usize];
            if CGGetActiveDisplayList(count, ids.as_mut_ptr(), &mut count) != 0 {
                return Vec::new();
            }
            ids.truncate(count as usize);
            ids.into_iter().filter_map(describe).collect()
        }
    }

    /// The main display, the one AppKit measures its frames from.
    pub fn main_display() -> Option<DisplayGeometry> {
        unsafe { describe(CGMainDisplayID()) }
    }

    /// The display the pointer is on, without logging. `display_under_pointer`
    /// wraps this with the running commentary the capture path wants.
    pub fn display_containing_pointer() -> Option<DisplayGeometry> {
        let point = pointer_location()?;
        active_displays()
            .into_iter()
            .find(|d| d.contains(point.x, point.y))
            .or_else(main_display)
    }
}

/// Finds the display the pointer is on, and records how it decided.
///
/// Logs the pointer and every attached display on each capture. When a capture
/// lands on the wrong screen, this is the line that says whether the pointer
/// was read wrong or the hit test was.
#[cfg(target_os = "macos")]
fn display_under_pointer() -> Option<DisplayGeometry> {
    let displays = cg::active_displays();
    let pointer = cg::pointer_location();

    if displays.is_empty() {
        log::error!(target: diag::DISPLAY, "Core Graphics listed no active displays");
        return None;
    }

    match pointer {
        Some(p) => log::info!(
            target: diag::DISPLAY,
            "Pointer at ({:.0},{:.0}), {} display(s): {}",
            p.x,
            p.y,
            displays.len(),
            displays
                .iter()
                .map(DisplayGeometry::describe)
                .collect::<Vec<_>>()
                .join(" | ")
        ),
        None => log::warn!(
            target: diag::DISPLAY,
            "Pointer location unavailable, {} display(s): {}",
            displays.len(),
            displays
                .iter()
                .map(DisplayGeometry::describe)
                .collect::<Vec<_>>()
                .join(" | ")
        ),
    }

    if let Some(p) = pointer {
        if let Some(hit) = displays.iter().find(|d| d.contains(p.x, p.y)) {
            log::info!(target: diag::DISPLAY, "Capturing display {}", hit.describe());
            return Some(*hit);
        }
        // The pointer sits in the gap between two displays, or in a region no
        // display claims. Falling back is correct, but it is also exactly the
        // symptom of "it used the laptop even though the cursor was elsewhere",
        // so say so rather than failing over quietly.
        log::warn!(
            target: diag::DISPLAY,
            "Pointer ({:.0},{:.0}) is outside every display, falling back to the main one",
            p.x,
            p.y
        );
    }

    let fallback = cg::main_display();
    match &fallback {
        Some(d) => log::info!(target: diag::DISPLAY, "Capturing main display {}", d.describe()),
        None => log::error!(target: diag::DISPLAY, "Could not read the main display"),
    }
    fallback
}

/// Puts the overlay exactly over one display, using AppKit rather than the
/// window toolkit, and checks that it landed.
///
/// The toolkit converts any frame it is given through the scale factor of the
/// monitor the window currently sits on, not the one it is moving to. With a 2x
/// laptop beside a 1x ultrawide that is wrong by a factor of two, which showed
/// up as an overlay covering half the ultrawide, or spilling past the laptop
/// screen, depending on which way the window was travelling. Correcting by the
/// observed error does not converge either, because position and size are both
/// converted and each move changes which monitor the next conversion uses.
///
/// AppKit frames are in points with no conversion, so the frame lands where it
/// is put. The only adjustment needed is the flip from Core Graphics, which
/// measures down from the top of the main display, to AppKit, which measures up
/// from its bottom.
///
/// The frame is read back after the move. AppKit will quietly clamp a frame it
/// dislikes, and a clamped frame is what a half-covered display looks like, so
/// the readback is logged and a mismatch is an error in the log rather than a
/// silent wrong-sized overlay.
#[cfg(target_os = "macos")]
fn place_overlay_on_display(window: &WebviewWindow, display: &DisplayGeometry) -> bool {
    let Some(primary) = cg::main_display() else {
        log::error!(
            target: diag::OVERLAY,
            "Cannot place the overlay: the main display height is unreadable"
        );
        return false;
    };
    // Core Graphics measures down from the top of the main display, AppKit
    // measures up from its bottom.
    let flipped_y = primary.height - display.y - display.height;
    let frame = (display.x, flipped_y, display.width, display.height);

    log::info!(
        target: diag::OVERLAY,
        "Placing overlay on display #{} at AppKit frame ({:.0},{:.0}) {:.0}x{:.0}",
        display.id,
        frame.0,
        frame.1,
        frame.2,
        frame.3
    );

    let window = window.clone();
    // AppKit is main-thread only. Touching NSWindow from the capture task kills
    // the process outright, which looked like the app silently doing nothing.
    let dispatched = window
        .clone()
        .run_on_main_thread(move || {
            use objc2_app_kit::NSWindow;
            use objc2_foundation::{NSPoint, NSRect, NSSize};

            let ptr = match window.ns_window() {
                Ok(ptr) => ptr,
                Err(e) => {
                    log::error!(target: diag::OVERLAY, "No NSWindow for the overlay: {e}");
                    return;
                }
            };
            if ptr.is_null() {
                log::error!(target: diag::OVERLAY, "Overlay NSWindow pointer is null");
                return;
            }
            unsafe {
                let ns_window = &*(ptr as *const NSWindow);
                ns_window.setFrame_display(
                    NSRect::new(NSPoint::new(frame.0, frame.1), NSSize::new(frame.2, frame.3)),
                    true,
                );

                let actual = ns_window.frame();
                let off = (actual.origin.x - frame.0).abs().max(
                    (actual.origin.y - frame.1)
                        .abs()
                        .max((actual.size.width - frame.2).abs())
                        .max((actual.size.height - frame.3).abs()),
                );
                if off > 1.0 {
                    log::error!(
                        target: diag::OVERLAY,
                        "Overlay frame did not stick: asked for ({:.0},{:.0}) {:.0}x{:.0}, got ({:.0},{:.0}) {:.0}x{:.0}",
                        frame.0,
                        frame.1,
                        frame.2,
                        frame.3,
                        actual.origin.x,
                        actual.origin.y,
                        actual.size.width,
                        actual.size.height
                    );
                } else {
                    log::debug!(
                        target: diag::OVERLAY,
                        "Overlay frame confirmed at ({:.0},{:.0}) {:.0}x{:.0}",
                        actual.origin.x,
                        actual.origin.y,
                        actual.size.width,
                        actual.size.height
                    );
                }
            }
        })
        .is_ok();

    if !dispatched {
        log::error!(
            target: diag::OVERLAY,
            "Could not reach the main thread to place the overlay"
        );
    }
    dispatched
}

/// Moves the quick editor onto the display the pointer is on.
///
/// The editor used to be placed once, when its window was first built, from a
/// frame worked out through the window toolkit. That had the same two faults as
/// the old overlay placement: the pointer and the monitor origins are reported
/// in different coordinate spaces, so the hit test fell through to the main
/// display, and the frame was then converted through the scale factor of
/// whichever monitor the window already sat on.
///
/// The visible result was not an error. The editor opened at full size on the
/// built-in screen while the user was working on the external one, so from
/// their side a capture simply produced nothing. Every capture now re-places the
/// window, because the right display is a property of the capture, not of when
/// the window happened to be created.
///
/// The frame comes from `NSScreen.visibleFrame`, which already excludes the
/// menu bar and the Dock, rather than from arithmetic on the full bounds.
#[cfg(target_os = "macos")]
fn place_editor_under_pointer(window: &WebviewWindow) -> bool {
    let Some(display) = cg::display_containing_pointer() else {
        log::error!(target: diag::CAPTURE, "No display under the pointer to put the editor on");
        return false;
    };
    let Some(primary) = cg::main_display() else {
        log::error!(target: diag::CAPTURE, "Cannot place the editor: the main display is unreadable");
        return false;
    };

    // Core Graphics measures down from the top of the main display, AppKit
    // measures up from its bottom.
    let flipped_y = primary.height - display.y - display.height;
    let target = (display.x, flipped_y, display.width, display.height);
    log::info!(
        target: diag::CAPTURE,
        "Putting the editor on display {}",
        display.describe()
    );

    let window = window.clone();
    window
        .clone()
        .run_on_main_thread(move || {
            use objc2_app_kit::{NSScreen, NSWindow};
            use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};

            let ptr = match window.ns_window() {
                Ok(ptr) => ptr,
                Err(e) => {
                    log::error!(target: diag::CAPTURE, "No NSWindow for the editor: {e}");
                    return;
                }
            };
            if ptr.is_null() {
                log::error!(target: diag::CAPTURE, "Editor NSWindow pointer is null");
                return;
            }

            // run_on_main_thread already guarantees this.
            let Some(mtm) = MainThreadMarker::new() else {
                log::error!(target: diag::CAPTURE, "Editor placement is not on the main thread");
                return;
            };

            // Match the target display to its NSScreen by frame, then take the
            // area that excludes the menu bar and the Dock.
            let mut frame = NSRect::new(
                NSPoint::new(target.0, target.1),
                NSSize::new(target.2, target.3),
            );
            let mut matched = false;
            for screen in NSScreen::screens(mtm).iter() {
                let f = screen.frame();
                if (f.origin.x - target.0).abs() <= 1.0 && (f.origin.y - target.1).abs() <= 1.0 {
                    frame = screen.visibleFrame();
                    matched = true;
                    break;
                }
            }
            if !matched {
                log::warn!(
                    target: diag::CAPTURE,
                    "No NSScreen matches the target display, using its full bounds"
                );
            }

            unsafe {
                let ns_window = &*(ptr as *const NSWindow);
                ns_window.setFrame_display(frame, true);

                let actual = ns_window.frame();
                let off = (actual.origin.x - frame.origin.x)
                    .abs()
                    .max((actual.origin.y - frame.origin.y).abs())
                    .max((actual.size.width - frame.size.width).abs())
                    .max((actual.size.height - frame.size.height).abs());
                if off > 1.0 {
                    log::error!(
                        target: diag::CAPTURE,
                        "Editor frame did not stick: asked for ({:.0},{:.0}) {:.0}x{:.0}, got ({:.0},{:.0}) {:.0}x{:.0}",
                        frame.origin.x,
                        frame.origin.y,
                        frame.size.width,
                        frame.size.height,
                        actual.origin.x,
                        actual.origin.y,
                        actual.size.width,
                        actual.size.height
                    );
                } else {
                    log::info!(
                        target: diag::CAPTURE,
                        "Editor placed at ({:.0},{:.0}) {:.0}x{:.0}",
                        actual.origin.x,
                        actual.origin.y,
                        actual.size.width,
                        actual.size.height
                    );
                }
            }
        })
        .is_ok()
}

/// Grabs a still of the given display region (logical points) into a data URL.
#[cfg(target_os = "macos")]
fn capture_display_still(x: f64, y: f64, w: f64, h: f64) -> Result<(String, u32, u32), CaptureError> {
    let file_path = std::env::temp_dir().join(format!(
        "vanilla-shot-frozen-{}-{}.png",
        std::process::id(),
        epoch_millis()
    ));

    let region = format!(
        "{},{},{},{}",
        x.round() as i64,
        y.round() as i64,
        w.round() as i64,
        h.round() as i64
    );

    let started = std::time::Instant::now();
    let output = Command::new("/usr/sbin/screencapture")
        .args(["-x", "-r", "-R", &region])
        .arg(&file_path)
        .output()
        .map_err(|e| {
            log::error!(target: diag::CAPTURE, "Could not launch screencapture: {e}");
            CaptureError::failed(format!("Failed to launch screencapture: {e}"))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let _ = fs::remove_file(&file_path);
        log::error!(
            target: diag::CAPTURE,
            "screencapture -R {region} exited with {:?}: {stderr}",
            output.status.code()
        );
        if is_screen_capture_permission_error(&stderr) {
            return Err(CaptureError::failed(screen_recording_permission_message()));
        }
        return Err(CaptureError::failed(format!(
            "screencapture failed while freezing the screen: {stderr}"
        )));
    }

    let bytes = fs::read(&file_path).map_err(|e| {
        log::error!(target: diag::CAPTURE, "Could not read the still at {}: {e}", file_path.display());
        CaptureError::failed(format!("Failed to read frozen capture: {e}"))
    })?;
    let _ = fs::remove_file(&file_path);
    if bytes.is_empty() {
        // screencapture reports success and writes nothing when Screen
        // Recording was revoked after launch. Worth its own line, because the
        // user sees the same "nothing happened" as for a real crash.
        log::error!(
            target: diag::CAPTURE,
            "screencapture wrote an empty file, which means Screen Recording is not granted"
        );
        return Err(CaptureError::failed(screen_recording_permission_message()));
    }

    let (width, height) = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .map_err(|e| {
            log::error!(target: diag::CAPTURE, "Could not decode the still: {e}");
            CaptureError::failed(format!("Failed to decode frozen capture: {e}"))
        })?
        .dimensions();

    log::info!(
        target: diag::CAPTURE,
        "Still of region {region} is {width}x{height} px, {} KB, took {} ms",
        bytes.len() / 1024,
        started.elapsed().as_millis()
    );

    Ok((
        format!("data:image/png;base64,{}", STANDARD.encode(bytes)),
        width,
        height,
    ))
}

/// Opens the frozen-selection overlay: hides the app, freezes the display under
/// the cursor, and shows a full-display window the user selects a region on.
#[cfg(target_os = "macos")]
fn start_frozen_capture(app_handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        let seq = CAPTURE_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        log::info!(target: diag::CAPTURE, "Capture #{seq} requested");

        if !screen_recording_access_granted_impl() {
            log::error!(target: diag::CAPTURE, "Screen Recording is not granted, capture stopped");
            show_main_window(&app_handle);
            let _ = app_handle.emit(
                CAPTURE_ERROR_EVENT,
                CaptureError::failed(screen_recording_permission_message()),
            );
            return;
        }

        let cursor = app_handle.cursor_position().ok().map(|p| DesktopCursorPoint {
            x: p.x,
            y: p.y,
        });

        // Hide any visible app window so it is never in the still. When the app
        // is triggered from the tray with nothing on screen (the common case),
        // there is nothing to hide and no need to wait for a hide to composite.
        let mut hid_a_window = false;
        for label in ["main", QUICK_EDITOR_WINDOW_LABEL] {
            if let Some(w) = app_handle.get_webview_window(label) {
                if w.is_visible().unwrap_or(false) {
                    let _ = w.hide();
                    hid_a_window = true;
                }
            }
        }
        if hid_a_window {
            log::debug!(target: diag::CAPTURE, "Hid a visible window before freezing");
            // Give the compositor a moment to drop the just-hidden window.
            std::thread::sleep(Duration::from_millis(60));
        }

        let Some(display) = display_under_pointer() else {
            log::error!(target: diag::CAPTURE, "No display to capture, capture stopped");
            let _ = app_handle.emit(
                CAPTURE_ERROR_EVENT,
                CaptureError::failed("Could not find the display under the pointer"),
            );
            return;
        };
        let scale = display.scale;

        let still = capture_display_still(display.x, display.y, display.width, display.height);
        let (image_data_url, width, height) = match still {
            Ok(v) => v,
            Err(e) => {
                log::error!(target: diag::CAPTURE, "Freezing the screen failed: {}", e.message);
                let _ = app_handle.emit(CAPTURE_ERROR_EVENT, e);
                return;
            }
        };

        // The still should be the display's point size times its backing
        // factor. When it is not, the region and the display disagree, which is
        // what a half-covered or wrong-screen capture looks like further down.
        let expected = (
            (display.width * scale).round() as u32,
            (display.height * scale).round() as u32,
        );
        if (width, height) != expected {
            log::error!(
                target: diag::CAPTURE,
                "Still is {width}x{height} px but display #{} at scale {scale:.2} should give {}x{}",
                display.id,
                expected.0,
                expected.1
            );
        }

        let payload = FrozenCapturePayload {
            image_data_url,
            width,
            height,
            scale_factor: scale,
            cursor,
        };

        if let Some(state) = app_handle.try_state::<PendingFrozenCaptureState>() {
            if let Ok(mut pending) = state.payload.lock() {
                *pending = Some(payload.clone());
            }
        }

        // Reuse the pre-warmed overlay when present so the hot path never pays
        // for a webview boot. Otherwise build one now. Either way the overlay
        // stays hidden until its webview has painted the still and shows itself
        // via frozen_ready_to_show, so the user never sees a blank flash.
        if let Some(overlay) = app_handle.get_webview_window(CAPTURE_OVERLAY_WINDOW_LABEL) {
            log::debug!(target: diag::OVERLAY, "Reusing the pre-warmed overlay");
            place_overlay_on_display(&overlay, &display);
            if let Err(e) = overlay.emit(FROZEN_PAYLOAD_EVENT, payload.clone()) {
                // The overlay window exists but its webview is not listening.
                // It then sits there hidden and the capture never appears,
                // which is the silent failure this log is here to catch.
                log::error!(target: diag::OVERLAY, "Could not hand the still to the overlay: {e}");
            }
        } else if let Err(e) = {
            log::info!(target: diag::OVERLAY, "No pre-warmed overlay, building one now");
            build_frozen_overlay(&app_handle, &display)
        } {
            log::error!(target: diag::OVERLAY, "Could not build the overlay: {e}");
            show_main_window(&app_handle);
            let _ = app_handle.emit(
                CAPTURE_ERROR_EVENT,
                CaptureError::failed(format!("Could not open the capture overlay: {e}")),
            );
            return;
        }

        log::info!(
            target: diag::CAPTURE,
            "Still handed to the overlay {} ms after the shortcut",
            started.elapsed().as_millis()
        );

        // The overlay reveals itself once its webview has painted the still. If
        // that handshake never completes, the window stays hidden and the user
        // sees nothing at all: no overlay, no editor, no error. Check back and
        // name the step that stalled, so "nothing happened" stops being the
        // whole bug report.
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            if OVERLAY_SHOWN_SEQ.load(std::sync::atomic::Ordering::SeqCst) < seq {
                log::error!(
                    target: diag::OVERLAY,
                    "Capture #{seq}: the overlay never appeared. Its webview did not call frozen_ready_to_show within 1.5 s, so it either failed to load or threw while decoding the still."
                );
            }
        });
    });
}

/// Builds the frozen-capture overlay window, hidden. The webview shows it once
/// it has painted the still (frozen_ready_to_show). Used both to pre-warm the
/// overlay at startup and as the cold fallback if the warm one is gone.
#[cfg(target_os = "macos")]
fn build_frozen_overlay(
    app_handle: &tauri::AppHandle,
    display: &DisplayGeometry,
) -> tauri::Result<()> {
    let mut builder = WebviewWindowBuilder::new(
        app_handle,
        CAPTURE_OVERLAY_WINDOW_LABEL,
        WebviewUrl::default(),
    )
    .title("VanillaShot Capture")
    .inner_size(display.width, display.height)
    .position(display.x, display.y)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .visible(false)
    .shadow(false)
    // The overlay receives and decodes a frozen-screen payload before it is
    // shown. Suspending hidden JavaScript deadlocks that handshake because the
    // frontend cannot call `frozen_ready_to_show` until it runs again.
    .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled);

    builder = builder.visible_on_all_workspaces(true);
    let window = builder.build()?;

    // The builder takes logical units, which means it applies a scale factor of
    // its own choosing. On a mixed-DPI desktop that lands the overlay on the
    // wrong display, or covering part of the right one. Restate the frame in
    // physical units, which is the space available_monitors reported it in.
    place_overlay_on_display(&window, display);
    Ok(())
}

/// Pre-creates the overlay window (hidden) so the first capture is as fast as
/// the rest. Safe to call when one already exists.
#[cfg(target_os = "macos")]
fn prewarm_frozen_overlay(app_handle: &tauri::AppHandle) {
    if app_handle
        .get_webview_window(CAPTURE_OVERLAY_WINDOW_LABEL)
        .is_some()
    {
        return;
    }
    match display_under_pointer() {
        Some(display) => {
            if let Err(e) = build_frozen_overlay(app_handle, &display) {
                log::error!(target: diag::OVERLAY, "Could not pre-warm the overlay: {e}");
            } else {
                log::info!(target: diag::OVERLAY, "Overlay pre-warmed");
            }
        }
        None => log::warn!(target: diag::OVERLAY, "No display to pre-warm the overlay on"),
    }
}

/// The overlay's webview has painted the still. Reveal the (until now hidden)
/// window. Called from FrozenCapture once the image has decoded.
#[tauri::command]
fn frozen_ready_to_show(app_handle: tauri::AppHandle) {
    let Some(overlay) = app_handle.get_webview_window(CAPTURE_OVERLAY_WINDOW_LABEL) else {
        log::error!(target: diag::OVERLAY, "Overlay asked to be shown but the window is gone");
        return;
    };
    if let Err(e) = overlay.show() {
        log::error!(target: diag::OVERLAY, "Could not show the overlay: {e}");
        return;
    }
    let _ = overlay.set_focus();
    let _ = overlay.set_always_on_top(true);
    let seq = CAPTURE_SEQ.load(std::sync::atomic::Ordering::SeqCst);
    OVERLAY_SHOWN_SEQ.store(seq, std::sync::atomic::Ordering::SeqCst);
    log::info!(target: diag::OVERLAY, "Capture #{seq}: overlay shown");
}

#[tauri::command]
fn take_pending_frozen_capture(
    #[allow(unused_variables)] window: WebviewWindow,
    state: tauri::State<'_, PendingFrozenCaptureState>,
) -> Result<Option<FrozenCapturePayload>, CaptureError> {
    if window.label() != CAPTURE_OVERLAY_WINDOW_LABEL {
        return Ok(None);
    }
    let mut pending = state
        .payload
        .lock()
        .map_err(|_| CaptureError::failed("Could not read pending frozen capture"))?;
    Ok(pending.take())
}

/// Starts a region capture (the frozen overlay on macOS). Fire-and-forget:
/// the overlay opens the editor itself once a region is chosen.
#[tauri::command]
fn begin_capture(app_handle: tauri::AppHandle) {
    start_background_capture(app_handle);
}

#[tauri::command]
fn cancel_frozen_capture(app_handle: tauri::AppHandle) {
    log::info!(target: diag::CAPTURE, "Capture cancelled");
    if let Some(overlay) = app_handle.get_webview_window(CAPTURE_OVERLAY_WINDOW_LABEL) {
        let _ = overlay.hide();
    }
}

#[tauri::command]
fn finish_frozen_capture(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, PendingQuickCaptureState>,
    data_url: String,
    cursor: Option<DesktopCursorPoint>,
) -> Result<(), CaptureError> {
    if let Some(overlay) = app_handle.get_webview_window(CAPTURE_OVERLAY_WINDOW_LABEL) {
        let _ = overlay.hide();
    }
    match decode_png_dimensions(&data_url) {
        Ok((w, h)) => log::info!(target: diag::CAPTURE, "Selection cropped to {w}x{h} px, opening the editor"),
        Err(e) => log::error!(target: diag::CAPTURE, "Selection is not a readable PNG: {}", e.message),
    }
    open_quick_capture_window(app_handle, state, data_url, cursor).inspect_err(|e| {
        log::error!(target: diag::CAPTURE, "Could not open the editor: {}", e.message);
    })
}

fn start_background_capture(app_handle: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        start_frozen_capture(app_handle);
    }

    #[cfg(not(target_os = "macos"))]
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
        "Settings…",
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
            &separator_secondary,
            &quit_item,
        ],
    )
}

#[cfg(all(desktop, target_os = "macos"))]
fn tray_memory_label(app_handle: &tauri::AppHandle) -> &'static str {
    let state = app_handle.state::<memory::MemoryState>();
    if state.is_recording() {
        "Stop Screen Memory"
    } else {
        "Start Screen Memory"
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
                // start and stop are idempotent. Only toggle flips state.
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
        .manage(PendingFrozenCaptureState::default())
        .manage(memory::MemoryState::new())
        .setup(|app| {
            // First thing in setup, so anything that fails after this point
            // leaves a trace. Capture runs with no window on screen, so the log
            // file is the only place a failure can be reported.
            app.handle().plugin(diag::plugin())?;
            log::info!(
                target: diag::CAPTURE,
                "VanillaShot {} starting, log level {}",
                app.package_info().version,
                log::max_level()
            );
            if let Some(path) = diag::log_file_path(app.handle()) {
                log::info!(target: diag::CAPTURE, "Logging to {}", path.display());
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

                // Pre-warm the capture overlay (hidden) so the first frozen
                // capture pays no webview boot on the hot path.
                prewarm_frozen_overlay(app.handle());

                let tray_menu = build_tray_menu(app.handle(), tray_memory_label(app.handle()))?;

                // A monochrome template image, so the menu bar renders it in the bar's
                // own colour (black on light, white on dark) like every native
                // status item - not the colourful app icon.
                let tray_rgba = image::load_from_memory(include_bytes!(
                    "../icons/tray-template.png"
                ))
                .map_err(|e| tauri::Error::AssetNotFound(format!("tray icon: {e}")))?
                .to_rgba8();
                let (tray_w, tray_h) = tray_rgba.dimensions();
                let tray_icon = tauri::image::Image::new_owned(tray_rgba.into_raw(), tray_w, tray_h);

                let _ = TrayIconBuilder::with_id("vanilla-shot-menubar")
                    .icon(tray_icon)
                    .icon_as_template(true)
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
            take_pending_frozen_capture,
            frozen_ready_to_show,
            finish_frozen_capture,
            cancel_frozen_capture,
            begin_capture,
            diag::diagnostics_info,
            diag::diagnostics_read_log,
            diag::log_from_webview,
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
