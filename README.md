# VanillaShot

A local-first screenshot and screen-memory tool for macOS, built for people who
share screenshots that should not leak. It OCRs what you capture, flags the parts
that look like secrets, and gives you one keystroke to black them out.

Nothing leaves the machine: capture, OCR, barcode decoding and redaction all run
on-device, and the app makes no network requests of any kind.

Author: martinezooo · hack-jitsu.com

> **Status: pre-1.0.** macOS only, Apple silicon only, and there is no signed
> download — you build it from source. See [Requirements](#requirements) and
> [Install](#install) before you start.

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

Two features, both aimed at not leaking things by accident:

**Capture and redact.** Press `Cmd+Shift+1`, drag a region, and the editor opens
with the shot already OCR'd. Anything that looks like a credential — tokens, keys,
hashes, addresses — is flagged, and one click blacks out every flagged token. QR
and barcodes are decoded and classified too, because a screenshot of a 2FA
enrolment code hands over the seed just as completely as pasting it.

**Screen memory.** An opt-in background recorder that keeps a searchable, OCR'd
history of your screen, so you can find that error message you closed an hour
ago. It is off until you turn it on, and it records a lot — read
[Screen memory](#screen-memory) before enabling it.

## Requirements

| | |
| --- | --- |
| macOS | 12.3 or newer (the recorder uses ScreenCaptureKit, which lands in 12.3) |
| Hardware | Apple silicon only today — builds produce an `aarch64` binary, with no universal or Intel build |
| Node | 20.19+ or 22.12+ (required by Vite 7) |
| Rust | stable toolchain |
| Xcode | Command Line Tools, for `swiftc` and the linker |

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

There is **no signed or notarised download**, and none is planned until the
project has an Apple Developer ID. A build produced here is ad-hoc signed, which
macOS Gatekeeper rejects outright on a downloaded file — so distributing a DMG
would only teach people to disable security warnings. Build it yourself instead:

```bash
git clone https://github.com/hack-jitsu/VanillaShot.git
cd VanillaShot
npm install
npm run install:local
```

`npm run install:local` builds the app, signs it with a certificate from your
keychain, and installs it to `/Applications/VanillaShot.app`. The signing step
matters: an ad-hoc signature carries no certificate, so macOS identifies the app
by its code hash and every rebuild reads as a brand-new app that has to be granted
Screen Recording again. Signing with a real certificate — even a free Apple
Development one from Xcode — keeps the permission across rebuilds. Override the
certificate with `VANILLASHOT_SIGN_IDENTITY` if the script picks the wrong one.

To run against the sources without installing, see [Development](#development).

## Permissions

**Screen Recording is required.** Neither capture nor screen memory works without
it, and macOS will hand back blank or black images rather than an error if it is
missing.

Grant it under **System Settings → Privacy & Security → Screen Recording**, then
**restart the app** — macOS only re-reads the grant at launch. VanillaShot checks
the state without triggering a prompt, so the Settings window can tell you
truthfully whether the permission is in place.

Two further permissions are requested only if you use dictation when attaching a
note to a screenshot: **Microphone** and **Speech Recognition**. Audio is never
written to disk — only the transcribed text is saved, in the note sidecar.

## How capture works

macOS ships an interactive region selector (`screencapture -i`), but it selects
against a *live* screen: menus close while you aim, video keeps playing, and the
editor can end up inside its own screenshot. VanillaShot freezes the screen
instead:

1. `Cmd+Shift+1` (or the tray, or a deep link) hides any visible VanillaShot
   window so the app can never appear in its own capture.
2. It grabs a still of the display under the cursor.
3. A full-screen, always-on-top overlay shows that still, dimmed, with a
   crosshair.
4. You drag a rectangle over the frozen image. Release, and the region is cropped
   from the still and opened in the editor.

`Esc`, or a click without a drag, cancels. Because the still is taken with the app
hidden, moving content stays exactly where you aimed at it.

## It lives in the menu bar

**`npm run tauri:dev` opens no window — look in the menu bar.** VanillaShot is a
menu-bar utility with no Dock icon. The tray menu holds region capture, the screen
memory toggle, Settings and Quit.

The main window is a **Settings** panel, not the editor. The editor opens as its
own floating window after a capture.

## The editor

Load a screenshot by capturing a region, pasting with `Cmd+V`, or opening a file.

**OCR.** New screenshots are OCR'd automatically with a bundled `tesseract.js` and
a local language model — no download, works offline. (Screen-memory frames are OCR'd
separately by Apple's Vision framework, which is faster and already on the system.)

**Secret detection.** OCR'd text is scanned for the things that most often leak
through a screenshot: cloud keys (AWS, Google), forge and CI tokens (GitHub,
GitLab, Slack, Stripe, SendGrid), JWTs and PASETOs, PEM private key blocks,
password hashes (bcrypt, argon2, scrypt, LM/NT pairs, LDAP), Kerberos and NTLM
material, long high-entropy strings, hashes, IPv4/IPv6 addresses, MAC addresses,
emails, URLs, and values sitting next to keywords like `password` or `secret`.
One click blacks out every flagged token.

**Barcodes.** QR, Micro QR, rMQR, DataMatrix, Aztec, PDF417, Code 128, Code 39,
EAN-13 and ITF are decoded locally with `zxing-wasm`. Payloads are classified:

- **critical** — TOTP/HOTP seeds (`otpauth://`), Wi-Fi credentials (`WIFI:`),
  URLs with embedded credentials, JWTs, cloud keys, private key material
- **sensitive**, **benign** — everything else, with the reason shown

Critical payloads stay hidden until you reveal them, and a decoded link is never
opened, only copied. Masking is always blackout, never blur: a blurred symbol can
still carry recoverable module contrast.

**Annotation tools.** Select, crop, OCR-select, arrow, border, blur, pixelate,
blackout, highlight, strike and text.

**Export.** Save a PNG or copy it to the clipboard.

## Screen memory

An **opt-in** background recorder. It is off until you start it from the tray, the
Settings switch, or a deep link — but once running it is broad, so here is exactly
what it does:

| | |
| --- | --- |
| Captures | your entire primary display — **no window is excluded** |
| Video | H.264 at 5 fps, ~1 Mbps, cursor included, in 5-minute segments |
| Keyframes | one JPEG every 10 seconds |
| Indexing | every keyframe is OCR'd (Apple Vision, English and Polish) into a full-text search index |
| Location | `~/Library/Application Support/com.hackjitsu.vanillashot/` — `segments/`, `frames/`, `memory.db` |
| Retention | 30 days by default |

Two things worth knowing before you turn it on:

- **It records VanillaShot too.** Open a screenshot in the editor while the
  recorder is running, and the *unredacted* original is captured and OCR'd into
  the index before you redact it.
- **The store is plain, unencrypted SQLite plus ordinary video files.** Any
  process running as your user can read them without triggering a macOS
  permission prompt. Treat the data directory as sensitive; delete it to purge.

Known gaps, stated plainly: the 30-day purge only advances while recording is
running, and there is no "delete everything" button in the UI yet.

## Privacy

VanillaShot makes **no network requests**. There is no telemetry, no analytics, no
crash reporting, no auto-updater and no HTTP client in the binary. Capture, OCR,
barcode decoding and redaction all happen on-device, and the OCR language model
and barcode decoder are bundled rather than fetched. The UI font is bundled too,
for the same reason.

The exception to keep in mind is not the network but the local machine: the
screen-memory store is unencrypted (see above), and any local process can open a
`vanillashot://` link, including one that starts recording.

## Where files go

Exported screenshots land in `~/Pictures` as
`vanilla-shot-<pid>-<timestamp>.png`. The folder is shown in Settings.

If you attach a note, a `.txt` sidecar is written next to the image with the same
name, containing the note text and the image's absolute path.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Cmd+Shift+1` | global region capture (also `Ctrl+Shift+1`) |
| `Cmd+Z` | undo |
| `Cmd+S` | save/export PNG |
| `Cmd+C` / `Cmd+X` | copy / cut selection |
| `Delete` / `Backspace` | delete selection |
| `Esc` | cancel capture, or clear selection |
| `Enter` | in the quick editor: save PNG and copy to clipboard |

## Deep links

The installed app registers the `vanillashot://` scheme. The verb set is fixed and
takes no payloads, so there is no parsing surface:

| URL | Action |
| --- | --- |
| `vanillashot://capture` | start a region capture |
| `vanillashot://show` | reveal the main window |
| `vanillashot://memory/start` | start screen memory (no-op if already recording) |
| `vanillashot://memory/stop` | stop screen memory (no-op if idle) |
| `vanillashot://memory/toggle` | flip screen memory |

```bash
open "vanillashot://capture"
```

Unknown actions are ignored (and logged in debug builds).

## Raycast extension

`raycast/` holds a Raycast extension with three commands: Capture Region, Toggle
Screen Memory, and Search Screen Memory. Actions travel over the `vanillashot://`
scheme above; search reads the memory database read-only. See
[raycast/README.md](raycast/README.md).

## Development

```bash
npm install
npm run dev          # editor in a browser, no desktop features
npm run tauri:dev    # full desktop app (menu bar — no window opens)
npm run tauri:build  # produce a bundle in src-tauri/target/release/bundle
npm run install:local # build, sign, install to /Applications
npm run lint
npm run test:capture:smoke   # needs a GUI macOS session
```

`npm run dev` serves the editor in a browser. OCR, detection, barcode scanning and
annotation all work there; capture, screen memory, the tray and deep links are
desktop-only.

The OCR assets under `public/tesseract/` are vendored automatically before dev and
build by `scripts/vendor-tesseract.mjs`. The Swift helpers for the recorder and
Vision OCR are compiled by `src-tauri/build.rs` into `src-tauri/gen/helpers/` and
shipped as bundle resources.

See [AGENTS.md](AGENTS.md) for conventions, and why the signing step in
`install:local` is not optional.

## License

MIT — see [LICENSE](LICENSE).

Bundled third-party components and their licenses are listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
