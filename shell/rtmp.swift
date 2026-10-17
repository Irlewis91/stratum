// A small RTMP / RTMPS publisher: enough of the protocol to send live H.264 video and AAC audio to Twitch, YouTube,
// Instagram Live Producer, TikTok LIVE and other servers that take a server URL and a stream key.
import Foundation
import Network

final class RTMPPublisher {
    enum State { case idle, connecting, live, failed(String), closed }
    private(set) var state: State = .idle
    var onState: ((State) -> Void)?
    private var conn: NWConnection?
    private let queue = DispatchQueue(label: "stratum.rtmp")
    private var outChunk = 128, inChunk = 128
    private var app = "", tcUrl = "", key = ""
    private var streamID: UInt32 = 0
    private var inbox = Data()
    private var inHeaders: [UInt32: (ts: UInt32, len: Int, type: UInt8, sid: UInt32)] = [:]
    private var partial: [UInt32: Data] = [:]
    private(set) var bytesSent = 0

    /// rtmp://host[:port]/app[/more]  plus the stream key.
    func connect(url: String, key: String) {
        guard let u = URLComponents(string: url), let scheme = u.scheme?.lowercased(), scheme == "rtmp" || scheme == "rtmps", let host = u.host else { return fail("That server address doesn't look like an rtmp:// or rtmps:// URL.") }
        let path = u.percentEncodedPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        app = path.isEmpty ? "live" : path
        tcUrl = "\(scheme)://\(host)\(u.port.map { ":\($0)" } ?? "")/\(app)"
        self.key = key
        let port = NWEndpoint.Port(integerLiteral: UInt16(u.port ?? (scheme == "rtmps" ? 443 : 1935)))
        let params: NWParameters = scheme == "rtmps" ? NWParameters(tls: NWProtocolTLS.Options()) : .tcp
        let c = NWConnection(host: NWEndpoint.Host(host), port: port, using: params)
        conn = c
        set(.connecting)
        c.stateUpdateHandler = { [weak self] s in
            switch s {
            case .ready: self?.handshake()
            case .failed(let e): self?.fail("Could not reach the streaming server: \(e.localizedDescription)")
            default: break
            }
        }
        c.start(queue: queue)
    }

    func close() {
        guard let c = conn else { return }
        if streamID != 0 { command("deleteStream", 6, [.null, .number(Double(streamID))], csid: 3, msid: 0) }
        queue.asyncAfter(deadline: .now() + 0.3) { c.cancel() }
        conn = nil
        set(.closed)
    }

    private func set(_ s: State) { state = s; DispatchQueue.main.async { self.onState?(s) } }
    private func fail(_ m: String) { set(.failed(m)); conn?.cancel(); conn = nil }

    private func send(_ d: Data) {
        bytesSent += d.count
        conn?.send(content: d, completion: .contentProcessed { [weak self] e in if let e = e { self?.fail("The stream connection dropped: \(e.localizedDescription)") } })
    }

    private func receive(_ n: Int, _ done: @escaping (Data) -> Void) {
        conn?.receive(minimumIncompleteLength: n, maximumLength: n) { [weak self] d, _, _, e in
            guard let d = d, d.count == n, e == nil else { self?.fail("The streaming server closed the connection during setup."); return }
            done(d)
        }
    }

    // ---- handshake: C0 C1 -> S0 S1 S2 -> C2 ----
    private func handshake() {
        var c1 = Data(count: 1536)
        for i in 8..<1536 { c1[i] = UInt8.random(in: 0...255) }
        send(Data([3]) + c1)
        receive(1 + 1536 + 1536) { [weak self] s in
            guard let self = self else { return }
            self.send(s.subdata(in: 1..<1537))   // C2 echoes S1
            self.afterHandshake()
            self.readLoop()
        }
    }

    private func afterHandshake() {
        outChunk = 4096
        message(type: 1, csid: 2, msid: 0, ts: 0, payload: be32(UInt32(outChunk)))
        command("connect", 1, [.object([("app", .string(app)), ("type", .string("nonprivate")), ("flashVer", .string("FMLE/3.0 (compatible; STRATUM)")), ("tcUrl", .string(tcUrl))])], csid: 3, msid: 0)
        command("releaseStream", 2, [.null, .string(key)], csid: 3, msid: 0)
        command("FCPublish", 3, [.null, .string(key)], csid: 3, msid: 0)
        command("createStream", 4, [.null], csid: 3, msid: 0)
    }

    // ---- outgoing messages ----
    private func be32(_ v: UInt32) -> Data { Data([UInt8(v >> 24), UInt8(v >> 16 & 255), UInt8(v >> 8 & 255), UInt8(v & 255)]) }

    func message(type: UInt8, csid: UInt8, msid: UInt32, ts: UInt32, payload: Data) {
        var out = Data()
        let ext = ts >= 0xFFFFFF, t = ext ? 0xFFFFFF : ts
        out.append(csid & 0x3F)
        out.append(contentsOf: [UInt8(t >> 16 & 255), UInt8(t >> 8 & 255), UInt8(t & 255)])
        let n = payload.count
        out.append(contentsOf: [UInt8(n >> 16 & 255), UInt8(n >> 8 & 255), UInt8(n & 255), type])
        out.append(contentsOf: [UInt8(msid & 255), UInt8(msid >> 8 & 255), UInt8(msid >> 16 & 255), UInt8(msid >> 24 & 255)])
        if ext { out.append(be32(ts)) }
        var i = 0
        while i < n {
            if i > 0 { out.append(0xC0 | (csid & 0x3F)); if ext { out.append(be32(ts)) } }
            let m = min(outChunk, n - i)
            out.append(payload.subdata(in: payload.startIndex + i ..< payload.startIndex + i + m))
            i += m
        }
        queue.async { self.send(out) }
    }

    private func command(_ name: String, _ tx: Double, _ args: [AMF], csid: UInt8, msid: UInt32) {
        var p = Data()
        AMF.string(name).encode(into: &p); AMF.number(tx).encode(into: &p)
        for a in args { a.encode(into: &p) }
        message(type: 20, csid: csid, msid: msid, ts: 0, payload: p)
    }

    /// Stream metadata, sent once after publishing starts.
    func metadata(width: Int, height: Int, fps: Double, videoKbps: Double, audioKbps: Double) {
        var p = Data()
        AMF.string("@setDataFrame").encode(into: &p); AMF.string("onMetaData").encode(into: &p)
        AMF.ecma([("width", .number(Double(width))), ("height", .number(Double(height))), ("framerate", .number(fps)), ("videocodecid", .number(7)),
                  ("videodatarate", .number(videoKbps)), ("audiocodecid", .number(10)), ("audiodatarate", .number(audioKbps)), ("audiosamplerate", .number(48000)),
                  ("audiosamplesize", .number(16)), ("stereo", .bool(true)), ("encoder", .string("STRATUM"))]).encode(into: &p)
        message(type: 18, csid: 4, msid: streamID, ts: 0, payload: p)
    }
    func video(_ body: Data, ts: UInt32) { if case .live = state { message(type: 9, csid: 6, msid: streamID, ts: ts, payload: body) } }
    func audio(_ body: Data, ts: UInt32) { if case .live = state { message(type: 8, csid: 7, msid: streamID, ts: ts, payload: body) } }
    var isLive: Bool { if case .live = state { return true }; return false }

    // ---- incoming: chunk parsing, just enough for command replies, chunk-size changes and pings ----
    private func readLoop() {
        conn?.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] d, _, done, e in
            guard let self = self else { return }
            if let d = d { self.inbox.append(d); self.parse() }
            if e != nil || done { if case .live = self.state { self.fail("The streaming server ended the stream.") }; return }
            self.readLoop()
        }
    }

    private func parse() {
        while true {
            let b = inbox
            guard b.count >= 1 else { return }
            var o = b.startIndex
            let fmt = b[o] >> 6
            var csid = UInt32(b[o] & 0x3F); o += 1
            if csid == 0 { guard b.count >= 2 else { return }; csid = UInt32(b[o]) + 64; o += 1 }
            else if csid == 1 { guard b.count >= 3 else { return }; csid = UInt32(b[o]) + UInt32(b[o + 1]) * 256 + 64; o += 2 }
            let hlen = [11, 7, 3, 0][Int(fmt)]
            guard b.endIndex - o >= hlen else { return }
            var h = inHeaders[csid] ?? (0, 0, 0, 0)
            if fmt <= 2 {
                h.ts = UInt32(b[o]) << 16 | UInt32(b[o + 1]) << 8 | UInt32(b[o + 2])
                if fmt <= 1 { h.len = Int(b[o + 3]) << 16 | Int(b[o + 4]) << 8 | Int(b[o + 5]); h.type = b[o + 6] }
                if fmt == 0 { h.sid = UInt32(b[o + 7]) | UInt32(b[o + 8]) << 8 | UInt32(b[o + 9]) << 16 | UInt32(b[o + 10]) << 24 }
            }
            o += hlen
            if h.ts == 0xFFFFFF { guard b.endIndex - o >= 4 else { return }; o += 4 }
            let have = partial[csid]?.count ?? 0, take = min(inChunk, h.len - have)
            guard b.endIndex - o >= take else { return }
            partial[csid, default: Data()].append(b.subdata(in: o ..< o + take))
            inbox = Data(b.subdata(in: o + take ..< b.endIndex))
            inHeaders[csid] = h
            if partial[csid]!.count >= h.len { let msg = partial[csid]!; partial[csid] = nil; handle(type: h.type, msg) }
        }
    }

    private func handle(type: UInt8, _ m: Data) {
        switch type {
        case 1: if m.count >= 4 { inChunk = Int(UInt32(m[m.startIndex]) << 24 | UInt32(m[m.startIndex + 1]) << 16 | UInt32(m[m.startIndex + 2]) << 8 | UInt32(m[m.startIndex + 3])) & 0x7FFFFFFF }
        case 4:   // user control: answer pings
            if m.count >= 6, m[m.startIndex + 1] == 6 { message(type: 4, csid: 2, msid: 0, ts: 0, payload: Data([0, 7]) + m.subdata(in: m.startIndex + 2 ..< m.startIndex + 6)) }
        case 20:
            var r = AMFReader(data: m)
            guard let name = r.next()?.stringValue else { return }
            let tx = r.next()?.numberValue ?? 0
            var rest: [AMF] = []
            while let v = r.next() { rest.append(v) }
            if name == "_result" && tx == 4, let sid = rest.compactMap({ $0.numberValue }).first {
                streamID = UInt32(sid)
                command("publish", 5, [.null, .string(key), .string("live")], csid: 8, msid: streamID)
            } else if name == "onStatus", let info = rest.last?.objectValue {
                let code = info.first(where: { $0.0 == "code" })?.1.stringValue ?? "", desc = info.first(where: { $0.0 == "description" })?.1.stringValue ?? code
                if code == "NetStream.Publish.Start" { set(.live) }
                else if code.contains("Failed") || code.contains("BadName") || code.contains("Rejected") || info.first(where: { $0.0 == "level" })?.1.stringValue == "error" { fail("The streaming server refused the stream: \(desc). Check the stream key.") }
            } else if name == "_error" {
                let desc = rest.last?.objectValue?.first(where: { $0.0 == "description" })?.1.stringValue ?? "unknown error"
                fail("The streaming server refused the connection: \(desc)")
            }
        default: break
        }
    }
}

// ---- AMF0, the encoding RTMP commands use ----
indirect enum AMF {
    case number(Double), bool(Bool), string(String), object([(String, AMF)]), ecma([(String, AMF)]), null
    func encode(into d: inout Data) {
        func str(_ s: String) { let u = Array(s.utf8); d.append(contentsOf: [UInt8(u.count >> 8 & 255), UInt8(u.count & 255)]); d.append(contentsOf: u) }
        switch self {
        case .number(let v): d.append(0); var b = v.bitPattern.bigEndian; d.append(Data(bytes: &b, count: 8))
        case .bool(let v): d.append(contentsOf: [1, v ? 1 : 0])
        case .string(let s): d.append(2); str(s)
        case .object(let kv): d.append(3); for (k, v) in kv { str(k); v.encode(into: &d) }; d.append(contentsOf: [0, 0, 9])
        case .ecma(let kv): d.append(8); d.append(contentsOf: [0, 0, 0, UInt8(kv.count)]); for (k, v) in kv { str(k); v.encode(into: &d) }; d.append(contentsOf: [0, 0, 9])
        case .null: d.append(5)
        }
    }
    var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    var numberValue: Double? { if case .number(let n) = self { return n }; return nil }
    var objectValue: [(String, AMF)]? { switch self { case .object(let o), .ecma(let o): return o; default: return nil } }
}

struct AMFReader {
    let data: Data
    var o: Int
    init(data: Data) { self.data = data; o = data.startIndex }
    mutating func u16() -> Int? { guard o + 2 <= data.endIndex else { return nil }; defer { o += 2 }; return Int(data[o]) << 8 | Int(data[o + 1]) }
    mutating func str() -> String? { guard let n = u16(), o + n <= data.endIndex else { return nil }; defer { o += n }; return String(decoding: data[o ..< o + n], as: UTF8.self) }
    mutating func pairs() -> [(String, AMF)] {
        var out: [(String, AMF)] = []
        while let k = str() { if k.isEmpty, o < data.endIndex, data[o] == 9 { o += 1; break }; guard let v = next() else { break }; out.append((k, v)) }
        return out
    }
    mutating func next() -> AMF? {
        guard o < data.endIndex else { return nil }
        let t = data[o]; o += 1
        switch t {
        case 0: guard o + 8 <= data.endIndex else { return nil }; var v: UInt64 = 0; for i in 0..<8 { v = v << 8 | UInt64(data[o + i]) }; o += 8; return .number(Double(bitPattern: v))
        case 1: guard o < data.endIndex else { return nil }; defer { o += 1 }; return .bool(data[o] != 0)
        case 2: return str().map { .string($0) }
        case 3: return .object(pairs())
        case 8: o += 4; return .ecma(pairs())
        case 5, 6: return .null
        default: return nil
        }
    }
}
