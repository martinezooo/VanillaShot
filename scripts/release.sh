#!/usr/bin/env bash
set -euo pipefail

# Builds the release artifacts and the update manifest.
#
# The private signing key lives outside the repository. Without it the update
# archive cannot be signed, and an unsigned archive is refused by every
# installed copy of the app, so the build stops rather than publishing something
# nobody can install.

VERSION="$(node -p "require('./package.json').version")"
KEY_PATH="${VANILLASHOT_UPDATER_KEY:-$HOME/.config/vanillashot/updater.key}"
BUNDLE="src-tauri/target/release/bundle"
REPO="martinezooo/VanillaShot"

if [ ! -f "$KEY_PATH" ]; then
  echo "No signing key at $KEY_PATH" >&2
  echo "Set VANILLASHOT_UPDATER_KEY, or generate one with:" >&2
  echo "  npx tauri signer generate -w \"$KEY_PATH\"" >&2
  exit 1
fi

export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_PATH")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${VANILLASHOT_UPDATER_KEY_PASSWORD:-}"

echo "Building $VERSION..."
npm run tauri:build

ARCHIVE="$BUNDLE/macos/VanillaShot.app.tar.gz"
DMG="$BUNDLE/dmg/VanillaShot_${VERSION}_aarch64.dmg"

for f in "$ARCHIVE" "$ARCHIVE.sig" "$DMG"; do
  [ -f "$f" ] || { echo "Missing $f" >&2; exit 1; }
done

echo "Writing the update manifest..."
SIGNATURE="$(cat "$ARCHIVE.sig")" VERSION="$VERSION" REPO="$REPO" node -e '
const fs = require("fs");
fs.writeFileSync("src-tauri/target/release/bundle/latest.json", JSON.stringify({
  version: process.env.VERSION,
  pub_date: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  platforms: {
    "darwin-aarch64": {
      signature: process.env.SIGNATURE,
      url: `https://github.com/${process.env.REPO}/releases/download/v${process.env.VERSION}/VanillaShot.app.tar.gz`,
    },
  },
}, null, 2) + "\n");
'

echo
echo "Built $VERSION. Publish with:"
echo "  gh release create v$VERSION --title \"VanillaShot $VERSION\" --notes-file <notes> --latest \\"
echo "    \"$DMG\" \"$ARCHIVE\" \"$ARCHIVE.sig\" \"$BUNDLE/latest.json\""
echo
echo "latest.json must be attached, or no installed copy will see the release."
