import CoreMIDI
import Foundation
import Darwin

struct NativeMIDIEvent {
    let bytes: [UInt8]
    /// CoreMIDI host monotonic milliseconds; this is not the Web Audio clock.
    let timestamp: Double
    let port: Int
}

/// The CoreMIDI callback only tries a lock and copies into a fixed-capacity ring.
/// Parsing, allocation, device enumeration, and WebKit delivery happen elsewhere.
final class MIDIInput {
    var onBatch: (([NativeMIDIEvent], Int, @escaping () -> Void) -> Void)?
    var onStatus: ((String) -> Void)?
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
    private var sources: [MIDIEndpointRef: Int] = [:]
    private var timer: DispatchSourceTimer?
    private let dropSignal: DispatchSourceUserDataAdd
    private var dropped = 0
    private var needsPanic = false
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
            sources.removeValue(forKey: source)
            needsPanic = true
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
        if needsPanic {
            // Discard the incomplete stream, then silence every logical input channel.
            readIndex = writeIndex
            count = 0
            needsPanic = false
            for port in 0..<8 {
                for channel in UInt8(0)..<16 {
                    events.append(NativeMIDIEvent(bytes: [0xB0 | channel, 120, 0, 0xB0 | channel, 123, 0], timestamp: 0, port: port))
                }
            }
        } else {
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
        if client != 0 { MIDIClientDispose(client) }
        storage.deallocate()
    }
}
