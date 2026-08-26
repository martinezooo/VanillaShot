# Changelog

All notable changes to VanillaShot are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-08-22

Security and stability fixes.

### Fixed

- Blackout masks were drawn at 98% opacity, so 2% of every original pixel
  reached the exported PNG. That is enough contrast to stretch the original back
  out, and a masked QR code re-decoded from it. Masks are fully opaque now.
  Anything redacted with 0.2.0 should be treated as unredacted.
- The classifier trimmed whitespace but not invisible formatting characters, so
  a payload starting with a zero-width space was labelled plain text. A 2FA seed
  hidden that way skipped the reveal gate and was left out of "Mask all
  sensitive". Those characters are stripped before classification now. The
  payload shown and copied is unchanged.
- PGP private keys were classified as benign, because the armor ends in
  " BLOCK" and the pattern did not allow for it. Any armored block is at least
  sensitive now.
- Unknown URI schemes were classified as benign, so `file:` and `data:` were
  skipped by "Mask all sensitive". Anything other than http and https counts as
  sensitive now.
- Codes from the previous screenshot stayed listed while the next one was
  scanning, so masking could stamp rectangles at the old coordinates and report
  success. OCR and scan results are tied to the image that started them, and
  superseded OCR workers are stopped.
- "Copy payload" ignored the reveal gate, so a payload shown as hidden still
  went to the clipboard in full.
- Barcode decoding ran at full resolution on the main thread with every
  expensive option on, so a large image could block the editor for seconds.
  Input is capped at 12 megapixels and mask rectangles are scaled back.
- Closing the quick editor could crash the app inside WebKit, which was still
  working on an asynchronous scrolling update when the view was destroyed. The
  editor keeps one window and hides it between captures, which also makes the
  next capture open faster. The hidden editor and the capture overlay opt out of
  WebKit background throttling, so a suspended view can still receive the event
  that wakes it.

### Changed

- Invisible characters in a decoded payload are shown escaped, so a payload
  cannot display one address while encoding another.
- README covers the automatic code scanning and what happens to a decoded
  payload.

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
