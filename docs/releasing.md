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
5. Export the `Developer ID Application` certificate from Keychain Access as a
   password-protected `.p12` file and encode it:

   ```bash
   openssl base64 -A -in DeveloperID.p12 -out DeveloperID.p12.base64
   ```

   Add the contents as `APPLE_CERTIFICATE`, the export password as
   `APPLE_CERTIFICATE_PASSWORD`, and a random keychain password as
   `KEYCHAIN_PASSWORD`.
6. Add `APPLE_SIGNING_IDENTITY` with the exact identity shown by:

   ```bash
   security find-identity -v -p codesigning
   ```

   It should start with `Developer ID Application:`.
7. Create an App Store Connect API key with Developer access. Add its key ID
   as `APPLE_API_KEY`, issuer ID as `APPLE_API_ISSUER`, and the downloaded
   `.p8` contents as `APPLE_API_PRIVATE_KEY`.

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
4. imports the Developer ID certificate into an ephemeral CI keychain;
5. signs and notarizes the macOS app with Apple;
6. signs the Tauri updater archive with the repository secret;
7. creates the GitHub Release and uploads the DMG, updater archive, signature,
   and `latest.json`.

The endpoint configured in `src-tauri/tauri.conf.json` always points to the
latest release manifest:

`https://github.com/martinezooo/VanillaShot/releases/latest/download/latest.json`

Therefore an installed copy can check for the new version and install it with
**Update Now**. The update is cryptographically verified against the public key
compiled into the installed app.

## Apple certificate renewal

Developer ID certificates expire. When Apple issues a replacement, export the
new certificate as `.p12` and replace `APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD`, and `APPLE_SIGNING_IDENTITY` in GitHub. Do not
delete the old certificate until all currently supported releases have been
verified.

The App Store Connect API key is separate from the Developer ID certificate and
normally does not need to change when the certificate is renewed.
