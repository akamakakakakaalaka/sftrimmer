#!/usr/bin/env bash
# Read-only checks for the Apple toolchain used by the iOS workflow.
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  printf '%s\n' 'iOS compilation requires Xcode on macOS. Run this preflight on the macOS CI runner; Linux can orchestrate that runner.' >&2
  exit 1
fi

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project_path="$project_root/ios/Project128.xcodeproj"
if [[ ! -f "$project_path/project.pbxproj" ]]; then
  printf '%s\n' 'Missing ios/Project128.xcodeproj/project.pbxproj.' >&2
  exit 1
fi

for tool in xcodebuild xcode-select xcrun python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Required macOS build tool is unavailable: %s\n' "$tool" >&2
    exit 1
  fi
done

developer_path="${DEVELOPER_DIR:-$(xcode-select -p)}"
case "$developer_path" in
  */Xcode*.app/Contents/Developer) ;;
  *) printf '%s\n' 'Select a full Xcode installation, rather than Command Line Tools, with DEVELOPER_DIR or xcode-select.' >&2; exit 1 ;;
esac

printf 'Architecture: %s\nDeveloper directory: %s\n' "$(uname -m)" "$developer_path"
xcodebuild -version
printf 'Device SDK: %s\n' "$(xcrun --sdk iphoneos --show-sdk-version)"
printf 'Simulator SDK: %s\n' "$(xcrun --sdk iphonesimulator --show-sdk-version)"
xcrun --find simctl >/dev/null

xcodebuild -list -json -project "$project_path" | python3 -c '
import json, sys
data = json.load(sys.stdin)
schemes = data.get("project", {}).get("schemes", [])
if "Project128" not in schemes:
    sys.exit("The shared Project128 scheme is unavailable.")
print("Shared scheme: Project128")
'
printf '%s\n' 'Toolchain preflight passed. This is not a compile, signing, simulator, or device test.'
