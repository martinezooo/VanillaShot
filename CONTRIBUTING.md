# Contributing

## Rebuilding the installed app

After a change, rebuild and reinstall `/Applications/VanillaShot.app`:

```bash
npm run install:local
```

Use that script rather than signing by hand. It signs with a certificate from
the keychain instead of ad-hoc, which is what keeps the Screen Recording grant
alive. An ad-hoc signature carries no certificate, so the designated requirement
falls back to the binary's code hash, and every rebuild reads as a different app
that has to be granted the permission again. Set `VANILLASHOT_SIGN_IDENTITY` to
pick a specific certificate. Otherwise the script takes the first Apple
Development identity it finds.

Do not sign under any of the old bundle identifiers such as `com.vulshot`. macOS
would treat the result as a different app and reset its Screen Recording grant.
Keep `com.hackjitsu.vanillashot`.

## When to reinstall

`npm run tauri:dev` runs unsigned from a different path, so it cannot confirm
permission or packaging behaviour. Finish with a real install when you touch:

- Rust or Tauri code
- the capture flow, OCR, or permissions
- shortcuts, tray behaviour, or deep links
- packaging or bundled assets

## Checks

```bash
npm run lint
npm run build
cargo build --manifest-path src-tauri/Cargo.toml
```

CI runs the same three on macOS, plus a guard that fails the build if a webfont
CDN reference reaches `dist/`. The app is meant to make no network requests, and
a Google Fonts import slipped in once already.

## Naming

The app is **VanillaShot**. Older names survive only where removing them would
break an existing install:

- `src-tauri/src/memory/mod.rs` stores screen-memory data in
  `~/Library/Application Support/com.hackjitsu.vanillashot/` and migrates the
  earlier `~/Pictures/*` locations and `~/Library/Application
  Support/com.vulshot/memory` into it. Keep those fallbacks.
- `raycast/src/vanillaShot.ts` carries the same list, so the extension can find
  an install that has not migrated yet.

Everything else uses the current name: bundle identifier
`com.hackjitsu.vanillashot`, deep link scheme `vanillashot://`, crate
`vanilla-shot`, lib `vanilla_shot_lib`.

## Screen-memory helpers

The OCR and recorder Swift helpers are compiled at build time by
`src-tauri/build.rs` into `src-tauri/gen/helpers/` and shipped as bundle
resources in `Contents/Resources/helpers/`, resolved at runtime by
`resolve_helper`.

Do not reintroduce runtime `swiftc` compilation, and do not write executables
into the data directory.

`build.rs` pins the Swift deployment target to macOS 12.3 with `-target`.
Without it, `swiftc` stamps the build machine's OS version as the minimum, and
helpers built on a newer macOS refuse to launch on every supported version below
it. Keep that flag in step with the `@available` annotations in
`scripts/vanilla_shot_recorder.swift`.

## Versioning

`scripts/update.sh <version>` bumps `package.json`, `tauri.conf.json`,
`Cargo.toml` and the lockfile together. Use it rather than editing them by hand.
They drifted apart once because the script only touched two of the four.
