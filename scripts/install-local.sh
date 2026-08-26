#!/usr/bin/env bash
#
# Builds VanillaShot and installs it into /Applications.
#
# Signs with a real code signing certificate rather than ad-hoc. This is the
# whole point of the script: an ad-hoc signature carries no certificate, so
# macOS falls back to identifying the app by the hash of its binary
#
#     designated => cdhash H"faacef36..."
#
# and every rebuild produces a new hash. TCC then treats each build as a
# different app and drops its Screen Recording grant, which is why the
# permission had to be given again after every install. Signing with a
# certificate makes the requirement
#
#     identifier "com.hackjitsu.vanillashot" and ... certificate leaf ...
#
# which survives rebuilds, so the grant is given once.
#
# Override the identity with VANILLASHOT_SIGN_IDENTITY. Pass its SHA-1 or its
# full name from `security find-identity -v -p codesigning`.

set -euo pipefail

APP_NAME="VanillaShot"
BUNDLE_ID="com.hackjitsu.vanillashot"
APP_PATH="/Applications/${APP_NAME}.app"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE_PATH="${ROOT}/src-tauri/target/release/bundle/macos/${APP_NAME}.app"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

# Pick a signing identity: explicit override, else the first Apple Development
# certificate in the keychain, else ad-hoc with a warning.
identity="${VANILLASHOT_SIGN_IDENTITY:-}"
if [ -z "$identity" ]; then
  identity="$(security find-identity -v -p codesigning 2>/dev/null \
    | awk -F'"' '/Apple Development|Developer ID Application/ {print $2; exit}')"
fi

if [ -z "$identity" ]; then
  echo "!! No code signing certificate found; falling back to ad-hoc."
  echo "!! Screen Recording will have to be granted again after every rebuild."
  echo "!! See the comment at the top of this script."
  identity="-"
else
  echo "Signing as: ${identity}"
fi

echo "Building..."
cd "$ROOT"
npm run tauri build -- --bundles app

echo "Stopping any running instance..."
osascript -e "tell application \"${APP_NAME}\" to quit" 2>/dev/null || true
sleep 2
pkill -f "${APP_PATH}" 2>/dev/null || true
sleep 1

echo "Installing to ${APP_PATH}..."
rm -rf "$APP_PATH"
ditto "$BUNDLE_PATH" "$APP_PATH"

echo "Signing..."
codesign --force --deep --sign "$identity" --identifier "$BUNDLE_ID" "$APP_PATH"

echo "Designated requirement now:"
codesign -d --requirements - "$APP_PATH" 2>&1 | tail -1

# Replacing the bundle drops its URL scheme registration, and the build output
# otherwise competes with /Applications for the vanillashot:// scheme.
echo "Refreshing LaunchServices..."
"$LSREGISTER" -u "$BUNDLE_PATH" 2>/dev/null || true
"$LSREGISTER" -f "$APP_PATH"

echo "Launching..."
open "$APP_PATH"

echo "Done."
