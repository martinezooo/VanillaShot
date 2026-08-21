use std::path::{Path, PathBuf};
use std::process::Command;

/// Compiles the Swift helpers at build time so the app ships pre-built,
/// code-signed binaries instead of compiling executables into a user-writable
/// folder at runtime. Also removes the end-user dependency on the Xcode
/// Command Line Tools.
#[cfg(target_os = "macos")]
fn build_swift_helpers() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let scripts = manifest.join("scripts");
    let out_dir = manifest.join("gen").join("helpers");
    std::fs::create_dir_all(&out_dir).expect("create gen/helpers");

    let helpers: [(&str, &str, &[&str]); 2] = [
        (
            "ocr_vision.swift",
            "ocr_vision",
            &["Vision", "CoreGraphics", "ImageIO"],
        ),
        (
            "vanilla_shot_recorder.swift",
            "vanilla_shot_recorder",
            &[
                "ScreenCaptureKit",
                "AVFoundation",
                "CoreMedia",
                "CoreGraphics",
                "CoreImage",
            ],
        ),
    ];

    for (source_name, bin_name, frameworks) in helpers {
        let source = scripts.join(source_name);
        let output = out_dir.join(bin_name);
        println!("cargo:rerun-if-changed={}", source.display());

        if is_fresh(&output, &source) {
            continue;
        }

        let mut cmd = Command::new("swiftc");
        cmd.arg("-O");
        for framework in frameworks {
            cmd.args(["-framework", framework]);
        }
        cmd.arg("-o").arg(&output).arg(&source);

        let status = cmd
            .status()
            .expect("swiftc is required to build VanillaShot's Swift helpers (install Xcode Command Line Tools)");
        assert!(status.success(), "swiftc failed for {source_name}");
    }
}

#[cfg(target_os = "macos")]
fn is_fresh(output: &Path, source: &Path) -> bool {
    let (Ok(out_meta), Ok(src_meta)) = (std::fs::metadata(output), std::fs::metadata(source))
    else {
        return false;
    };
    match (out_meta.modified(), src_meta.modified()) {
        (Ok(out_time), Ok(src_time)) => out_time >= src_time,
        _ => false,
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    build_swift_helpers();

    tauri_build::build()
}
