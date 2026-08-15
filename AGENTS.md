## Skills

- `vulshot-release-update`: Build, install, codesign, and relaunch the macOS Vulshot app after substantial changes. Skill path: `/Users/martinezooo/.codex/skills/vulshot-release-update/SKILL.md`

## Trigger Rules

- Use `vulshot-release-update` after substantial changes in this repo, especially when they affect Tauri/Rust code, capture flow, OCR, permissions, shortcuts, tray behavior, packaging, assets, or any user-facing behavior that should be verified in `/Applications/Vulshot.app`.
- Use `vulshot-release-update` when the user asks to update, install, restart, rebuild, or verify the installed app.
- Do not stop at `tauri dev` for major changes. Finish by validating and refreshing `/Applications/Vulshot.app` unless the user explicitly says not to.
