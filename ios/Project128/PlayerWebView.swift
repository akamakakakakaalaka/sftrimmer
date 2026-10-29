import Foundation
import SwiftUI
import WebKit
import UIKit
import CoreText

@MainActor
struct PlayerWebView: UIViewRepresentable {
    @ObservedObject var model: AppModel
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(model: model, base: url) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.add(context.coordinator, name: "project128")
        Self.installScripts(in: configuration.userContentController, model: model, base: url)
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        model.webView = view
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    private static func installScripts(in controller: WKUserContentController, model: AppModel, base: URL) {
        controller.removeAllUserScripts()
        for source in [model.storageScript(for: base), ToolbarGlyphs.script(for: base)] {
            controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
    }

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        coordinator.model.webReady = false
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: "project128")
        uiView.stopLoading()
        uiView.navigationDelegate = nil
        uiView.uiDelegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
        let model: AppModel
        let base: URL
        private var downloads: [ObjectIdentifier: (file: URL, directory: URL)] = [:]

        init(model: AppModel, base: URL) {
            self.model = model
            self.base = base
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "project128",
                  NativeBridgePolicy.accepts(message.frameInfo.request.url, mainFrame: message.frameInfo.isMainFrame, base: base),
                  let body = message.body as? [String: Any], let command = body["command"] as? String else { return }
            switch command {
            case "import": model.importRequested = true
            case "midiStatus":
                model.notice = "\(model.midiStatus)\n\nUp to eight CoreMIDI sources use separate ports, stable while connected. WebKit delivery is batched and is not a hard real-time transport. Physical-device latency and background synthesis still need validation."
            case "midiPorts": model.refreshMIDIPorts()
            case "midiSend": model.sendMIDIOutput(body)
            case "midiOutputResume": model.resumeMIDIOutput(body)
            case "share":
                guard let name = body["name"] as? String, let data = body["data"] as? String else { return }
                model.share(name: name, base64: data)
            case "storage":
                guard let key = body["key"] as? String else { return }
                if body["value"] is NSNull { model.saveStorage(key: key, value: nil) }
                else if let value = body["value"] as? String { model.saveStorage(key: key, value: value) }
            default: break
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let requested = navigationAction.request.url else { decisionHandler(.cancel); return }
            if navigationAction.shouldPerformDownload && acceptsDownload(requested) { decisionHandler(.download); return }
            guard navigationAction.targetFrame?.isMainFrame == true,
                  NativeBridgePolicy.accepts(requested, mainFrame: true, base: base) else {
                decisionHandler(.cancel)
                return
            }
            // Refresh the native snapshot before any reload, including WebKit process recovery.
            PlayerWebView.installScripts(in: webView.configuration.userContentController, model: model, base: base)
            decisionHandler(.allow)
        }

        private func acceptsDownload(_ url: URL) -> Bool {
            if NativeBridgePolicy.accepts(url, mainFrame: true, base: base) { return true }
            guard url.scheme == "blob", let inner = URL(string: String(url.absoluteString.dropFirst(5))) else { return false }
            return inner.scheme == "http" && inner.host == "127.0.0.1" && inner.port == base.port
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            if !navigationResponse.canShowMIMEType, let url = navigationResponse.response.url, acceptsDownload(url) {
                decisionHandler(.download)
            } else { decisionHandler(.allow) }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            model.webReady = true
            model.refreshMIDIPorts()
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            guard (error as NSError).code != NSURLErrorCancelled else { return }
            model.webReady = false
            model.notice = "Player loading failed: \(error.localizedDescription)"
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            self.webView(webView, didFailProvisionalNavigation: navigation, withError: error)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            model.webReady = false
            model.notice = "The player process restarted. Settings were retained; start audio and reimport session soundbanks and MIDI files."
            webView.reload()
        }

        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
            download.delegate = self
        }

        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
            download.delegate = self
        }

        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                      completionHandler: @escaping (URL?) -> Void) {
            do {
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent("Project128-download-\(UUID().uuidString)")
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let file = directory.appendingPathComponent(NativeBridgePolicy.exportName(suggestedFilename))
                downloads[ObjectIdentifier(download)] = (file, directory)
                completionHandler(file)
            } catch {
                model.notice = "Could not save the export: \(error.localizedDescription)"
                completionHandler(nil)
            }
        }

        func downloadDidFinish(_ download: WKDownload) {
            if let destination = downloads.removeValue(forKey: ObjectIdentifier(download)) {
                model.presentShare(destination.file, directory: destination.directory)
            }
        }

        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            if let destination = downloads.removeValue(forKey: ObjectIdentifier(download)) {
                try? FileManager.default.removeItem(at: destination.directory)
            }
            model.notice = "Export failed: \(error.localizedDescription)"
        }
    }
}

/// Render installed iOS glyphs at runtime; no Apple font or symbol artwork is bundled.
/// Visual candidates from public screenshots, not verified original Sampei resources.
@MainActor
private enum ToolbarGlyphs {
    private static let masks: [String: String] = {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 3
        format.opaque = false
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 24), format: format)
        var result: [String: String] = [:]
        if let gear = UIImage(systemName: "gear", withConfiguration: UIImage.SymbolConfiguration(pointSize: 24, weight: .regular)) {
            let image = renderer.image { _ in
                let scale = 21.3 / max(gear.size.width, gear.size.height)
                let size = CGSize(width: gear.size.width * scale, height: gear.size.height * scale)
                gear.withTintColor(.black, renderingMode: .alwaysOriginal)
                    .draw(in: CGRect(x: (24 - size.width) / 2, y: (24 - size.height) / 2, width: size.width, height: size.height))
            }
            if let png = image.pngData() { result["gear"] = "data:image/png;base64," + png.base64EncodedString() }
        }
        let text = NSAttributedString(string: "\u{266B}", attributes: [.font: UIFont.systemFont(ofSize: 24), .foregroundColor: UIColor.black])
        let line = CTLineCreateWithAttributedString(text as CFAttributedString)
        let bounds = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
        if bounds.width > 0 && bounds.height > 0 {
            let image = renderer.image { context in
                let scale = min(20 / bounds.width, 19 / bounds.height)
                let size = CGSize(width: bounds.width * scale, height: bounds.height * scale)
                let cg = context.cgContext
                cg.textMatrix = .identity
                cg.translateBy(x: (24 - size.width) / 2, y: (24 + size.height) / 2)
                cg.scaleBy(x: scale, y: -scale)
                cg.translateBy(x: -bounds.minX, y: -bounds.minY)
                cg.textPosition = .zero
                CTLineDraw(line, cg)
            }
            if let png = image.pngData() { result["music"] = "data:image/png;base64," + png.base64EncodedString() }
        }
        return result
    }()

    static func script(for base: URL) -> String {
        let payload: [String: Any] = ["base": base.absoluteString, "icons": masks]
        guard let data = try? JSONSerialization.data(withJSONObject: payload), let json = String(data: data, encoding: .utf8) else { return "" }
        return """
        (() => {
          const payload = \(json), base = new URL(payload.base);
          const prefix = base.pathname.endsWith('/') ? base.pathname : base.pathname + '/';
          if (location.origin !== base.origin || !(location.pathname === base.pathname || location.pathname.startsWith(prefix))) return;
          Object.defineProperty(window, 'project128NativeIcons', {value: Object.freeze(payload.icons)});
        })();
        """
    }
}
