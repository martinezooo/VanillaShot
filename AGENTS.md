## Rebuilding the installed app

After substantial changes, rebuild and reinstall `/Applications/VanillaShot.app`:

```bash
npm run install:local
```

Use that script rather than signing by hand. It signs with a certificate from the
keychain instead of ad-hoc, which is what keeps the Screen Recording grant alive:
an ad-hoc signature carries no certificate, so the designated requirement degrades
to the binary's cdhash and every rebuild reads as a different app, forcing you to
re-grant the permission each time. Override the certificate with
`VANILLASHOT_SIGN_IDENTITY`; the script otherwise picks the first Apple
Development identity it finds.

Signing under any of the historical bundle identifiers (`com.vulshot`, and so on)
would make macOS treat the result as a different app and reset its Screen
Recording grant. Keep `com.hackjitsu.vanillashot`.

## Trigger Rules

- Reinstall after changes to Tauri/Rust code, the capture flow, OCR, permissions,
  shortcuts, tray behaviour, packaging, assets, deep links, or any user-facing
  behaviour that should be verified in `/Applications/VanillaShot.app`.
- Reinstall when asked to update, install, restart, rebuild, or verify the
  installed app.
- Do not stop at `tauri dev` for major changes. `tauri dev` runs unsigned under a
  different path, so it cannot confirm permission or packaging behaviour. Finish
  by refreshing `/Applications/VanillaShot.app` unless told otherwise.

## Naming

The app is **VanillaShot**. Historical names survive only where removing them would break an existing install:

- `src-tauri/src/memory/mod.rs` stores screen-memory data in `~/Library/Application Support/com.hackjitsu.vanillashot/` and migrates the earlier `~/Pictures/*` locations and `~/Library/Application Support/com.vulshot/memory` into it. Keep those fallbacks.
- `raycast/src/vanillaShot.ts` carries the same list so the extension resolves an un-migrated install.

Everything else — bundle identifier `com.hackjitsu.vanillashot`, deep link scheme `vanillashot://`, crate `vanilla-shot`, lib `vanilla_shot_lib` — uses the current name.

## Screen-memory helpers

The OCR and recorder Swift helpers are compiled at build time by `src-tauri/build.rs` into `src-tauri/gen/helpers/` and shipped as bundle resources (`Contents/Resources/helpers/`), resolved at runtime via `resolve_helper`. Do not reintroduce runtime `swiftc` compilation or write executables into the data directory.
