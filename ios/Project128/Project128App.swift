import SwiftUI
import UniformTypeIdentifiers
import UIKit

@main
@MainActor
struct Project128App: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                Group {
                    if let url = model.localURL {
                        PlayerWebView(model: model, url: url)
                    } else if let error = model.startupError {
                        ContentUnavailableView("Player unavailable", systemImage: "exclamationmark.triangle",
                                               description: Text(error))
                    } else {
                        ProgressView("Opening offline player…")
                    }
                }
                .navigationTitle("Project 128")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { model.notice = "\(model.midiStatus)\n\nUp to eight CoreMIDI sources use separate ports, stable while connected. WebKit delivery is batched and is not a hard real-time transport. Physical-device latency and background synthesis still need validation." } label: {
                            Image(systemName: "pianokeys")
                        }
                        .accessibilityLabel("MIDI connection status")
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { model.importRequested = true } label: {
                            if model.importing { ProgressView() }
                            else { Label("Files", systemImage: "folder") }
                        }
                        .disabled(!model.webReady || model.importing)
                        .accessibilityLabel("Import MIDI, soundbank, or Project 128 preset")
                    }
                }
            }
            .task { model.start() }
            .fileImporter(isPresented: $model.importRequested, allowedContentTypes: [.data], allowsMultipleSelection: false) { result in
                switch result {
                case .success(let urls): if let url = urls.first { model.importFile(url) }
                case .failure(let error): model.notice = "File selection failed: \(error.localizedDescription)"
                }
            }
            .sheet(item: $model.shareItem, onDismiss: { model.finishShare() }) { item in
                NativeShareSheet(url: item.url)
            }
            .alert("Project 128", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) {
                Button("OK", role: .cancel) { model.notice = nil }
            } message: { Text(model.notice ?? "") }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { model.configureAudioSession() }
            }
        }
    }
}

private struct NativeShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
