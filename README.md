# Vanilla Shoot

Vanilla Shoot is a local-first screenshot and screen memory app.
It is inspired by CleanShot-style UX, but focused on OCR-driven redaction.

Author: hack-jitsu.com

## Desktop v1 scope

- macOS-first desktop app (Tauri v2)
- Native region capture (`/usr/sbin/screencapture -i -x -r`)
- Global shortcut: `Cmd/Ctrl+Shift+1`
- Workflow: capture -> open editor -> auto OCR -> redact -> export

## Core features

- Load screenshot from file, paste (`Cmd/Ctrl + V`), or capture region
- Automatic OCR on new screenshot (`tesseract.js`) with live progress
- Local OCR language model bundle: `public/tessdata/eng.traineddata.gz`
- Pentest-oriented secret detection:
  - IPv4 / IPv6-like chunks
  - emails
  - URLs
  - JWT tokens
  - AWS access keys
  - hash-like long hex values
  - high-entropy long tokens
- QR / barcode scanning (`zxing-wasm`, bundled locally so it works offline):
  - QR, Micro QR, rMQR, DataMatrix, Aztec, PDF417, Code 128, Code 39, EAN-13, ITF
  - payloads classified as critical / sensitive / benign, with the reason shown
  - critical: TOTP/HOTP seeds (`otpauth://`), Wi-Fi credentials (`WIFI:`),
    URLs with embedded credentials, JWTs, AWS keys, private key material
  - mask one code or every non-benign one; masks are always blackout, since a
    blurred symbol can still carry recoverable module contrast
  - critical payloads stay hidden until revealed, and decoded links are never
    opened — only copied
- Annotation tools:
  - blur rectangle
  - blackout rectangle
  - highlight rectangle
  - strike line
  - sign/text notes
- One-click blackout of every OCR token flagged as sensitive
- Export PNG and copy PNG to clipboard

## Prerequisites (desktop)

```bash
xcode-select --install
curl https://sh.rustup.rs -sSf | sh
```

Restart shell and verify:

```bash
rustc --version
cargo --version
```

## Run web

```bash
npm install
npm run dev
```

## Run desktop (Tauri)

```bash
npm install
npm run tauri:dev
```

## Build desktop bundle

```bash
npm run tauri:build
```

## Raycast

`raycast/` holds a Raycast extension with three commands: Capture Region,
Toggle Screen Memory, and Search Screen Memory. Actions travel over the `vanillashoot://`
URL scheme (a fixed set of verbs, no payloads, no open port); search reads the
memory database read-only. See [raycast/README.md](raycast/README.md).

## Deep links

The installed app registers the `vanillashoot://` scheme:

| URL | Action |
| --- | --- |
| `vanillashoot://capture` | Start a region capture |
| `vanillashoot://show` | Reveal the main window |
| `vanillashoot://memory/start` | Start screen memory (no-op if already recording) |
| `vanillashoot://memory/stop` | Stop screen memory (no-op if idle) |
| `vanillashoot://memory/toggle` | Flip screen memory |

```bash
open "vanillashoot://capture"
```

Unknown actions are logged and ignored.

## Keyboard shortcuts

- `Cmd/Ctrl + Z`: undo
- `Cmd/Ctrl + S`: save/export PNG
- `Cmd/Ctrl+Shift+1` (desktop): global region capture
- `Enter` (quick editor): save PNG + copy to clipboard
