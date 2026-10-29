#!/usr/bin/env python3
"""Select an installed iOS 18 runtime and configure a known simulator-only fix.

iOS 18.4/18.5 place libswiftWebKit in a Cryptex without making the simulator
loader search it. WebKit bug 293831 documents the fallback path. No binary or
device settings are changed. The scheme modification is local to the CI job.
"""
import json
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET


def simctl(*args):
    return json.loads(subprocess.check_output(["xcrun", "simctl", "list", *args, "-j"]))


devices = simctl("devices", "available")["devices"]
runtimes = simctl("runtimes")["runtimes"]
candidates = []
for runtime in runtimes:
    version = tuple(int(part) for part in runtime.get("version", "0").split("."))
    if not runtime.get("isAvailable") or version[0] != 18 or ".iOS-" not in runtime["identifier"]:
        continue
    for device in devices.get(runtime["identifier"], []):
        if device.get("isAvailable") and device["name"].startswith("iPhone"):
            candidates.append((version, runtime, device))
if not candidates:
    sys.exit("No installed iOS 18 iPhone Simulator runtime is available.")
version, runtime, device = max(candidates, key=lambda row: row[0])
if (18, 4) <= version < (18, 6):
    fallback = Path(runtime["bundlePath"]) / "Contents/Resources/RuntimeRoot/System/Cryptexes/OS/usr/lib/swift"
    if (fallback / "libswiftWebKit.dylib").is_file():
        scheme = Path("ios/Project128.xcodeproj/xcshareddata/xcschemes/Project128.xcscheme")
        tree = ET.parse(scheme)
        action = tree.getroot().find("TestAction")
        action.set("shouldUseLaunchSchemeArgsEnv", "NO")
        variables = ET.SubElement(action, "EnvironmentVariables")
        ET.SubElement(variables, "EnvironmentVariable", {
            "key": "DYLD_FALLBACK_LIBRARY_PATH", "value": str(fallback), "isEnabled": "YES"
        })
        tree.write(scheme, encoding="UTF-8", xml_declaration=True)
        print("Configured simulator WebKit Cryptex lookup (WebKit bug 293831).", file=sys.stderr)
print(f"Native tests: {device['name']}, iOS {runtime['version']}", file=sys.stderr)
print(device["udid"])
