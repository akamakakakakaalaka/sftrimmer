PROJECT 128 — original iOS MIDI player source, v0.1

This is a source project, not a signed/installed iPhone app. The embedded player is also testable in a desktop browser. The full 250-item feature catalog is in docs/features-250.html and JSON; proposed items are not claims of completed features. See docs/IMPLEMENTED.txt for the actual build scope and verification results.

FIDELITY REVISION — 29 OCTOBER2026
The playing surface now uses the full Sampei-style controller grid and separate
measured phone/tablet layouts, with the original proportions, native-style menus,
soft keyboard and compact MIDI player. The iOS system font is selected on Apple
platforms; Linux previews use a bundled licensed Inter fallback. Absolute ADSR,
conversion and the added effects remain in secondary controls. Per-program Por
and P.Time settings persist independently by exact soundbank and MIDI address.
This is original SpessaSynth-based source, not a Sampei source fork. References,
measurement limits and video-access limitations are in docs/UI_REFERENCE_EVIDENCE.txt;
current tests/geometry are recorded in docs/VERIFICATION.json and output reports.
Full Sampei feature parity remains incomplete. Native simulator/device Xcode
compilation passed; Apple signing and physical-device runtime remain unverified. The250-item catalog remains a roadmap, not250 finished features.

START ON AN IPHONE WITHOUT SIGNING
Open https://project128-mobile-player.cosmo-hosimaru.chatgpt.site in Safari
with the ChatGPT account that owns this private Site. Use Share > Add to Home
Screen, then Start Audio. After the offline cache is ready, the bundled player
and bank can reload offline. MIDI files, soundfonts and onscreen keys use local
audio. Imported files must be reselected after closing the app. This delivery
was tested in Chromium; physical iOS27 and Safari playback remain unverified.

NO-CODE LIVE MIDI ROUTING IN THE NATIVE BUILD
Under MIDI, Connect MIDI devices, choose Input and Output, then Enable MIDI
Thru. SysEx requires its separate opt-in. The installed native app supplies
CoreMIDI; the Safari Home Screen version has no native hardware access. MIDI
files continue playing through the internal synth. See docs/COREMIDI_WEBMIDI.txt.

START ON A COMPUTER
Install Node.js 22.12+ (Node24 recommended).
  npm ci
  npm run dev
Open the local address printed by Vite. Press Start Audio once, or touch a control to initialize audio, then play or import a MIDI file. All runtime synthesis and bank conversion run locally. The included GS bank is accurately named in its metadata and notices; it is not authentic Roland SC-88Pro hardware emulation.

BUILD THE IOS PROJECT
  npm ci
  npm run build
Open ios/Project128.xcodeproj on a supported Mac with Xcode. Select the Project128 scheme, choose your connected iPhone, select your own signing Team and press Run. Developer Mode may be required. An installed, signed build appears on the Home Screen. A free Personal Team has time-limited development profiles. No Apple credentials are included in this project.

An .xcodeproj is a development project. A distributable .ipa contains an .app bundle and needs appropriate signing/provisioning to install; renaming a ZIP does not produce an installable app.

LINUX BUILD ORCHESTRATION
Read docs/LINUX_MAC_BUILD.txt and .github/workflows/build-ios.yml. The workflow runs the Apple toolchain on a real Mac runner; it does not emulate macOS inside Linux. The current workspace lacks KVM/virtualization access and sufficient disk for a practical Xcode VM. The Mac workflow has now compiled simulator and device builds successfully. downloads/Project128-unsigned.ipa is the unsigned iPhone build (iOS18+); sign/install using a setup such as AltStore or Sideloadly. Physical-device behavior and Apple signing remain unverified. See docs/IPA_VERIFICATION.json.

VERIFY / PACKAGE
  npm test
  npm run build
  npx playwright install chromium
  npm run test:browser
  npm run package
The package command verifies lossless ZIP extraction, a 250-item catalog and fewer than20,000,000bytes. It excludes dependency caches and uncompressed source banks. Rebuilding bank data is documented in its provenance and prepare script; preserve all included notices.

PRESETS AND BANKS
Original preset files retain exact bank identity and part edits. KQ .kqspreset compatibility is not implemented. Keep imported originals when compressing SF2 to SF3: Vorbis encoding is lossy, although this project's ZIP packaging is lossless. A compressed font may still consume substantial decoded RAM.

LICENSES
Original project code: Apache-2.0. Third-party engines, encoders, bank samples and optional extra instruments have their own notices in licenses/. In particular, any TimGM6mb samples are GPL-2 licensed; this does not turn them into Roland samples. Retain source/provenance and redistribution terms.

The complete preferred editable bank source is supplied separately beside the ZIP as Project128_GS_Editable_Source.sf2 (32,542,290bytes). It is also published in sources/banks on the project128-ios-build branch. See licenses/banks/SOURCE_DELIVERY.txt. Redistribute that source alongside the compressed bank and notices.

Imported custom bank bytes currently stay in session memory: after reopening, import the same bank to relink its stable fingerprint. The bundled starter reloads automatically. Automatic persistent custom-bank storage is future work, not a completed feature.
