import CoreMIDI
import Foundation
import Darwin

struct NativeMIDIEvent {
    let bytes: [UInt8]
    /// CoreMIDI host monotonic milliseconds; this is not the Web Audio clock.
    let timestamp: Double
    let port: Int
    var synthesizedReset = false
    var resetBridge = false
}

/// The CoreMIDI callback only tries a lock and copies into a fixed-capacity ring.
/// Parsing, allocation, device enumeration, and WebKit delivery happen elsewhere.
final class MIDIInput {
    var onBatch: (([NativeMIDIEvent], Int, @escaping () -> Void) -> Void)?
    var onStatus: ((String) -> Void)?
    var onPorts: (([[String: Any]], [[String: Any]]) -> Void)?
    var onOutputError: ((String) -> Void)?
    var onOutputReset: ((String) -> Void)?
    private let queue = DispatchQueue(label: "org.project128.midi-delivery", qos: .userInitiated)
    private let lock = NSLock()
    private let capacity = 512
    private let packetBytes = 1024
    private let storage: UnsafeMutableRawPointer
    private var lengths = [Int](repeating: 0, count: 512)
    private var timestamps = [UInt64](repeating: 0, count: 512)
    private var ports = [Int](repeating: 0, count: 512)
    private var readIndex = 0
    private var writeIndex = 0
    private var count = 0
    private var client: MIDIClientRef = 0
    private var inputPort: MIDIPortRef = 0
    private var outputPort: MIDIPortRef = 0
    private var destinations: [String: MIDIEndpointRef] = [:]
    private let outputLock = NSLock()
    private var outputBytesPending = 0
    private var outputMessagesPending = 0
    private var availableOutputIDs = Set<String>() // Protected by outputLock.
    private var blockedOutputIDs = Set<String>() // Protected by outputLock.
    private var outputGenerations: [String: UInt64] = [:] // Invalidates queued sends after recovery.
    private var outputStates: [String: NativeBridgePolicy.MIDIOutputNoteState] = [:] // MIDI queue only.
    private var sources: [MIDIEndpointRef: Int] = [:]
    private var timer: DispatchSourceTimer?
    private let dropSignal: DispatchSourceUserDataAdd
    private var dropped = 0
    private var needsPanic = false
    private var disconnectedInputSlots = Set<Int>()
    private var deliveryInFlight = false
    private var timebase = mach_timebase_info_data_t()
    private let packetOffset = MemoryLayout<MIDIPacketList>.offset(of: \MIDIPacketList.packet)!
    private let dataOffset = MemoryLayout<MIDIPacket>.offset(of: \MIDIPacket.data)!

    init() {
        storage = .allocate(byteCount: 512 * 1024, alignment: 16)
        dropSignal = DispatchSource.makeUserDataAddSource(queue: queue)
        mach_timebase_info(&timebase)
        dropSignal.setEventHandler { [weak self] in
            guard let self else { return }
            self.dropped += Int(self.dropSignal.data)
            self.needsPanic = true
        }
        dropSignal.resume()
    }

    func start() {
        queue.async { [weak self] in
            guard let self, self.client == 0 else { return }
            let clientStatus = MIDIClientCreateWithBlock("Project128 MIDI" as CFString, &self.client) { [weak self] _ in
                self?.queue.async { [weak self] in self?.connectSources() }
            }
            guard clientStatus == noErr else { self.onStatus?("MIDI unavailable (\(clientStatus))"); return }
            let portStatus = MIDIInputPortCreate(self.client, "Project128 Input" as CFString, { list, context, sourceContext in
                guard let context, let sourceContext else { return }
                let sourcePort = Int(bitPattern: sourceContext) - 1
                guard (0..<8).contains(sourcePort) else { return }
                Unmanaged<MIDIInput>.fromOpaque(context).takeUnretainedValue().receive(list, port: sourcePort)
            }, Unmanaged.passUnretained(self).toOpaque(), &self.inputPort)
            guard portStatus == noErr else { self.onStatus?("MIDI input unavailable (\(portStatus))"); return }
            _ = MIDIOutputPortCreate(self.client, "Project128 Output" as CFString, &self.outputPort)
            self.connectSources()
            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(deadline: .now(), repeating: .milliseconds(8), leeway: .milliseconds(1))
            timer.setEventHandler { [weak self] in self?.drain() }
            self.timer = timer
            timer.resume()
        }
    }

    private func connectSources() {
        guard inputPort != 0 else { return }
        let current = Set((0..<MIDIGetNumberOfSources()).map(MIDIGetSource).filter { $0 != 0 })
        for source in Set(sources.keys).subtracting(current) {
            MIDIPortDisconnectSource(inputPort, source)
            if let slot = sources.removeValue(forKey: source) {
                discardBufferedInput(slot)
                disconnectedInputSlots.insert(slot)
            }
        }
        for source in current.subtracting(Set(sources.keys)).sorted() {
            guard let slot = (0..<8).first(where: { !sources.values.contains($0) }) else { break }
            if MIDIPortConnectSource(inputPort, source, UnsafeMutableRawPointer(bitPattern: slot + 1)) == noErr {
                sources[source] = slot
            }
        }
        let excess = max(0, current.count - sources.count)
        let assignments = sources.sorted { $0.value < $1.value }.map { source, slot -> String in
            var value: Unmanaged<CFString>?
            let result = MIDIObjectGetStringProperty(source, kMIDIPropertyDisplayName, &value)
            let name: String
            if result == noErr, let value { name = value.takeRetainedValue() as String }
            else { name = "MIDI source" }
            return "Port \(slot + 1): \(name)"
        }.joined(separator: "\n")
        onStatus?("MIDI: \(sources.count) input\(sources.count == 1 ? "" : "s")\(excess > 0 ? " · \(excess) not connected" : "")\(assignments.isEmpty ? "" : "\n\(assignments)")")
        onPorts?(sourceDescriptions(), destinationDescriptions())
    }

    /// Read endpoint metadata on the same queue that owns the connected sources.
    func describePorts(_ completion: @escaping ([[String: Any]], [[String: Any]]) -> Void) {
        queue.async { [weak self] in completion(self?.sourceDescriptions() ?? [], self?.destinationDescriptions() ?? []) }
    }

    private func sourceDescriptions() -> [[String: Any]] {
        sources.sorted { $0.value < $1.value }.map { source, slot in
            func string(_ property: CFString) -> String {
                var value: Unmanaged<CFString>?
                guard MIDIObjectGetStringProperty(source, property, &value) == noErr, let value else { return "" }
                return String((value.takeRetainedValue() as String).prefix(256))
            }
            var uniqueID: Int32 = 0
            let status = MIDIObjectGetIntegerProperty(source, kMIDIPropertyUniqueID, &uniqueID)
            let identifier = status == noErr && uniqueID != 0 ? "uid-\(uniqueID)" : "endpoint-\(source)"
            return ["id": "coremidi-input-\(identifier)", "name": string(kMIDIPropertyDisplayName),
                    "manufacturer": string(kMIDIPropertyManufacturer), "slot": slot]
        }
    }

    private func destinationDescriptions() -> [[String: Any]] {
        destinations.removeAll()
        guard outputPort != 0 else { return [] }
        let descriptions: [[String: Any]] = (0..<min(MIDIGetNumberOfDestinations(), 64)).compactMap { index in
            let endpoint = MIDIGetDestination(index)
            guard endpoint != 0 else { return nil }
            var uniqueID: Int32 = 0
            let status = MIDIObjectGetIntegerProperty(endpoint, kMIDIPropertyUniqueID, &uniqueID)
            let identifier = status == noErr && uniqueID != 0 ? "uid-\(uniqueID)" : "endpoint-\(endpoint)"
            let id = "coremidi-output-\(identifier)"
            guard destinations[id] == nil else { return nil }
            destinations[id] = endpoint
            func string(_ property: CFString) -> String {
                var value: Unmanaged<CFString>?
                guard MIDIObjectGetStringProperty(endpoint, property, &value) == noErr, let value else { return "" }
                return String((value.takeRetainedValue() as String).prefix(256))
            }
            return ["id": id, "name": string(kMIDIPropertyDisplayName), "manufacturer": string(kMIDIPropertyManufacturer)]
        }
        let available = Set(destinations.keys)
        outputLock.lock()
        availableOutputIDs = available
        blockedOutputIDs.formIntersection(available)
        outputGenerations = outputGenerations.filter { available.contains($0.key) }
        outputLock.unlock()
        outputStates = outputStates.filter { available.contains($0.key) }
        return descriptions
    }

    /// Immediate output on the non-real-time MIDI queue. The reservation bounds
    /// pending work before dispatch; JavaScript cannot enqueue unlimited packets.
    func sendOutput(_ message: NativeBridgePolicy.MIDIOutputMessage) {
        outputLock.lock()
        let available = availableOutputIDs.contains(message.destination) && !blockedOutputIDs.contains(message.destination)
        let accepted = available && outputMessagesPending < 512 && outputBytesPending + message.bytes.count <= 4 * 1024 * 1024
        let generation = outputGenerations[message.destination, default: 0]
        if accepted { outputMessagesPending += 1; outputBytesPending += message.bytes.count }
        let recover = available && !accepted
        if recover { blockedOutputIDs.insert(message.destination); outputGenerations[message.destination] = generation &+ 1 }
        outputLock.unlock()
        guard accepted else {
            // At most one recovery is queued for each of the 64 destinations.
            if recover { queue.async { [weak self] in self?.recoverOutput(message.destination, reason: "MIDI output queue is full.") } }
            return
        }
        queue.async { [weak self] in
            guard let self else { return }
            defer {
                self.outputLock.lock()
                self.outputMessagesPending -= 1; self.outputBytesPending -= message.bytes.count
                self.outputLock.unlock()
            }
            self.outputLock.lock()
            let blocked = self.blockedOutputIDs.contains(message.destination) || self.outputGenerations[message.destination, default: 0] != generation
            self.outputLock.unlock()
            guard !blocked else { return }
            var next = self.outputStates[message.destination] ?? NativeBridgePolicy.MIDIOutputNoteState()
            guard next.record(message.bytes) else {
                self.pauseOutput(message.destination, reason: "Too many unreleased MIDI notes."); return
            }
            let result = self.sendBytes(message.bytes, destination: message.destination)
            if result == noErr { self.outputStates[message.destination] = next }
            else { self.pauseOutput(message.destination, reason: "MIDI output failed (\(result)).") }
        }
    }

    func resumeOutput(_ destination: String) {
        // Native recovery notifies JS after releasing notes. Do not enqueue this
        // unblock: open().then(send) must accept the very first resumed message.
        outputLock.lock(); defer { outputLock.unlock() }
        if availableOutputIDs.contains(destination) { blockedOutputIDs.remove(destination) }
    }

    private func pauseOutput(_ destination: String, reason: String) {
        outputLock.lock()
        let first = blockedOutputIDs.insert(destination).inserted
        if first { outputGenerations[destination, default: 0] &+= 1 }
        outputLock.unlock()
        if first { recoverOutput(destination, reason: reason) }
    }

    private func recoverOutput(_ destination: String, reason: String) {
        var state = outputStates.removeValue(forKey: destination) ?? NativeBridgePolicy.MIDIOutputNoteState()
        let releases = state.takeReleaseBytes()
        let result = releases.isEmpty ? noErr : sendBytes(releases, destination: destination)
        onOutputError?(reason + (result == noErr ? " Routed notes released; output paused." : " Output paused; the device could not receive all note releases."))
        onOutputReset?(destination)
        // Explicit user resume is required; pending ordinary sends stay blocked.
    }

    private func sendBytes(_ bytes: [UInt8], destination: String) -> OSStatus {
        guard outputPort != 0, let endpoint = destinations[destination] else { return -50 }
        let capacity = max(MemoryLayout<MIDIPacketList>.size, bytes.count + 64)
        let buffer = UnsafeMutableRawPointer.allocate(byteCount: capacity, alignment: 16)
        defer { buffer.deallocate() }
        let list = buffer.bindMemory(to: MIDIPacketList.self, capacity: 1)
        let packet = MIDIPacketListInit(list)
        return bytes.withUnsafeBufferPointer { bytes in
            guard let base = bytes.baseAddress,
                  MIDIPacketListAdd(list, capacity, packet, 0, bytes.count, base) != nil else { return -50 }
            return MIDISend(outputPort, endpoint, list)
        }
    }

    /// Keep other sources' packets intact when one input disappears or its slot is reused.
    private func discardBufferedInput(_ port: Int) {
        lock.lock(); defer { lock.unlock() }
        var kept = 0
        for offset in 0..<count {
            let source = (readIndex + offset) % capacity
            guard ports[source] != port else { continue }
            let target = (readIndex + kept) % capacity
            if target != source {
                storage.advanced(by: target * packetBytes).copyMemory(from: storage.advanced(by: source * packetBytes), byteCount: lengths[source])
                lengths[target] = lengths[source]; timestamps[target] = timestamps[source]; ports[target] = ports[source]
            }
            kept += 1
        }
        count = kept; writeIndex = (readIndex + kept) % capacity
    }

    private func receive(_ list: UnsafePointer<MIDIPacketList>, port: Int) {
        guard lock.try() else { dropSignal.add(data: 1); return }
        defer { lock.unlock() }
        var packet = UnsafeRawPointer(list).advanced(by: packetOffset).assumingMemoryBound(to: MIDIPacket.self)
        let packetCount = min(Int(list.pointee.numPackets), 1024)
        if list.pointee.numPackets > 1024 { dropSignal.add(data: 1) }
        for _ in 0..<packetCount {
            let length = Int(packet.pointee.length)
            if length > 0 && length <= packetBytes && count < capacity {
                storage.advanced(by: writeIndex * packetBytes).copyMemory(from: UnsafeRawPointer(packet).advanced(by: dataOffset), byteCount: length)
                lengths[writeIndex] = length
                timestamps[writeIndex] = packet.pointee.timeStamp == 0 ? mach_absolute_time() : packet.pointee.timeStamp
                ports[writeIndex] = port
                writeIndex = (writeIndex + 1) % capacity
                count += 1
            } else if length > 0 { dropSignal.add(data: 1) }
            packet = UnsafePointer(MIDIPacketNext(packet))
        }
    }

    private func drain() {
        guard !deliveryInFlight else { return }
        var events: [NativeMIDIEvent] = []
        lock.lock()
        let resetBridge = needsPanic
        let resetSlots = needsPanic ? Array(0..<8) : disconnectedInputSlots.sorted()
        if needsPanic {
            // A dropped packet invalidates parsers; these CCs affect only the internal synth.
            readIndex = writeIndex
            count = 0
            needsPanic = false
        }
        disconnectedInputSlots.removeAll()
        for port in resetSlots {
            for channel in UInt8(0)..<16 {
                events.append(NativeMIDIEvent(bytes: [0xB0 | channel, 120, 0, 0xB0 | channel, 123, 0], timestamp: 0, port: port,
                                              synthesizedReset: true, resetBridge: resetBridge && channel == 0))
            }
        }
        if !resetBridge {
            for _ in 0..<min(count, 128) {
                let pointer = storage.advanced(by: readIndex * packetBytes).assumingMemoryBound(to: UInt8.self)
                let bytes = Array(UnsafeBufferPointer(start: pointer, count: lengths[readIndex]))
                let milliseconds = Double(timestamps[readIndex]) * Double(timebase.numer) / Double(timebase.denom) / 1_000_000
                events.append(NativeMIDIEvent(bytes: bytes, timestamp: milliseconds, port: ports[readIndex]))
                readIndex = (readIndex + 1) % capacity
                count -= 1
            }
        }
        lock.unlock()
        guard !events.isEmpty, let onBatch else { return }
        deliveryInFlight = true
        onBatch(events, dropped) { [weak self] in
            self?.queue.async { [weak self] in self?.deliveryInFlight = false }
        }
    }

    deinit {
        timer?.cancel()
        dropSignal.cancel()
        if inputPort != 0 { MIDIPortDispose(inputPort) }
        if outputPort != 0 { MIDIPortDispose(outputPort) }
        if client != 0 { MIDIClientDispose(client) }
        storage.deallocate()
    }
}
