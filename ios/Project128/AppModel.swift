import AVFAudio
import Foundation
import SwiftUI
import WebKit

struct NativeShareItem: Identifiable {
    let id = UUID()
    let url: URL
}

@MainActor
final class AppModel: ObservableObject {
    @Published var localURL: URL?
    @Published var startupError: String?
    @Published var notice: String?
    @Published var midiStatus = "MIDI: starting…"
    @Published var importRequested = false
    @Published var importing = false
    @Published var shareItem: NativeShareItem?
    @Published var webReady = false
    weak var webView: WKWebView?
    private let server = LoopbackServer()
    private let midi = MIDIInput()
    private var observers: [NSObjectProtocol] = []
    private var started = false
    private var sharedDirectory: URL?
    private let storagePrefix = "Project128.WebStorage."

    func start() {
        guard !started else { return }
        started = true
        configureAudioSession()
        guard let root = Bundle.main.url(forResource: "WebBundle", withExtension: nil),
              FileManager.default.fileExists(atPath: root.appendingPathComponent("index.html").path) else {
            startupError = "The offline web bundle is missing. Run npm ci and npm run build before building this Xcode project."
            return
        }
        server.start(root: root) { [weak self] result in
            switch result {
            case .success(let url): self?.localURL = url
            case .failure(let error): self?.startupError = "The private local server could not start: \(error.localizedDescription)"
            }
        }
        midi.onStatus = { [weak self] status in
            DispatchQueue.main.async { self?.midiStatus = status }
        }
        midi.onBatch = { [weak self] events, dropped, completion in
            DispatchQueue.main.async {
                guard let self, let view = self.webView, self.webReady else { completion(); return }
                if dropped > 0 { self.midiStatus = "MIDI: \(dropped) packets dropped · input reset" }
                let payload: [[String: Any]] = events.map { ["bytes": $0.bytes.map(Int.init), "timestamp": $0.timestamp, "port": $0.port] }
                view.callAsyncJavaScript("if (typeof window.nativeMIDI === 'function') { for (const event of events) window.nativeMIDI(event.bytes, event.timestamp, event.port); }",
                                         arguments: ["events": payload], in: nil, in: .page) { _ in completion() }
            }
        }
        midi.start()
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification,
                                                               object: nil, queue: .main) { [weak self] notification in
            guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            Task { @MainActor [weak self] in
                self?.notice = type == .began ? "Audio interrupted. Resume with Start audio when ready." : "Audio interruption ended. Tap Start audio if playback is suspended."
                self?.sendLifecycleEvent("nativeAudioInterruption", detail: ["began": type == .began])
            }
        })
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification,
                                                               object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.sendLifecycleEvent("nativeAudioRouteChange", detail: [:]) }
        })
    }

    func configureAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true)
        } catch { notice = "Audio session: \(error.localizedDescription)" }
    }

    private func sendLifecycleEvent(_ name: String, detail: [String: Any]) {
        guard webReady else { return }
        webView?.callAsyncJavaScript("window.dispatchEvent(new CustomEvent(eventName, {detail}));",
                                    arguments: ["eventName": name, "detail": detail], in: nil, in: .page, completionHandler: nil)
    }

    func importFile(_ url: URL) {
        guard webReady, !importing else { notice = "Wait for the player to finish loading, then import your file."; return }
        let kind: String
        do { kind = try NativeBridgePolicy.importKind(filename: url.lastPathComponent) }
        catch { notice = "Choose a MIDI, SF2, SF3, DLS, .p128preset, .p128session, or JSON file. KQ presets are not supported."; return }
        importing = true
        let scoped = url.startAccessingSecurityScopedResource()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do {
                if let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
                   size > NativeBridgePolicy.maximumFileBytes { throw CocoaError(.fileReadTooLarge) }
                let data = try Data(contentsOf: url, options: .mappedIfSafe)
                guard data.count <= NativeBridgePolicy.maximumFileBytes else { throw CocoaError(.fileReadTooLarge) }
                let payload: [String: Any] = ["kind": kind, "name": url.lastPathComponent, "data": data.base64EncodedString()]
                DispatchQueue.main.async { self?.deliverImport(payload) }
            } catch {
                DispatchQueue.main.async {
                    self?.importing = false
                    self?.notice = "Import failed (native limit: 256 MiB): \(error.localizedDescription)"
                }
            }
        }
    }

    private func deliverImport(_ payload: [String: Any]) {
        guard let view = webView, webReady else { importing = false; notice = "The player reloaded. Import your file again."; return }
        view.callAsyncJavaScript("if (typeof window.nativeImport !== 'function') throw new Error('Player import is unavailable'); await window.nativeImport(payload);",
                                 arguments: ["payload": payload], in: nil, in: .page) { [weak self] result in
            self?.importing = false
            if case .failure(let error) = result { self?.notice = "Import failed: \(error.localizedDescription)" }
        }
    }

    func share(name: String, base64: String) {
        guard base64.utf8.count <= (NativeBridgePolicy.maximumFileBytes * 4 / 3 + 8),
              let data = Data(base64Encoded: base64), data.count <= NativeBridgePolicy.maximumFileBytes else {
            notice = "The export is invalid or exceeds the native 256 MiB limit."
            return
        }
        do {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("Project128-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let file = directory.appendingPathComponent(NativeBridgePolicy.exportName(name))
            try data.write(to: file, options: .atomic)
            presentShare(file, directory: directory)
        } catch { notice = "Export failed: \(error.localizedDescription)" }
    }

    func presentShare(_ file: URL, directory: URL) {
        guard shareItem == nil else { try? FileManager.default.removeItem(at: directory); return }
        sharedDirectory = directory
        shareItem = NativeShareItem(url: file)
    }

    func finishShare() {
        if let directory = sharedDirectory { try? FileManager.default.removeItem(at: directory) }
        sharedDirectory = nil
        shareItem = nil
    }

    func saveStorage(key: String, value: String?) {
        guard NativeBridgePolicy.storageKeys.contains(key) else { return }
        if let value, value.utf8.count > 2 * 1024 * 1024 {
            notice = "The session or preset library exceeds the native 2 MiB storage limit. Export a backup before closing; the previous saved version was retained."
            return
        }
        if let value { UserDefaults.standard.set(value, forKey: storagePrefix + key) }
        else { UserDefaults.standard.removeObject(forKey: storagePrefix + key) }
    }

    /// An ephemeral HTTP port changes WebKit's storage origin. Mirror only the two
    /// app-owned JSON keys in native preferences and restore them before module execution.
    func storageScript(for base: URL) -> String {
        var values: [String: String] = [:]
        for key in NativeBridgePolicy.storageKeys {
            if let value = UserDefaults.standard.string(forKey: storagePrefix + key) { values[key] = value }
        }
        let json = String(data: (try? JSONSerialization.data(withJSONObject: values)) ?? Data("{}".utf8), encoding: .utf8) ?? "{}"
        return """
        (() => {
          if (location.hostname !== '127.0.0.1' || location.port !== '\(base.port ?? 0)') return;
          const saved = \(json);
          const keys = new Set(['project128.session', 'project128.presets']);
          const originalSet = Storage.prototype.setItem;
          const originalRemove = Storage.prototype.removeItem;
          const originalClear = Storage.prototype.clear;
          for (const [key, value] of Object.entries(saved)) originalSet.call(localStorage, key, value);
          const notify = (key, value) => window.webkit.messageHandlers.project128.postMessage({command:'storage', key, value});
          Storage.prototype.setItem = function(key, value) {
            originalSet.call(this, key, value);
            if (this === localStorage && keys.has(String(key))) notify(String(key), String(value));
          };
          Storage.prototype.removeItem = function(key) {
            originalRemove.call(this, key);
            if (this === localStorage && keys.has(String(key))) notify(String(key), null);
          };
          Storage.prototype.clear = function() {
            originalClear.call(this);
            if (this === localStorage) for (const key of keys) notify(key, null);
          };
        })();
        """
    }

    deinit { observers.forEach { NotificationCenter.default.removeObserver($0) } }
}
