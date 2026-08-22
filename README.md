<p align="center">
  <img src="docs/hero.png" width="840"
       alt="VanillaShot. Screenshots that don't leak. A captured .env file with four secret values blacked out.">
</p>

# VanillaShot

A local-first screenshot and screen-memory tool for macOS. It reads the text in
what you capture, flags anything that looks like a secret, and blacks it out in
one click.

Nothing leaves your machine. Capture, OCR, barcode decoding and redaction all
run on-device, and the app makes no network requests at all.

Author: martinezooo, hack-jitsu.com

> **Status: pre-1.0.** macOS only, Apple silicon only, and there is no signed
> download. You build it from source.

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Install](#install)
- [Permissions](#permissions)
- [How capture works](#how-capture-works)
- [It lives in the menu bar](#it-lives-in-the-menu-bar)
- [The editor](#the-editor)
- [Screen memory](#screen-memory)
- [Privacy](#privacy)
- [Where files go](#where-files-go)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Deep links](#deep-links)
- [Raycast extension](#raycast-extension)
- [Development](#development)
- [License](#license)

## What it does

**Capture and redact.** Press `Cmd+Shift+1` and drag a region. The editor opens
with the shot already OCR'd. Anything that looks like a credential is flagged,
and one click blacks out every flagged token. QR and barcodes are decoded and
classified too, because a screenshot of a 2FA enrolment code gives away the seed
just as completely as pasting it.

**Screen memory.** An opt-in background recorder that keeps a searchable history
of your screen, so you can find an error message you closed an hour ago. It is
off until you turn it on, and it records a lot. Read
[Screen memory](#screen-memory) before enabling it.

## Requirements

| | |
| --- | --- |
| macOS | 12.3 or newer. The recorder needs ScreenCaptureKit, which arrived in 12.3. |
| Hardware | Apple silicon only. Builds produce an `aarch64` binary. There is no universal or Intel build. |
| Node | 20.19+ or 22.12+ |
| Rust | stable toolchain |
| Xcode | Command Line Tools, for `swiftc` |

```bash
xcode-select --install
curl https://sh.rustup.rs -sSf | sh
```

Restart your shell, then check:

```bash
rustc --version
node --version
```

## Install

There is no signed or notarised download. A build produced here is ad-hoc
signed, which macOS Gatekeeper rejects outright on a downloaded file, so
shipping a DMG would only teach people to click past security warnings. Build it
yourself:

```bash
git clone https://github.com/hack-jitsu/VanillaShot.git
cd VanillaShot
npm install
npm run install:local
```

That builds the app, signs it with a certificate from your keychain, and
installs it to `/Applications/VanillaShot.app`.

The signing step matters. An ad-hoc signature carries no certificate, so macOS
identifies the app by its code hash, and every rebuild looks like a brand-new
app that has to be granted Screen Recording again. Signing with a real
certificate, even a free Apple Development one from Xcode, keeps the permission
across rebuilds. Set `VANILLASHOT_SIGN_IDENTITY` if the script picks the wrong
certificate.

## Permissions

**Screen Recording is required.** Neither capture nor screen memory works
without it, and macOS hands back blank images rather than an error if it is
missing.

Grant it in **System Settings > Privacy & Security > Screen Recording**, then
restart the app. macOS only re-reads the grant at launch. VanillaShot checks the
state without triggering a prompt, so Settings can tell you whether the
permission is actually in place.

Microphone and Speech Recognition are requested only if you use dictation when
attaching a note. Audio is never written to disk. Only the transcribed text is
saved.

## How capture works

macOS ships an interactive region selector (`screencapture -i`), but it selects
against a live screen. Menus close while you aim, video keeps playing, and the
editor can end up inside its own screenshot. VanillaShot freezes the screen
instead:

1. `Cmd+Shift+1` hides any visible VanillaShot window, so the app can never
   appear in its own capture.
2. It grabs a still of the display under the cursor.
3. A full-screen overlay shows that still, dimmed, with a crosshair.
4. You drag a rectangle over the frozen image. On release the region is cropped
   out and opened in the editor.

`Esc`, or a click without a drag, cancels.

## It lives in the menu bar

**`npm run tauri:dev` opens no window. Look in the menu bar.** VanillaShot is a
menu-bar utility with no Dock icon. The tray menu holds region capture, the
screen memory toggle, Settings and Quit.

The main window is a Settings panel, not the editor. The editor opens as its own
floating window after a capture.

## The editor

<p align="center">
  <img src="docs/editor.png" width="900"
       alt="The VanillaShot editor, with a tool palette along the top and an action bar along the bottom.">
</p>

Load a screenshot by capturing a region, pasting with `Cmd+V`, or opening a
file.

**OCR.** New screenshots are read automatically with a bundled `tesseract.js`
and a local language model. No download, works offline. Screen-memory frames are
read separately by Apple's Vision framework, which is faster and already on the
system.

**Secret detection.** The OCR'd text is scanned for what usually leaks through a
screenshot: cloud keys (AWS, Google), forge and CI tokens (GitHub, GitLab,
Slack, Stripe, SendGrid), JWTs and PASETOs, PEM private key blocks, password
hashes (bcrypt, argon2, scrypt, LM/NT pairs, LDAP), Kerberos and NTLM material,
long high-entropy strings, hashes, IPv4 and IPv6 addresses, MAC addresses,
emails, URLs, and values sitting next to words like `password` or `secret`. One
click blacks out every flagged token.

**Barcodes.** QR, Micro QR, rMQR, DataMatrix, Aztec, PDF417, Code 128, Code 39,
EAN-13 and ITF are decoded locally with `zxing-wasm`. Payloads are classified as
critical, sensitive or benign, with the reason shown. Critical covers TOTP and
HOTP seeds (`otpauth://`), Wi-Fi credentials (`WIFI:`), URLs with embedded
credentials, JWTs, cloud keys and private key material.

Critical payloads stay hidden until you reveal them, and a decoded link is never
opened, only copied. Masking is always blackout, never blur, because a blurred
symbol can still carry recoverable module contrast.

**Tools.** Select, crop, OCR-select, arrow, border, blur, pixelate, blackout,
highlight, strike and text.

**Export.** Save a PNG or copy it to the clipboard.

## Screen memory

An opt-in background recorder. It is off until you start it from the tray, the
Settings switch, or a deep link. Once running it is broad, so here is exactly
what it does:

| | |
| --- | --- |
| Captures | your entire primary display. No window is excluded. |
| Video | H.264 at 5 fps, about 1 Mbps, cursor included, in 5-minute segments |
| Keyframes | one JPEG every 10 seconds |
| Indexing | every keyframe is OCR'd (Apple Vision, English and Polish) into a full-text search index |
| Location | `~/Library/Application Support/com.hackjitsu.vanillashot/` in `segments/`, `frames/` and `memory.db` |
| Retention | 30 days by default |

Two things to know before you turn it on:

- **It records VanillaShot too.** If you open a screenshot in the editor while
  the recorder is running, the unredacted original is captured and indexed
  before you redact it.
- **The store is plain, unencrypted SQLite plus ordinary video files.** Any
  process running as your user can read them without a macOS permission prompt.
  Treat the data directory as sensitive. Delete it to purge.

Two known gaps, stated plainly. The 30-day purge only advances while recording
is running, and there is no "delete everything" button in the UI yet.

## Privacy

VanillaShot makes no network requests. No telemetry, no analytics, no crash
reporting, no auto-updater, and no HTTP client in the binary. Capture, OCR,
barcode decoding and redaction all happen on-device. The OCR language model, the
barcode decoder and the UI font are bundled rather than fetched.

The thing to keep in mind is not the network but the local machine. The
screen-memory store is unencrypted, and any local process can open a
`vanillashot://` link, including one that starts recording.

## Where files go

Exported screenshots land in `~/Pictures` as
`vanilla-shot-<pid>-<timestamp>.png`. The folder is shown in Settings.

If you attach a note, a `.txt` file is written next to the image with the same
name, holding the note text and the image's full path.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Cmd+Shift+1` | global region capture (also `Ctrl+Shift+1`) |
| `Cmd+Z` | undo |
| `Cmd+S` | save PNG |
| `Cmd+C` / `Cmd+X` | copy / cut selection |
| `Delete` / `Backspace` | delete selection |
| `Esc` | cancel capture, or clear selection |
| `Enter` | in the quick editor, save PNG and copy to clipboard |

## Deep links

The installed app registers the `vanillashot://` scheme. The verb set is fixed
and takes no payloads, so there is no parsing surface.

| URL | Action |
| --- | --- |
| `vanillashot://capture` | start a region capture |
| `vanillashot://show` | reveal the main window |
| `vanillashot://memory/start` | start screen memory |
| `vanillashot://memory/stop` | stop screen memory |
| `vanillashot://memory/toggle` | flip screen memory |

```bash
open "vanillashot://capture"
```

Unknown actions are ignored.

## Raycast extension

`raycast/` holds a Raycast extension with three commands: Capture Region, Toggle
Screen Memory, and Search Screen Memory. Actions travel over the
`vanillashot://` scheme above. Search reads the memory database read-only. See
[raycast/README.md](raycast/README.md).

## Development

```bash
npm install
npm run dev           # editor in a browser, no desktop features
npm run tauri:dev     # full desktop app (menu bar, no window opens)
npm run tauri:build   # bundle into src-tauri/target/release/bundle
npm run install:local # build, sign, install to /Applications
npm run lint
```

`npm run dev` serves the editor in a browser. OCR, detection, barcode scanning
and annotation all work there. Capture, screen memory, the tray and deep links
are desktop-only.

The OCR assets under `public/tesseract/` are vendored before dev and build by
`scripts/vendor-tesseract.mjs`. The Swift helpers for the recorder and Vision
OCR are compiled by `src-tauri/build.rs` and shipped as bundle resources.

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions.

## License

MIT. See [LICENSE](LICENSE).

Bundled third-party components and their licenses are listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
