# Releasing VanillaShot

Releases are published by GitHub Actions. Users do not receive local worktree
changes: a change becomes available through **Update Now** only after it has
been merged, tagged, built, signed, and published as a GitHub Release.

## One-time GitHub setup

1. Generate an updater signing key locally:

   ```bash
   npx tauri signer generate -w "$HOME/.config/vanillashot/updater.key"
   ```

2. Keep the private key outside the repository. Add its complete contents as
   the repository secret `VANILLASHOT_UPDATER_PRIVATE_KEY`.
3. If the key has a password, add that password as
   `VANILLASHOT_UPDATER_PRIVATE_KEY_PASSWORD`. Otherwise create the secret with
   an empty value.
4. Confirm that the public key in `src-tauri/tauri.conf.json` matches the
   generated key. The public key is safe to commit; the private key is not.

The workflow uses GitHub's short-lived `GITHUB_TOKEN` to create the release.
No personal access token is needed.

## Publishing a release

Update the version in all three files:

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`

Merge the change to `main`, then create and push an annotated tag with the same
version:

```bash
git tag -a v0.2.4 -m "VanillaShot v0.2.4"
git push origin v0.2.4
```

The `Release` workflow then:

1. checks out the tag and verifies all versions match it;
2. runs lint, tests, frontend build, and Rust checks;
3. builds the Apple Silicon macOS app;
4. signs the Tauri updater archive with the repository secret;
5. creates the GitHub Release and uploads the DMG, updater archive, signature,
   and `latest.json`.

The endpoint configured in `src-tauri/tauri.conf.json` always points to the
latest release manifest:

`https://github.com/martinezooo/VanillaShot/releases/latest/download/latest.json`

Therefore an installed copy can check for the new version and install it with
**Update Now**. The update is cryptographically verified against the public key
compiled into the installed app.

## Important macOS limitation

The workflow produces a signed updater artifact, but the app is not signed with
an Apple Developer ID certificate or notarized. Users may need to approve the
first app launch in Finder. The updater itself still verifies the Tauri update
signature. Apple Developer ID signing and notarization can be added later by
providing `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, and
`APPLE_TEAM_ID` secrets and extending the release job.
