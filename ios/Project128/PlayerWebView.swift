import Foundation
import SwiftUI
import WebKit

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
        configuration.userContentController.addUserScript(WKUserScript(source: model.storageScript(for: url),
                                                                        injectionTime: .atDocumentStart, forMainFrameOnly: true))
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
            webView.configuration.userContentController.removeAllUserScripts()
            webView.configuration.userContentController.addUserScript(WKUserScript(source: model.storageScript(for: base),
                                                                                    injectionTime: .atDocumentStart, forMainFrameOnly: true))
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
