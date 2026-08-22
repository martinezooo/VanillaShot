# Changelog

All notable changes to VanillaShot are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-08-22

First public release.

Versions before this one were never published. The `0.1.x` numbering was
inherited from a predecessor project and never incremented here, so it carries
no release history. `0.2.0` is where this project's changelog begins.

### Added

- Frozen-screen region selector. Capture now hides the app, freezes the display
  under the cursor, and opens a full-screen overlay to drag a selection on the
  still image. The app can no longer appear in its own screenshot, and moving
  content stays put while you aim.
- Bundled the Oxanium UI font, replacing a Google Fonts stylesheet import.
- `CHANGELOG.md`, `SECURITY.md` and `THIRD-PARTY-NOTICES.md`.

### Changed

- Rewrote the README around what the app actually does, including a full
  disclosure of what the screen-memory recorder captures, where it stores it,
  and that the store is unencrypted.
- Capture latency roughly halved, from about 393 ms to about 185 ms between the
  trigger and a painted overlay. The overlay webview is now pre-warmed, and the
  window-hide delay is skipped when no window is visible.
- The OCR panel now floats beside the canvas instead of being squeezed into the
  bottom bar.
- `scripts/update.sh` now bumps `Cargo.toml` and the lockfile alongside
  `package.json` and `tauri.conf.json`, which had silently drifted apart.

### Fixed

- The app no longer makes any network request. The only one left was the webfont
  fetch on window open, which contradicted the local-first claim.
- Swift helpers were compiled without an explicit deployment target, so they
  demanded whatever macOS the build machine ran. They are now pinned to 12.3,
  which is what their own sources support.
- Raycast extension lint errors that blocked Store validation.

### Known limitations

- Apple silicon only. There is no universal or Intel build.
- No signed or notarised download. Builds are ad-hoc signed and must be built
  from source. See the README.
- Screen-memory data is stored unencrypted, its 30-day purge only advances while
  recording is running, and there is no "delete everything" button yet.
