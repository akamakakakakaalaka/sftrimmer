Project128 unsigned iPhone IPA — no-code MIDI Thru revision

File: Project128-unsigned.ipa
Size: 7,929,788 bytes (under20MB)
SHA256: 6e9032ef35f71e980b6bdc49ebd6d6180845c6d5c0f7e97ac2cd764b36035732
Requires iOS18.0 or newer. A real arm64 iPhoneOS application, built with
Xcode16.4/iOS18.5 SDK. This IPA is unsigned and needs valid Apple signing and
an installation method. Downloading it in Safari alone does not install it.
Do not send Apple passwords or signing private keys in chat.

Build evidence: https://github.com/akamakakakakaalaka/sftrimmer/actions/runs/40826367667
Build source: 09247ef47755accc6ce8e77db63786255c77d093
Simulator and device builds succeeded. Eleven native XCTest cases passed on
iPhone16Pro/iOS18.6 Simulator. Physical-device installation, audio and hardware
MIDI have not been tested. The core/browser checks passed separately.

MIDI > Connect MIDI devices > choose Input and Output > Enable MIDI Thru.
No user routing script is needed. This routes live input; MIDI-file playback
continues through the internal synth. Hardware output needs the native app.

Free private web player for MIDI files, soundfonts and onscreen keys:
https://project128-mobile-player.cosmo-hosimaru.chatgpt.site
Open in Safari with the owning ChatGPT account, then Share > Add to Home Screen.
Safari hardware CoreMIDI access is not provided by the web player.

Preferred editable bank source is supplied in sources/banks. Preserve engine,
bank and dependency licenses and notices when redistributing.
