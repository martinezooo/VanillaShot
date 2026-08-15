# Vanilla Shoot for Raycast

Raycast commands for the [Vanilla Shoot](../README.md) screenshot and screen memory app.

## Commands

| Command | Mode | What it does |
| --- | --- | --- |
| Capture Region | no-view | Opens `vanillashoot://capture`, then Vanilla Shoot draws the crosshair and hands the result to its editor. |
| Toggle Screen Memory | no-view | Opens `vanillashoot://memory/toggle`. |
| Search Screen Memory | view | Full-text search over OCR text from recorded frames, with a preview of each frame. |

## How it talks to Vanilla Shoot

No port, no daemon, no token file:

- **Actions** go through the `vanillashoot://` URL scheme. Any command that changes state
  is one of a fixed set of verbs handled in `src-tauri/src/lib.rs`; the scheme
  accepts no paths or payloads, so nothing else on the machine can steer Vanilla Shoot
  through it. Opening a link launches Vanilla Shoot if it is not already running.
- **Search** reads `~/Pictures/Vanilla Shoot Memory/memory.db` directly, read-only, via
  `useSQL` from `@raycast/utils`.

## Requirements

- Vanilla Shoot installed (the `vanillashoot://` scheme is registered by the app bundle, so a
  `tauri dev` process is not enough — build and install the app once).
- A `sqlite3` binary on Raycast's PATH. `useSQL` spawns it with `--readonly`.
  If that binary lacks the `fts5` module, search automatically falls back to a
  `LIKE` scan, which is slower on large histories but returns the same rows.

## Development

```bash
cd raycast
npm install
npm run dev
```

`npm run dev` registers the extension with the local Raycast app. Publishing to
the Raycast Store is a separate `ray publish` step and has not been done.
