#!/usr/bin/env bash
set -euo pipefail

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd osascript
require_cmd /usr/sbin/screencapture
require_cmd sips

bounds_raw="$(osascript -e 'tell application "Finder" to get bounds of window of desktop' | tr -d ' ')"
IFS=',' read -r left top right bottom <<<"$bounds_raw"

if [[ -z "${left:-}" || -z "${top:-}" || -z "${right:-}" || -z "${bottom:-}" ]]; then
  echo "Could not determine desktop bounds" >&2
  exit 1
fi

desktop_width=$((right - left))
desktop_height=$((bottom - top))

if ((desktop_width < 320 || desktop_height < 240)); then
  echo "Desktop bounds are too small for smoke checks: ${desktop_width}x${desktop_height}" >&2
  exit 1
fi

small_w=160
small_h=120
small_x=$((left + (desktop_width - small_w) / 2))
small_y=$((top + (desktop_height - small_h) / 2))

large_w=$(((desktop_width * 8) / 10))
large_h=$(((desktop_height * 8) / 10))
if ((large_w < 640)); then large_w=640; fi
if ((large_h < 420)); then large_h=420; fi
if ((large_w > desktop_width)); then large_w=$desktop_width; fi
if ((large_h > desktop_height)); then large_h=$desktop_height; fi

large_x=$((left + (desktop_width - large_w) / 2))
large_y=$((top + (desktop_height - large_h) / 2))

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

small_file="$tmp_dir/small-capture.png"
large_file="$tmp_dir/large-capture.png"

capture_rect() {
  local x="$1"
  local y="$2"
  local w="$3"
  local h="$4"
  local output="$5"
  /usr/sbin/screencapture -x -r -R"${x},${y},${w},${h}" "$output"
}

measure_width() {
  local file="$1"
  sips -g pixelWidth "$file" | awk '/pixelWidth/ {print $2}'
}

measure_height() {
  local file="$1"
  sips -g pixelHeight "$file" | awk '/pixelHeight/ {print $2}'
}

echo "Desktop bounds: ${left},${top},${right},${bottom} (${desktop_width}x${desktop_height})"
echo "Capturing small region: ${small_x},${small_y},${small_w},${small_h}"
capture_rect "$small_x" "$small_y" "$small_w" "$small_h" "$small_file"
echo "Capturing large region: ${large_x},${large_y},${large_w},${large_h}"
capture_rect "$large_x" "$large_y" "$large_w" "$large_h" "$large_file"

if [[ ! -s "$small_file" || ! -s "$large_file" ]]; then
  echo "Capture output file is empty." >&2
  exit 1
fi

small_actual_w="$(measure_width "$small_file")"
small_actual_h="$(measure_height "$small_file")"
large_actual_w="$(measure_width "$large_file")"
large_actual_h="$(measure_height "$large_file")"

if [[ -z "$small_actual_w" || -z "$small_actual_h" || -z "$large_actual_w" || -z "$large_actual_h" ]]; then
  echo "Could not read captured image dimensions." >&2
  exit 1
fi

small_area=$((small_actual_w * small_actual_h))
large_area=$((large_actual_w * large_actual_h))

if ((small_actual_w < 80 || small_actual_h < 60)); then
  echo "Small capture dimensions are too low: ${small_actual_w}x${small_actual_h}" >&2
  exit 1
fi

if ((large_actual_w < small_actual_w || large_actual_h < small_actual_h)); then
  echo "Large capture is not larger than small capture: ${large_actual_w}x${large_actual_h} vs ${small_actual_w}x${small_actual_h}" >&2
  exit 1
fi

if ((large_area < small_area * 6)); then
  echo "Large capture area should be at least 6x small area: small=${small_area}, large=${large_area}" >&2
  exit 1
fi

echo "Small capture: ${small_actual_w}x${small_actual_h}"
echo "Large capture: ${large_actual_w}x${large_actual_h}"
echo "Region capture smoke test passed."
