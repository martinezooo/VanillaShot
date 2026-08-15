# AYE

AYE (All You Expect) is a local-first screenshot and screen memory app.
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
- Annotation tools:
  - blur rectangle
  - blackout rectangle
  - highlight rectangle
  - strike line
  - sign/text notes
- One-click auto-mask for detected sensitive tokens
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

## Keyboard shortcuts

- `Cmd/Ctrl + Z`: undo
- `Cmd/Ctrl + S`: save/export PNG
- `Cmd/Ctrl+Shift+1` (desktop): global region capture
- `Enter` (quick editor): save PNG + copy to clipboard
