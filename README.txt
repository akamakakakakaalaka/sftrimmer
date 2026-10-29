PROJECT 128 — original iOS MIDI player source, v0.1

This is a source project, not a signed/installed iPhone app. The embedded player is also testable in a desktop browser. The full 250-item feature catalog is in docs/features-250.html and JSON; proposed items are not claims of completed features. See docs/IMPLEMENTED.txt for the actual build scope and verification results.

START ON A COMPUTER
Install Node.js 22.12+ (Node24 recommended).
  npm ci
  npm run dev
Open the local address printed by Vite. Press Start Audio once, then use the keyboard or import a MIDI file. All runtime synthesis and bank conversion run locally. The included GS bank is accurately named in its metadata and notices; it is not authentic Roland SC-88Pro hardware emulation.

BUILD THE IOS PROJECT
  npm ci
  npm run build
Open ios/Project128.xcodeproj on a supported Mac with Xcode. Select the Project128 scheme, choose your connected iPhone, select your own signing Team and press Run. Developer Mode may be required. An installed, signed build appears on the Home Screen. A free Personal Team has time-limited development profiles. No Apple credentials are included in this project.

An .xcodeproj is a development project. A distributable .ipa contains an .app bundle and needs appropriate signing/provisioning to install; renaming a ZIP does not produce an installable app.

LINUX BUILD ORCHESTRATION
Read docs/LINUX_MAC_BUILD.txt and .github/workflows/build-ios.yml. The workflow runs the Apple toolchain on a real Mac runner; it does not emulate macOS inside Linux. The current workspace lacks KVM/virtualization access and sufficient disk for a practical Xcode VM. No signed native build or device verification has been performed here.

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

The complete preferred editable bank source is supplied separately beside the ZIP as Project128_GS_Editable_Source.sf2 (32,542,290bytes). See licenses/banks/SOURCE_DELIVERY.txt. Redistribute that source alongside the compressed bank and notices.

Imported custom bank bytes currently stay in session memory: after reopening, import the same bank to relink its stable fingerprint. The bundled starter reloads automatically. Automatic persistent custom-bank storage is future work, not a completed feature.
