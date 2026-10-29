import Foundation
import Network

/// Read-only bundled assets. The listener is bound to IPv4 loopback, never to a LAN interface.
final class LoopbackServer {
    private let queue = DispatchQueue(label: "org.project128.bundle-server", qos: .userInitiated)
    private var listener: NWListener?
    private var connections: [UUID: NWConnection] = [:]
    private let token = UUID().uuidString.lowercased()

    func start(root: URL, completion: @escaping (Result<URL, Error>) -> Void) {
        queue.async { [weak self] in
            guard let self else { return }
            do {
                let parameters = NWParameters.tcp
                parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
                let listener = try NWListener(using: parameters, on: .any)
                self.listener = listener
                var reported = false
                listener.stateUpdateHandler = { [weak self, weak listener] state in
                    guard let self, let listener else { return }
                    switch state {
                    case .ready:
                        guard !reported, let port = listener.port,
                              let url = URL(string: "http://127.0.0.1:\(port.rawValue)/\(self.token)/") else { return }
                        reported = true
                        DispatchQueue.main.async { completion(.success(url)) }
                    case .failed(let error):
                        guard !reported else { return }
                        reported = true
                        DispatchQueue.main.async { completion(.failure(error)) }
                    default: break
                    }
                }
                listener.newConnectionHandler = { [weak self, weak listener] connection in
                    guard let self, let port = listener?.port,
                          case .hostPort(let host, _) = connection.endpoint,
                          host == .ipv4(.loopback), self.connections.count < 24 else {
                        connection.cancel()
                        return
                    }
                    let id = UUID()
                    self.connections[id] = connection
                    connection.stateUpdateHandler = { [weak self] state in
                        switch state {
                        case .cancelled, .failed:
                            self?.connections.removeValue(forKey: id)
                        default: break
                        }
                    }
                    connection.start(queue: self.queue)
                    self.receive(connection, buffer: Data(), root: root, port: port.rawValue)
                    self.queue.asyncAfter(deadline: .now() + 8) { [weak self, weak connection] in
                        guard let self, let connection, self.connections[id] != nil else { return }
                        connection.cancel()
                    }
                }
                listener.start(queue: self.queue)
            } catch {
                DispatchQueue.main.async { completion(.failure(error)) }
            }
        }
    }

    private func receive(_ connection: NWConnection, buffer: Data, root: URL, port: UInt16) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self, weak connection] data, _, complete, error in
            guard let self, let connection, error == nil else { connection?.cancel(); return }
            var accumulated = buffer
            if let data { accumulated.append(data) }
            if accumulated.count > 16_384 {
                self.sendError(413, connection: connection)
            } else if accumulated.range(of: Data("\r\n\r\n".utf8)) != nil {
                do {
                    let request = try LocalHTTPRequest.parse(accumulated)
                    let file = try LocalHTTPPolicy.resolve(request, root: root, token: self.token, port: port)
                    let body = try Data(contentsOf: file, options: .mappedIfSafe)
                    self.send(LocalHTTPPolicy.response(status: 200, mime: LocalHTTPPolicy.mimeType(for: file), body: body,
                                                       headOnly: request.method == "HEAD"), connection: connection)
                } catch let error as LocalHTTPError {
                    self.sendError(error.status, connection: connection)
                } catch {
                    self.sendError(404, connection: connection)
                }
            } else if complete {
                self.sendError(400, connection: connection)
            } else {
                self.receive(connection, buffer: accumulated, root: root, port: port)
            }
        }
    }

    private func sendError(_ status: Int, connection: NWConnection) {
        send(LocalHTTPPolicy.response(status: status, mime: "text/plain; charset=utf-8", body: Data("Request unavailable.".utf8)), connection: connection)
    }

    private func send(_ bytes: Data, connection: NWConnection) {
        connection.send(content: bytes, completion: .contentProcessed { [weak connection] _ in connection?.cancel() })
    }

    deinit {
        listener?.cancel()
        connections.values.forEach { $0.cancel() }
    }
}
