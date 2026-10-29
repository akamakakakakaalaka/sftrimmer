import Foundation

enum NativeBridgePolicy {
    static let storageKeys = Set(["project128.session", "project128.presets"])
    static let maximumFileBytes = 256 * 1024 * 1024

    static func accepts(_ source: URL?, mainFrame: Bool, base: URL) -> Bool {
        guard mainFrame, let source else { return false }
        let prefix = base.path.hasSuffix("/") ? base.path : base.path + "/"
        return source.scheme == "http" && source.host == "127.0.0.1"
            && source.port == base.port && (source.path == base.path || source.path.hasPrefix(prefix))
    }

    static func importKind(filename: String) throws -> String {
        switch (filename as NSString).pathExtension.lowercased() {
        case "mid", "midi", "rmi": return "midi"
        case "sf2", "sf3", "dls": return "bank"
        case "json", "p128preset": return "preset"
        case "p128session", "p128backup": return "session"
        default: throw CocoaError(.fileReadUnknown)
        }
    }

    static func exportName(_ raw: String) -> String {
        let safe = raw.components(separatedBy: .controlCharacters).joined()
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "\\", with: "_")
        let trimmed = String(safe.prefix(160)).trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed == "." || trimmed == ".." ? "Project128-export.json" : trimmed
    }
}
