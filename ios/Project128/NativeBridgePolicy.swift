import Foundation
import CoreFoundation

enum NativeBridgePolicy {
    static let storageKeys = Set(["project128.session", "project128.presets"])
    static let maximumFileBytes = 256 * 1024 * 1024

    struct MIDIOutputMessage {
        let destination: String
        let bytes: [UInt8]
    }

    /// State of successfully sent messages, bounded before each physical send.
    /// Recovery releases only notes and pedals this bridge has sent itself.
    struct MIDIOutputNoteState {
        private var notes: [Int: Int] = [:]
        private var pedals = Set<Int>()
        private var total = 0

        mutating func record(_ bytes: [UInt8]) -> Bool {
            var status: UInt8 = 0, data: [UInt8] = [], sysex = false
            for byte in bytes {
                if byte >= 0xf8 {
                    if byte == 0xff { notes.removeAll(); pedals.removeAll(); total = 0 }
                    continue
                }
                if sysex { if byte == 0xf7 { sysex = false }; continue }
                if byte >= 0x80 {
                    if byte == 0xf0 { sysex = true }
                    status = byte; data.removeAll(keepingCapacity: true); continue
                }
                guard status >= 0x80 else { continue }
                data.append(byte)
                let kind = status & 0xf0, channel = Int(status & 15)
                let length = status < 0xf0 ? (kind == 0xc0 || kind == 0xd0 ? 1 : 2) : (status == 0xf2 ? 2 : 1)
                guard data.count == length else { continue }
                let key = channel << 8 | Int(data[0])
                if kind == 0x90 && data[1] > 0 {
                    guard total < 4096 else { return false }
                    notes[key, default: 0] += 1; total += 1
                } else if kind == 0x80 || (kind == 0x90 && data[1] == 0) {
                    if let count = notes[key] {
                        total -= 1
                        if count > 1 { notes[key] = count - 1 } else { notes.removeValue(forKey: key) }
                    }
                } else if kind == 0xb0 {
                    if [64, 66, 69].contains(data[0]) {
                        if data[1] >= 64 { pedals.insert(key) } else { pedals.remove(key) }
                    }
                    if data[0] == 120 || data[0] == 123 {
                        for note in Array(notes.keys) where note >> 8 == channel { total -= notes.removeValue(forKey: note) ?? 0 }
                    }
                    if data[0] == 121 { pedals = Set(pedals.filter { $0 >> 8 != channel }) }
                }
                status = 0; data.removeAll(keepingCapacity: true)
            }
            return true
        }

        mutating func takeReleaseBytes() -> [UInt8] {
            var bytes: [UInt8] = []
            for pedal in pedals.sorted() { bytes += [0xb0 | UInt8(pedal >> 8), UInt8(pedal & 255), 0] }
            for note in notes.keys.sorted() {
                for _ in 0..<(notes[note] ?? 0) { bytes += [0x80 | UInt8(note >> 8), UInt8(note & 255), 0] }
            }
            notes.removeAll(); pedals.removeAll(); total = 0
            return bytes
        }
    }

    static func midiOutputMessage(_ body: [String: Any]) throws -> MIDIOutputMessage {
        let invalid = CocoaError(.fileReadCorruptFile)
        guard let destination = body["destination"] as? String, !destination.isEmpty, destination.utf8.count <= 256,
              let raw = body["data"] as? [Any], !raw.isEmpty, raw.count <= 65535 else { throw invalid }
        var bytes: [UInt8] = []
        var needed = 0, sysex = false
        bytes.reserveCapacity(raw.count)
        for value in raw {
            guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { throw invalid }
            let numeric = number.doubleValue
            guard numeric.isFinite, numeric >= 0, numeric <= 255, numeric.rounded(.towardZero) == numeric else { throw invalid }
            let byte = UInt8(numeric)
            bytes.append(byte)
            if byte >= 0xf8 {
                guard byte != 0xf9 && byte != 0xfd else { throw invalid }
                continue
            }
            if sysex {
                if byte == 0xf7 { sysex = false; continue }
                guard byte < 0x80 else { throw invalid }
                continue
            }
            if needed > 0 { guard byte < 0x80 else { throw invalid }; needed -= 1; continue }
            guard byte >= 0x80 else { throw invalid }
            if byte < 0xf0 { needed = byte & 0xf0 == 0xc0 || byte & 0xf0 == 0xd0 ? 1 : 2; continue }
            switch byte {
            case 0xf0: sysex = true
            case 0xf1, 0xf3: needed = 1
            case 0xf2: needed = 2
            case 0xf6: break
            default: throw invalid
            }
        }
        guard needed == 0, !sysex else { throw invalid }
        return MIDIOutputMessage(destination: destination, bytes: bytes)
    }

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
