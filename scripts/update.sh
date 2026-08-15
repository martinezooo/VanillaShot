#!/usr/bin/env bash
set -e

echo "[ Vulshot Updater ]"

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
sed -i '' -E "s/\"title\": \"Vulshot v[0-9]+\.[0-9]+\.[0-9]+\"/\"title\": \"Vulshot v$NEW_VERSION\"/" src-tauri/tauri.conf.json


echo "Building Tauri app..."
npm run tauri build

echo "Killing previous instances..."
killall vulshot || true

echo "Installing to /Applications..."
rm -rf /Applications/Vulshot.app
cp -a src-tauri/target/release/bundle/macos/Vulshot.app /Applications/
rm -rf /Applications/Vulshot-*.app 2>/dev/null || true

echo "Applying stable ad-hoc code signature..."
codesign --force --deep --sign - --identifier com.vulshot /Applications/Vulshot.app

echo "Starting new instance..."
open /Applications/Vulshot.app || echo "Failed to open app. You can run it manually."

echo "Update to $NEW_VERSION complete!"
