import XCTest
@testable import Project128

final class NativeBoundaryTests: XCTestCase {
    private var root: URL!
    private let token = "private-bundle-token"
    private let port: UInt16 = 49152

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("<html>offline</html>".utf8).write(to: root.appendingPathComponent("index.html"))
        try Data([0, 255, 128, 1]).write(to: root.appendingPathComponent("engine.wasm"))
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: root)
    }

    private func request(_ target: String, method: String = "GET", headers: String = "") throws -> LocalHTTPRequest {
        try LocalHTTPRequest.parse(Data("\(method) \(target) HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\n\(headers)\r\n".utf8))
    }

    func testServesIndexAndBinaryWithoutTextConversion() throws {
        let index = try LocalHTTPPolicy.resolve(request("/\(token)/"), root: root, token: token, port: port)
        XCTAssertEqual(index.lastPathComponent, "index.html")
        let wasm = try LocalHTTPPolicy.resolve(request("/\(token)/engine.wasm?v=1"), root: root, token: token, port: port)
        XCTAssertEqual(try Data(contentsOf: wasm), Data([0, 255, 128, 1]))
        XCTAssertEqual(LocalHTTPPolicy.mimeType(for: wasm), "application/wasm")
    }

    func testRejectsTraversalIncludingEncodedAndDoubleEncodedPaths() throws {
        for path in ["../secret", "%2e%2e/secret", "%252e%252e/secret", "..%2fsecret", "..%5csecret", "%00secret"] {
            XCTAssertThrowsError(try LocalHTTPPolicy.resolve(request("/\(token)/\(path)"), root: root, token: token, port: port), path)
        }
    }

    func testRejectsSymlinksEscapingBundle() throws {
        let outside = root.deletingLastPathComponent().appendingPathComponent(UUID().uuidString)
        try Data("secret".utf8).write(to: outside)
        defer { try? FileManager.default.removeItem(at: outside) }
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("escape.txt"), withDestinationURL: outside)
        XCTAssertThrowsError(try LocalHTTPPolicy.resolve(request("/\(token)/escape.txt"), root: root, token: token, port: port))
    }

    func testRejectsForeignHostOriginAndWrongToken() throws {
        let foreignHost = try LocalHTTPRequest.parse(Data("GET /\(token)/ HTTP/1.1\r\nHost: attacker.example:\(port)\r\n\r\n".utf8))
        XCTAssertThrowsError(try LocalHTTPPolicy.resolve(foreignHost, root: root, token: token, port: port))
        XCTAssertThrowsError(try LocalHTTPPolicy.resolve(request("/\(token)/", headers: "Origin: https://attacker.example\r\n"), root: root, token: token, port: port))
        XCTAssertThrowsError(try LocalHTTPPolicy.resolve(request("/wrong-token/"), root: root, token: token, port: port))
        XCTAssertThrowsError(try LocalHTTPPolicy.resolve(request("/\(token)/", headers: "Sec-Fetch-Site: cross-site\r\n"), root: root, token: token, port: port))
    }

    func testRejectsWriteMethodsDuplicateHeadersAndRequestBodies() throws {
        XCTAssertThrowsError(try LocalHTTPPolicy.resolve(request("/\(token)/", method: "POST"), root: root, token: token, port: port))
        XCTAssertThrowsError(try request("/\(token)/", headers: "Host: 127.0.0.1:\(port)\r\n"))
        XCTAssertThrowsError(try request("/\(token)/", headers: "Content-Length: 5\r\n"))
        XCTAssertThrowsError(try request("/\(token)/", headers: "Transfer-Encoding: chunked\r\n"))
        XCTAssertThrowsError(try LocalHTTPRequest.parse(Data("GET / HTTP/1.1\r\nHost: localhost\r\n".utf8)))
    }

    func testHeadReportsOriginalLengthWithoutBody() throws {
        let bytes = LocalHTTPPolicy.response(status: 200, mime: "application/octet-stream", body: Data([0, 255, 128, 1]), headOnly: true)
        let text = String(decoding: bytes, as: UTF8.self)
        XCTAssertTrue(text.contains("Content-Length: 4\r\n"))
        XCTAssertTrue(text.hasSuffix("\r\n\r\n"))
    }

    func testNativeBridgeAcceptsOnlyMainFrameOfExactBundleOrigin() throws {
        let base = try XCTUnwrap(URL(string: "http://127.0.0.1:49152/private-token/"))
        XCTAssertTrue(NativeBridgePolicy.accepts(URL(string: "http://127.0.0.1:49152/private-token/index.html"), mainFrame: true, base: base))
        for source in ["https://127.0.0.1:49152/private-token/", "http://localhost:49152/private-token/", "http://127.0.0.1:49153/private-token/", "http://127.0.0.1:49152/other/", "http://127.0.0.1:49152/private-token-other/index.html"] {
            XCTAssertFalse(NativeBridgePolicy.accepts(URL(string: source), mainFrame: true, base: base))
        }
        XCTAssertFalse(NativeBridgePolicy.accepts(base, mainFrame: false, base: base))
    }

    func testNativeImportClassifiesSupportedFilesAndRefusesUnknownPresets() throws {
        XCTAssertEqual(try NativeBridgePolicy.importKind(filename: "SCORE.MID"), "midi")
        XCTAssertEqual(try NativeBridgePolicy.importKind(filename: "Grand.sf3"), "bank")
        XCTAssertEqual(try NativeBridgePolicy.importKind(filename: "My sound.p128preset"), "preset")
        XCTAssertEqual(try NativeBridgePolicy.importKind(filename: "Backup.p128session"), "session")
        XCTAssertThrowsError(try NativeBridgePolicy.importKind(filename: "sound.kqspreset"))
        XCTAssertThrowsError(try NativeBridgePolicy.importKind(filename: "script.js"))
    }
}
