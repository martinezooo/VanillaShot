# Changelog

All notable changes to VanillaShot are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-08-22

Security fixes in the redaction and barcode paths, found by auditing what
happens when the decoded payload and the OCR text are treated as fully
attacker-controlled, which they are.

### Fixed

- **Blackout redaction did not fully redact.** The mask was drawn at 98%
  opacity, so 2% of every original pixel survived into the exported PNG. On a
  black and white pattern that left five levels of contrast, enough to stretch
  the original back out and re-decode a masked QR code. The mask is now fully
  opaque and forces its own compositing state. Verified end to end: a QR
  carrying an `otpauth://` seed decodes before masking and does not decode from
  the export afterwards.
- **One invisible character defeated the classifier.** Classification trimmed
  whitespace but not Unicode format characters, so a payload starting with a
  zero-width space classified as plain text. A 2FA seed hidden that way skipped
  the reveal gate and was left out of "Mask all sensitive". Format and control
  characters are now stripped before classification, while the payload shown and
  copied stays byte-exact.
- **PGP private keys classified as benign.** PGP armor ends in " BLOCK", which
  the private key pattern did not match, so a paper backup of a key was exported
  intact and still scannable. Any armored block is now at least sensitive.
- **Unknown URI schemes classified as benign**, so `file:`, `data:` and vendor
  schemes were skipped by "Mask all sensitive". Anything that is not http or
  https is now treated as sensitive.
- **Codes from the previous screenshot stayed on screen** while the new one was
  being scanned, so "Mask all sensitive" could stamp blackouts at the old
  coordinates and report success. OCR and barcode results are now tied to the
  image generation that started them, and obsolete OCR workers are stopped when
  another image begins loading.
- **"Copy payload" ignored the reveal gate**, so a payload displayed as hidden
  still went to the clipboard in full.
- **Barcode decoding could freeze the editor.** It ran at full resolution on the
  main thread with every expensive option on, so an image whose size someone
  else chose blocked the UI for seconds. Input is now capped at 12 megapixels
  and mask rectangles are scaled back to the original.
- **Closing the quick editor could crash the app inside WebKit.** The editor
  destroyed its WKWebView while WebKit could still be processing an asynchronous
  scrolling update. The editor now hides and reuses one window between captures,
  avoiding the teardown race and making subsequent captures open faster. The
  hidden editor and capture overlay also opt out of WebKit suspension so they can
  receive the event that wakes them for the next capture.

### Changed

- Invisible characters in a decoded payload are shown escaped, so a payload
  cannot use a right-to-left override to display one address while encoding
  another.
- README documents the automatic code scanning, and states plainly that decoded
  payloads are never opened, executed, or used to build a path or a query.

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
