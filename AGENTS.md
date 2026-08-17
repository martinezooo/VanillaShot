## Skills

- `vulshot-release-update`: Build, install, codesign, and relaunch the macOS app after substantial changes. Skill path: `/Users/martinezooo/.codex/skills/vulshot-release-update/SKILL.md`

  The skill text predates several renames (Vulshot -> AYE -> Vanilla Shoot -> VanillaShot). Where it says `Vulshot.app`, read `/Applications/VanillaShot.app`, and re-sign with the current identifier:

  ```bash
  codesign --force --deep --sign - --identifier com.hackjitsu.vanillashot "/Applications/VanillaShot.app"
  ```

  Signing with the skill's stale `com.vulshot` identifier would make macOS treat the app as a different one and reset its Screen Recording grant.

## Trigger Rules

- Use `vulshot-release-update` after substantial changes in this repo, especially when they affect Tauri/Rust code, capture flow, OCR, permissions, shortcuts, tray behavior, packaging, assets, deep links, or any user-facing behavior that should be verified in `/Applications/VanillaShot.app`.
- Use `vulshot-release-update` when the user asks to update, install, restart, rebuild, or verify the installed app.
- Do not stop at `tauri dev` for major changes. Finish by validating and refreshing `/Applications/VanillaShot.app` unless the user explicitly says not to.

## Naming

The app is **VanillaShot**. Historical names survive only where removing them would break an existing install:

- `src-tauri/src/memory/mod.rs` migrates `~/Pictures/Vanilla Shoot Memory`, `~/Pictures/AYE Memory`, `~/Pictures/Vulshot Memory`, and `~/Library/Application Support/com.vulshot/memory` into `~/Pictures/VanillaShot Memory`. Keep those fallbacks.
- `raycast/src/vanillaShot.ts` carries the same list so the extension resolves an un-migrated install.

Everything else — bundle identifier `com.hackjitsu.vanillashot`, deep link scheme `vanillashot://`, crate `vanilla-shot`, lib `vanilla_shot_lib` — uses the current name.
