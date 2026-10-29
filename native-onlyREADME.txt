PROJECT 128 — NATIVE iOS SOURCE

This folder contains an original iOS/iPadOS 18+ SwiftUI host for the bundled
SpessaSynth web player. It is source code, not an installed app or signed IPA.
The native source has not been compiled or tested on a physical Apple device
in this Linux build environment. Static project checks do not establish that
WebKit audio, local AudioWorklets, CoreMIDI timing, or background playback work
on an iPhone. See the main release notes for web/audio checks actually run.

OPEN ON A MAC
1. Install a supported Xcode version with the iOS SDK. Xcode 16 or newer can
   target iOS 18; use the Xcode version compatible with your Mac and device.
2. Open ios/Project128.xcodeproj and choose the shared Project128 scheme.
3. The source release includes prebuilt HTML/JavaScript/WASM in
   ios/Project128/WebBundle. The starter bank exists once in the source archive
   at web/public/banks/starter.sf3. The final Xcode build phase copies it into
   the app's WebBundle/banks directory after copying the other resources.
   Opening this source release therefore does not require npm or internet.
4. To rebuild the web portion after changes, run npm ci followed by npm run
   build from the project root. tools/sync-ios.mjs refreshes WebBundle from
   dist and preserves exact binary bytes. Rebuilding requires Node/npm and
   package access. Do not include node_modules in a source release.
5. Under Signing & Capabilities select your Apple team. The checked-in bundle
   ID is org.project128.player; change it if your team needs a unique ID.
   No developer account, signing key, password, or team ID is embedded here.
6. Select an iPhone/iPad simulator or your connected device and Run. For a
   device, trust the Mac and enable Developer Mode when iOS asks. A free
   Personal Team is suitable for personal testing; profiles expire after
   seven days and require rebuilding/reinstalling. Distribution has separate
   Apple Developer Program and provisioning requirements.

COMMAND LINE (MAC WITH FULL XCODE SELECTED)
Unsigned simulator compilation:
  xcodebuild -project ios/Project128.xcodeproj -scheme Project128 \
    -configuration Debug -sdk iphonesimulator \
    -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build

Choose an installed iOS 18+ simulator from xcrun simctl list devices available,
then run the native boundary tests, replacing SIMULATOR_UDID:
  xcodebuild -project ios/Project128.xcodeproj -scheme Project128 \
    -destination 'platform=iOS Simulator,id=SIMULATOR_UDID' \
    CODE_SIGNING_ALLOWED=NO test

For a signed device archive, select your team in Xcode and use Product > Archive
with a device destination. Export through Xcode Organizer using the appropriate
development, ad hoc, TestFlight, or App Store provisioning method. An IPA is a
compiled iOS application archive with signing/provisioning appropriate to its
installation route. Renaming a source ZIP to .ipa does not produce one. A
simulator build is also not an iPhone-installable IPA. The source ZIP size is
separate from installed app size, decoded audio memory and signed IPA size.

NATIVE BEHAVIOR
- WKWebView loads offline assets from an ephemeral http://127.0.0.1 port and
  a random path token. Network.framework binds IPv4 loopback only, with no
  advertised service or LAN listener. The read-only server validates Host,
  Origin, methods and paths, rejects traversal/escaping symlinks, and serves
  JS/WASM/SF3 and other binary assets without text conversion. No arbitrary
  website navigation is enabled. Device worklet trust still needs validation.
- Tap Start audio inside the player. Native audio-session activation does not
  bypass Web Audio's user-gesture requirement.
- The native Files toolbar imports MIDI/RIFF MIDI, SF2/SF3/DLS, Project 128
  presets and session backups through a security-scoped document picker.
  The native base64 bridge limits one file to 256 MiB; large imports can need
  considerably more temporary RAM. Unsupported/KQ preset formats are rejected.
- Native share sheets export files. Share/Files cancellation keeps originals.
- Native preferences mirror only project128.session and project128.presets,
  each limited to 2 MiB. Those keys are restored before the web app starts,
  preserving settings despite the ephemeral HTTP port. WebKit's own data store
  is temporary. Imported bank/MIDI content remains session memory; export a
  session backup and keep original bank files. A backup does not embed banks.
- CoreMIDI connects up to eight input sources to separate logical MIDI ports,
  retaining each assignment while the source stays connected. This keeps
  running-status streams separate. Additional sources are reported without
  connecting them. The callback performs a nonblocking try-lock and a bounded raw
  copy. A serial queue drains batches, with one WebKit call in flight. Oversize
  packets, lock contention and overflow discard the incomplete stream and
  request all-sound/all-notes-off recovery. This can interrupt held notes.
  Host timestamps are monotonic milliseconds, not the AudioContext clock.
  There is no guarantee of sample-accurate input scheduling or live latency.
- AVAudioSession uses playback with mixing. The audio background mode is
  declared, and interruption/route events are forwarded, but this declaration
  does not prove that iOS keeps WKWebView live synthesis running when locked
  or backgrounded. Foreground standalone use is the first device test target.
  If WebKit restarts, settings return; audio and imported content need restart.
- This project has no AUv3 extension target and does not claim AUv3 support.

BRIDGE CONTRACT (MAIN FRAME, EXACT PRIVATE ORIGIN ONLY)
JavaScript -> Swift:
  window.webkit.messageHandlers.project128.postMessage({command:'import'})
  window.webkit.messageHandlers.project128.postMessage({
    command:'share', name:'My sound.p128preset', data:'BASE64_BYTES'
  })
The storage command is installed by native code for the two app-owned keys.
No arbitrary native command, filesystem path or network URL is accepted.

Swift -> JavaScript:
  await window.nativeImport({kind:'bank'|'midi'|'preset'|'session',name,data})
  window.nativeMIDI(rawPacketBytes, nativeHostMonotonicMilliseconds, zeroBasedPort)
Raw MIDI packets may contain several messages, running status, or SysEx chunks.

VERIFICATION
Linux runnable: node --test ios/sync-ios.test.mjs
Native XCTest cases cover HTTP trust/path boundaries, symlink escape, binary
payloads, HEAD, bridge frame/origin validation, and supported import formats.
They must be executed on a Mac with the command above; they were not run here.
Native project parsing, plist/XML parsing, and Swift syntax checks are useful
static checks but are not a substitute for compilation or device testing.

Official Apple setup: https://developer.apple.com/xcode/system-requirements
Personal testing: https://developer.apple.com/help/account/basics/about-your-developer-account
Developer Mode: https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device
