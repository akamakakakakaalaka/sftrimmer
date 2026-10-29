import Foundation

enum LocalHTTPError: Error {
    case malformed, forbidden, methodNotAllowed, notFound

    var status: Int {
        switch self {
        case .malformed: return 400
        case .forbidden: return 403
        case .methodNotAllowed: return 405
        case .notFound: return 404
        }
    }
}

struct LocalHTTPRequest {
    let method: String
    let target: String
    let headers: [String: String]

    static func parse(_ data: Data) throws -> LocalHTTPRequest {
        guard data.count <= 16_384,
              let text = String(data: data, encoding: .ascii),
              let end = text.range(of: "\r\n\r\n"), end.upperBound == text.endIndex else {
            throw LocalHTTPError.malformed
        }
        let lines = text[..<end.lowerBound].components(separatedBy: "\r\n")
        guard let first = lines.first, lines.count <= 128 else { throw LocalHTTPError.malformed }
        let parts = first.split(separator: " ", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[2] == "HTTP/1.1", !parts[0].isEmpty, !parts[1].isEmpty else {
            throw LocalHTTPError.malformed
        }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":"), colon != line.startIndex,
                  line.first != " ", line.first != "\t" else { throw LocalHTTPError.malformed }
            let name = String(line[..<colon]).lowercased()
            guard name.utf8.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }),
                  headers[name] == nil else { throw LocalHTTPError.malformed }
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            guard !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else {
                throw LocalHTTPError.malformed
            }
            headers[name] = value
        }
        guard headers["host"] != nil, headers["transfer-encoding"] == nil,
              headers["content-length"] == nil || headers["content-length"] == "0" else {
            throw LocalHTTPError.malformed
        }
        return LocalHTTPRequest(method: String(parts[0]), target: String(parts[1]), headers: headers)
    }
}

enum LocalHTTPPolicy {
    static func resolve(_ request: LocalHTTPRequest, root: URL, token: String, port: UInt16) throws -> URL {
        guard request.method == "GET" || request.method == "HEAD" else { throw LocalHTTPError.methodNotAllowed }
        let host = "127.0.0.1:\(port)"
        guard request.headers["host"] == host,
              request.headers["origin"] == nil || request.headers["origin"] == "http://\(host)",
              request.headers["sec-fetch-site"] != "cross-site" else { throw LocalHTTPError.forbidden }
        guard request.target.hasPrefix("/"), !request.target.hasPrefix("//"),
              !request.target.contains("#"),
              let encodedPath = request.target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first,
              let decodedPath = String(encodedPath).removingPercentEncoding,
              !decodedPath.contains("%"), !decodedPath.contains("\\"),
              !decodedPath.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else {
            throw LocalHTTPError.forbidden
        }
        var components = decodedPath.split(separator: "/").map(String.init)
        guard components.first == token else { throw LocalHTTPError.forbidden }
        components.removeFirst()
        guard components.allSatisfy({ !$0.hasPrefix(".") }) else { throw LocalHTTPError.forbidden }
        if components.isEmpty { components = ["index.html"] }
        let canonicalRoot = root.resolvingSymlinksInPath().standardizedFileURL
        let candidate = components.reduce(canonicalRoot) { $0.appendingPathComponent($1) }
            .resolvingSymlinksInPath().standardizedFileURL
        guard candidate.path.hasPrefix(canonicalRoot.path + "/") else { throw LocalHTTPError.forbidden }
        guard let values = try? candidate.resourceValues(forKeys: [.isRegularFileKey]), values.isRegularFile == true else {
            throw LocalHTTPError.notFound
        }
        return candidate
    }

    static func mimeType(for file: URL) -> String {
        switch file.pathExtension.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "map": return "application/json"
        case "wasm": return "application/wasm"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "ico": return "image/x-icon"
        case "woff2": return "font/woff2"
        case "ogg": return "audio/ogg"
        case "mid", "midi", "rmi": return "audio/midi"
        case "txt": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }

    static func response(status: Int, mime: String, body: Data, headOnly: Bool = false) -> Data {
        let reasons = [200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 413: "Content Too Large", 503: "Service Unavailable"]
        let csp = "default-src 'self' blob:; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' blob: data:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
        let header = "HTTP/1.1 \(status) \(reasons[status] ?? "Error")\r\nContent-Type: \(mime)\r\nContent-Length: \(body.count)\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: same-origin\r\nCross-Origin-Opener-Policy: same-origin\r\nCross-Origin-Embedder-Policy: require-corp\r\nContent-Security-Policy: \(csp)\r\n\r\n"
        var result = Data(header.utf8)
        if !headOnly { result.append(body) }
        return result
    }
}
