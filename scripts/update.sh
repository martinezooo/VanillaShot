#!/usr/bin/env bash
set -e

APP_NAME="VanillaShot"
APP_PATH="/Applications/${APP_NAME}.app"
BUNDLE_PATH="src-tauri/target/release/bundle/macos/${APP_NAME}.app"
# Must match the identifier the installed app already carries. Signing with a
# different one makes macOS treat this as a new app and resets its Screen
# Recording grant.
BUNDLE_ID="com.hackjitsu.vanillashot"

echo "[ ${APP_NAME} Updater ]"

if [ "$1" == "" ]; then
  echo "Usage: npm run update <new_version>"
  echo "Example: npm run update 0.1.2"
  exit 1
fi

NEW_VERSION=$1

echo "Updating to version $NEW_VERSION..."

# Update package.json
sed -i '' -E "s/\"version\": \"[0-9]+\.[0-9]+\.[0-9]+\"/\"version\": \"$NEW_VERSION\"/" package.json

# Update tauri.conf.json
sed -i '' -E "s/\"version\": \"[0-9]+\.[0-9]+\.[0-9]+\"/\"version\": \"$NEW_VERSION\"/" src-tauri/tauri.conf.json
sed -i '' -E "s/\"title\": \"${APP_NAME} v[0-9]+\.[0-9]+\.[0-9]+\"/\"title\": \"${APP_NAME} v$NEW_VERSION\"/" src-tauri/tauri.conf.json

echo "Building Tauri app..."
npm run tauri build

echo "Killing previous instances..."
killall "vanilla-shot" 2>/dev/null || true

echo "Installing to /Applications..."
rm -rf "$APP_PATH"
cp -a "$BUNDLE_PATH" /Applications/

echo "Applying stable ad-hoc code signature..."
codesign --force --deep --sign - --identifier "$BUNDLE_ID" "$APP_PATH"

echo "Starting new instance..."
open "$APP_PATH" || echo "Failed to open app. You can run it manually."

echo "Update to $NEW_VERSION complete!"
