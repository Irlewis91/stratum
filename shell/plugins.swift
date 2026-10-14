// STRATUM plugin host: runs Audio Unit instruments and effects installed on the Mac.
// Each plugin track is a strip: instrument -> effects -> strip mixer -> main mixer -> output. Notes arrive from the web
// sequencer with a delay in seconds; mixdowns are rendered offline through the same strips.
import AVFoundation
import Cocoa
import CoreAudioKit

final class PluginHost {
    private final class Strip {
        var inst: AVAudioUnit?
        var instID = ""
        var fx: [AVAudioUnit] = []
        var fxIDs: [String] = []
        let mixer = AVAudioMixerNode()
        var held = Set<UInt8>()
        var windows: [Int: NSWindow] = [:]
    }

    private let engine = AVAudioEngine()
    private var strips: [String: Strip] = [:]
    private let format = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 2)!
    private var pendingOffs: [DispatchWorkItem] = []

    // MARK: catalogue

    private static func code(_ v: OSType) -> String {
        let b = [UInt8(v >> 24 & 255), UInt8(v >> 16 & 255), UInt8(v >> 8 & 255), UInt8(v & 255)]
        return String(bytes: b, encoding: .macOSRoman) ?? "????"
    }
    private static func fourCC(_ s: String) -> OSType {
        var v: OSType = 0
        for b in (s.data(using: .macOSRoman) ?? Data()).prefix(4) { v = v << 8 | OSType(b) }
        return v
    }
    private static func describe(_ id: String) -> AudioComponentDescription? {
        let p = id.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard p.count == 3 else { return nil }
        return AudioComponentDescription(componentType: fourCC(p[0]), componentSubType: fourCC(p[1]), componentManufacturer: fourCC(p[2]), componentFlags: 0, componentFlagsMask: 0)
    }

    /// Installed Audio Units: instruments ("inst") and effects ("fx").
    func list() -> [[String: String]] {
        var out: [[String: String]] = []
        for (type, kind) in [(kAudioUnitType_MusicDevice, "inst"), (kAudioUnitType_Effect, "fx"), (kAudioUnitType_MusicEffect, "fx")] {
            let d = AudioComponentDescription(componentType: type, componentSubType: 0, componentManufacturer: 0, componentFlags: 0, componentFlagsMask: 0)
            for c in AVAudioUnitComponentManager.shared().components(matching: d) {
                let a = c.audioComponentDescription
                out.append(["id": "\(Self.code(a.componentType)):\(Self.code(a.componentSubType)):\(Self.code(a.componentManufacturer))", "name": c.name, "maker": c.manufacturerName, "kind": kind])
            }
        }
        out += VST3Unit.catalogue()
        return out.sorted { ($0["maker"]!.lowercased(), $0["name"]!.lowercased()) < ($1["maker"]!.lowercased(), $1["name"]!.lowercased()) }
    }

    // MARK: strips

    private func strip(_ track: String) -> Strip {
        if let s = strips[track] { return s }
        let s = Strip()
        engine.attach(s.mixer)
        engine.connect(s.mixer, to: engine.mainMixerNode, format: format)
        strips[track] = s
        return s
    }

    private func rewire(_ s: Strip) {
        guard let inst = s.inst else { return }
        var prev: AVAudioNode = inst
        engine.disconnectNodeOutput(inst)
        for f in s.fx { engine.disconnectNodeOutput(f); engine.connect(prev, to: f, format: format); prev = f }
        engine.connect(prev, to: s.mixer, format: format)
        startIfNeeded()
    }

    private func startIfNeeded() {
        guard !engine.isRunning, !engine.isInManualRenderingMode else { return }
        engine.prepare()
        try? engine.start()
    }

    /// VST3 plugins are created one at a time, because the wrapper learns which plugin to load from `VST3Unit.pending`.
    private var v3Queue: [() -> Void] = []
    private var v3Busy = false
    private func nextVST3() {
        guard !v3Busy, !v3Queue.isEmpty else { return }
        v3Busy = true
        v3Queue.removeFirst()()
    }

    private func instantiate(_ id: String, state: String?, done: @escaping (AVAudioUnit?) -> Void) {
        if id.hasPrefix("vst3") {   // VST3 and VST2 plugins both go through the wrapper
            let p = id.split(separator: "|", maxSplits: 2, omittingEmptySubsequences: false).map(String.init)
            guard p.count == 3 else { return done(nil) }
            v3Queue.append { [weak self] in
                VST3Unit.register()
                VST3Unit.pending = (path: p[2], cid: p[1])
                self?.finish(p[0] == "vst3i" ? VST3Unit.instrument : VST3Unit.effect, state: state) { unit in
                    VST3Unit.pending = nil
                    self?.v3Busy = false
                    done(unit)
                    self?.nextVST3()
                }
            }
            return nextVST3()
        }
        guard let desc = Self.describe(id) else { return done(nil) }
        finish(desc, state: state, done: done)
    }

    private func finish(_ desc: AudioComponentDescription, state: String?, done: @escaping (AVAudioUnit?) -> Void) {
        AVAudioUnit.instantiate(with: desc, options: []) { unit, _ in
            DispatchQueue.main.async {
                if let unit = unit, let b64 = state, let data = Data(base64Encoded: b64),
                   let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any] {
                    unit.auAudioUnit.fullState = plist
                }
                done(unit)
            }
        }
    }

    private func drop(_ unit: AVAudioUnit?) {
        guard let unit = unit else { return }
        engine.disconnectNodeOutput(unit)
        engine.detach(unit)
    }

    /// Brings the strips in line with the project. `tracks`: [{id, inst, state, fx: [{id, state}], vol, pan, mute}].
    /// Plugins already loaded on a track are kept (with whatever the user has dialled in); only changes are instantiated.
    func sync(_ tracks: [[String: Any]], done: @escaping ([String]) -> Void) {
        var failed: [String] = []
        let wanted = Set(tracks.compactMap { $0["id"] as? String })
        for (id, s) in strips where !wanted.contains(id) {
            s.windows.values.forEach { $0.close() }
            s.fx.forEach(drop); drop(s.inst)
            engine.disconnectNodeOutput(s.mixer); engine.detach(s.mixer)
            strips[id] = nil
        }
        let group = DispatchGroup()
        for t in tracks {
            guard let id = t["id"] as? String, let instID = t["inst"] as? String else { continue }
            let s = strip(id)
            setMix(id, vol: t["vol"] as? Double ?? 0.8, pan: t["pan"] as? Double ?? 0, mute: t["mute"] as? Bool ?? false)
            let fx = (t["fx"] as? [[String: Any]] ?? [])
            let fxIDs = fx.compactMap { $0["id"] as? String }
            if s.instID == instID && s.fxIDs == fxIDs { continue }
            group.enter()
            let instChanged = s.instID != instID
            let load: (@escaping (AVAudioUnit?) -> Void) -> Void = { [weak self] cb in
                if instChanged { self?.instantiate(instID, state: t["state"] as? String, done: cb) } else { cb(s.inst) }
            }
            load { [weak self] inst in
                guard let self = self else { return group.leave() }
                guard let inst = inst else { failed.append(instID); return group.leave() }
                // Keep effects whose slot is unchanged; load the rest in order.
                var units = [AVAudioUnit?](repeating: nil, count: fxIDs.count)
                let inner = DispatchGroup()
                for (i, fid) in fxIDs.enumerated() {
                    if i < s.fxIDs.count, s.fxIDs[i] == fid { units[i] = s.fx[i]; continue }
                    inner.enter()
                    self.instantiate(fid, state: fx[i]["state"] as? String) { u in
                        if u == nil { failed.append(fid) }
                        units[i] = u; inner.leave()
                    }
                }
                inner.notify(queue: .main) {
                    s.windows.values.forEach { $0.close() }; s.windows = [:]
                    let keep = units.compactMap { $0 }
                    for old in s.fx where !keep.contains(where: { $0 === old }) { self.drop(old) }
                    if instChanged { self.drop(s.inst); self.engine.attach(inst) }
                    for u in keep where u.engine == nil { self.engine.attach(u) }
                    s.inst = inst; s.instID = instID
                    s.fx = keep; s.fxIDs = zip(fxIDs, units).compactMap { $1 == nil ? nil : $0 }
                    self.rewire(s)
                    group.leave()
                }
            }
        }
        group.notify(queue: .main) { done(failed) }
    }

    func setMix(_ track: String, vol: Double, pan: Double, mute: Bool) {
        guard let s = strips[track] else { return }
        s.mixer.outputVolume = mute ? 0 : Float(vol)
        s.mixer.pan = Float(max(-1, min(1, pan)))
    }

    func setMaster(_ vol: Double) { engine.mainMixerNode.outputVolume = Float(vol) }

    // MARK: notes

    private func send(_ s: Strip, _ bytes: [UInt8], after delay: Double) {
        guard let inst = s.inst, let block = inst.auAudioUnit.scheduleMIDIEventBlock else { return }
        var when = AUEventSampleTimeImmediate
        if delay > 0.002, let t = inst.lastRenderTime, t.isSampleTimeValid { when = t.sampleTime + AUEventSampleTime(delay * t.sampleRate) }
        bytes.withUnsafeBufferPointer { block(when, 0, bytes.count, $0.baseAddress!) }
    }

    func note(_ track: String, pitch: Int, velocity: Double, delay: Double, duration: Double) {
        guard let s = strips[track], s.inst != nil else { return }
        startIfNeeded()
        let p = UInt8(max(0, min(127, pitch))), v = UInt8(max(1, min(127, Int(velocity * 127))))
        send(s, [0x90, p, v], after: delay)
        s.held.insert(p)
        let off = DispatchWorkItem { [weak self, weak s] in
            guard let self = self, let s = s else { return }
            self.send(s, [0x80, p, 0], after: 0); s.held.remove(p)
        }
        pendingOffs.append(off)
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, delay) + max(0.02, duration), execute: off)
    }

    /// Stops everything that is sounding or still queued.
    func allOff() {
        pendingOffs.forEach { $0.cancel() }; pendingOffs.removeAll()
        for s in strips.values {
            for p in s.held { send(s, [0x80, p, 0], after: 0) }
            s.held.removeAll()
            send(s, [0xB0, 123, 0], after: 0)
            s.inst?.auAudioUnit.reset()
        }
    }

    /// Peak level over the next moments of live output (used by the plugin self-check).
    private var peak: Float = 0
    private var tapped = false
    func livePeak() -> Float {
        if !tapped {
            tapped = true
            engine.mainMixerNode.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buf, _ in
                guard let ch = buf.floatChannelData else { return }
                for i in 0..<Int(buf.frameLength) { self?.peak = max(self?.peak ?? 0, abs(ch[0][i])) }
            }
        }
        return peak
    }

    // MARK: plugin windows and state

    /// Slot -1 is the instrument; 0... are the effects.
    func showUI(_ track: String, slot: Int, title: String) {
        guard let s = strips[track], let unit = slot < 0 ? s.inst : (slot < s.fx.count ? s.fx[slot] : nil) else { return }
        if let w = s.windows[slot] { w.makeKeyAndOrderFront(nil); return }
        let open: (@escaping (NSViewController?) -> Void) -> Void = { cb in
            if let v3 = unit.auAudioUnit as? VST3Unit { cb(v3.makeEditor()) } else { unit.auAudioUnit.requestViewController(completionHandler: cb) }
        }
        open { [weak s] vc in
            DispatchQueue.main.async {
                let content: NSViewController = vc ?? {
                    let v = NSViewController(); let label = NSTextField(labelWithString: "This plugin has no editor window.")
                    label.frame = NSRect(x: 20, y: 20, width: 320, height: 24); v.view = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 64)); v.view.addSubview(label); return v
                }()
                let w = NSWindow(contentViewController: content)
                w.title = title; w.styleMask = [.titled, .closable, .miniaturizable, .resizable]; w.isReleasedWhenClosed = false
                w.center(); w.makeKeyAndOrderFront(nil)
                s?.windows[slot] = w
            }
        }
    }

    private func state(_ unit: AVAudioUnit?) -> String {
        guard let st = unit?.auAudioUnit.fullState, let d = try? PropertyListSerialization.data(fromPropertyList: st, format: .binary, options: 0) else { return "" }
        return d.base64EncodedString()
    }

    /// Current settings of every loaded plugin: [track: {inst, fx: [...]}], each a base64 property list.
    func states() -> [String: Any] {
        var out: [String: Any] = [:]
        for (id, s) in strips { out[id] = ["inst": state(s.inst), "fx": s.fx.map { state($0) }] }
        return out
    }

    // MARK: offline mixdown

    /// Renders `seconds` of audio from note events [{t: track, p, v, at, d}] (times in seconds). Returns interleaved stereo floats.
    func render(events: [[String: Any]], seconds: Double) throws -> [Float] {
        struct Ev { let at: Int64; let strip: Strip; let bytes: [UInt8] }
        let sr = format.sampleRate
        var evs: [Ev] = []
        for e in events {
            guard let id = e["t"] as? String, let s = strips[id], let p = e["p"] as? Int, let at = e["at"] as? Double else { continue }
            let pitch = UInt8(max(0, min(127, p))), vel = UInt8(max(1, min(127, Int((e["v"] as? Double ?? 0.8) * 127))))
            evs.append(Ev(at: Int64(at * sr), strip: s, bytes: [0x90, pitch, vel]))
            evs.append(Ev(at: Int64((at + max(0.02, e["d"] as? Double ?? 0.25)) * sr), strip: s, bytes: [0x80, pitch, 0]))
        }
        evs.sort { $0.at < $1.at }
        allOff()
        engine.stop()
        try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 1024)
        defer { engine.stop(); engine.disableManualRenderingMode(); startIfNeeded() }
        try engine.start()
        let total = Int64(seconds * sr), buffer = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: 1024)!
        var out = [Float](); out.reserveCapacity(Int(total) * 2)
        var next = 0
        while engine.manualRenderingSampleTime < total {
            let pos = engine.manualRenderingSampleTime, n = AVAudioFrameCount(min(1024, total - pos))
            while next < evs.count, evs[next].at < pos + Int64(n) {
                let e = evs[next]; next += 1
                guard let block = e.strip.inst?.auAudioUnit.scheduleMIDIEventBlock else { continue }
                e.bytes.withUnsafeBufferPointer { block(AUEventSampleTimeImmediate + AUEventSampleTime(max(0, e.at - pos)), 0, 3, $0.baseAddress!) }
            }
            guard try engine.renderOffline(n, to: buffer) == .success, let ch = buffer.floatChannelData else { break }
            for i in 0..<Int(buffer.frameLength) { out.append(ch[0][i]); out.append(ch[1][i]) }
        }
        return out
    }
}

// MARK: - VST3

/// Wraps one VST3 plugin (loaded by vst3host.mm) as an Audio Unit, so the host above treats VST3 and Audio Unit plugins alike.
final class VST3Unit: AUAudioUnit {
    static let stateKey = "stratum.vst3.state"
    static let instrument = AudioComponentDescription(componentType: kAudioUnitType_MusicDevice, componentSubType: 0x7633696E, componentManufacturer: 0x5374726D, componentFlags: 0, componentFlagsMask: 0)
    static let effect = AudioComponentDescription(componentType: kAudioUnitType_Effect, componentSubType: 0x76336678, componentManufacturer: 0x5374726D, componentFlags: 0, componentFlagsMask: 0)
    /// The plugin file and class the next instance should load. Instances are created one at a time (see PluginHost).
    static var pending: (path: String, cid: String)?
    private static var registered = false
    static func register() {
        guard !registered else { return }
        registered = true
        AUAudioUnit.registerSubclass(VST3Unit.self, as: instrument, name: "STRATUM: VST3 Instrument", version: 1)
        AUAudioUnit.registerSubclass(VST3Unit.self, as: effect, name: "STRATUM: VST3 Effect", version: 1)
    }

    /// Buffers the render block uses, allocated once so nothing is allocated on the audio thread.
    private final class Scratch {
        let frames: Int
        let bufs: [UnsafeMutablePointer<Float>]
        let inPtrs = UnsafeMutablePointer<UnsafePointer<Float>?>.allocate(capacity: 2)
        let outPtrs = UnsafeMutablePointer<UnsafeMutablePointer<Float>?>.allocate(capacity: 2)
        let abl = AudioBufferList.allocate(maximumBuffers: 2)
        init(frames: Int) {
            self.frames = frames
            bufs = (0..<4).map { _ in let p = UnsafeMutablePointer<Float>.allocate(capacity: frames); p.initialize(repeating: 0, count: frames); return p }
        }
        deinit { bufs.forEach { $0.deallocate() }; inPtrs.deallocate(); outPtrs.deallocate(); free(abl.unsafeMutablePointer) }
    }

    private let v3: OpaquePointer
    private let isEffect: Bool
    private var inputs: AUAudioUnitBusArray!
    private var outputs: AUAudioUnitBusArray!
    private var scratch = Scratch(frames: 4096)

    override init(componentDescription: AudioComponentDescription, options: AudioComponentInstantiationOptions = []) throws {
        guard let p = VST3Unit.pending else { throw NSError(domain: "STRATUM", code: 2, userInfo: [NSLocalizedDescriptionKey: "No VST3 plugin selected"]) }
        var err = [CChar](repeating: 0, count: 256)
        guard let h = v3_load(p.path, p.cid, &err, 256) else { throw NSError(domain: "STRATUM", code: 3, userInfo: [NSLocalizedDescriptionKey: String(cString: err)]) }
        v3 = h
        isEffect = componentDescription.componentType == kAudioUnitType_Effect
        try super.init(componentDescription: componentDescription, options: options)
        let format = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 2)!
        outputs = AUAudioUnitBusArray(audioUnit: self, busType: .output, busses: [try AUAudioUnitBus(format: format)])
        inputs = AUAudioUnitBusArray(audioUnit: self, busType: .input, busses: isEffect ? [try AUAudioUnitBus(format: format)] : [])
        maximumFramesToRender = 4096
    }
    deinit { v3_destroy(v3) }

    override var inputBusses: AUAudioUnitBusArray { inputs }
    override var outputBusses: AUAudioUnitBusArray { outputs }

    override func allocateRenderResources() throws {
        try super.allocateRenderResources()
        let frames = Int(maximumFramesToRender)
        if scratch.frames < frames { scratch = Scratch(frames: frames) }
        if v3_setup(v3, outputs[0].format.sampleRate, Int32(frames)) == 0 { throw NSError(domain: "STRATUM", code: 4, userInfo: [NSLocalizedDescriptionKey: "The VST3 plugin refused the audio setup"]) }
    }

    override var internalRenderBlock: AUInternalRenderBlock {
        let v3 = self.v3, fx = isEffect, s = scratch
        return { _, timestamp, frameCount, _, outputData, events, pull in
            let n = min(Int(frameCount), s.frames), now = AUEventSampleTime(timestamp.pointee.mSampleTime)
            var ev = events
            while let e = ev {
                if e.pointee.head.eventType == .MIDI {
                    let m = e.pointee.MIDI, status = m.data.0 & 0xF0, off = Int32(max(0, min(AUEventSampleTime(n - 1), m.eventSampleTime - now)))
                    if status == 0x90 && m.data.2 > 0 { v3_note(v3, 1, Int32(m.data.1), Float(m.data.2) / 127, off) }
                    else if status == 0x80 || status == 0x90 { v3_note(v3, 0, Int32(m.data.1), 0, off) }
                }
                ev = UnsafePointer(e.pointee.head.next)
            }
            if fx {
                for c in 0..<2 { s.abl[c] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(n * 4), mData: UnsafeMutableRawPointer(s.bufs[c])) }
                s.abl.unsafeMutablePointer.pointee.mNumberBuffers = 2
                var flags = AudioUnitRenderActionFlags()
                if let pull = pull, pull(&flags, timestamp, AUAudioFrameCount(n), 0, s.abl.unsafeMutablePointer) == noErr {
                    for c in 0..<2 { s.inPtrs[c] = UnsafePointer(s.abl[c].mData?.assumingMemoryBound(to: Float.self) ?? s.bufs[c]) }
                } else {
                    for c in 0..<2 { s.bufs[c].update(repeating: 0, count: n); s.inPtrs[c] = UnsafePointer(s.bufs[c]) }
                }
            }
            let out = UnsafeMutableAudioBufferListPointer(outputData)
            for c in 0..<2 {
                let i = min(c, out.count - 1)
                if out[i].mData == nil { out[i].mData = UnsafeMutableRawPointer(s.bufs[2 + c]) }
                s.outPtrs[c] = c < out.count ? out[i].mData!.assumingMemoryBound(to: Float.self) : s.bufs[2 + c]
            }
            v3_process(v3, fx ? UnsafePointer(s.inPtrs) : nil, UnsafePointer(s.outPtrs), Int32(n))
            return noErr
        }
    }

    override var fullState: [String: Any]? {
        get {
            var data: UnsafeMutablePointer<UInt8>?
            var len: Int32 = 0
            guard v3_get_state(v3, &data, &len) != 0, let d = data else { return [:] }
            defer { v3_free(d) }
            return [VST3Unit.stateKey: Data(bytes: d, count: Int(len))]
        }
        set {
            guard let d = newValue?[VST3Unit.stateKey] as? Data else { return }
            d.withUnsafeBytes { _ = v3_set_state(v3, $0.bindMemory(to: UInt8.self).baseAddress, Int32(d.count)) }
        }
    }

    /// The plugin's own editor, hosted in a plain view. Nil when the plugin has none.
    func makeEditor() -> NSViewController? {
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 480, height: 320))
        var w: Int32 = 0, h: Int32 = 0
        guard v3_open_view(v3, Unmanaged.passUnretained(view).toOpaque(), &w, &h) != 0 else { return nil }
        view.setFrameSize(NSSize(width: Int(max(w, 100)), height: Int(max(h, 60))))
        let vc = NSViewController()
        vc.view = view
        vc.preferredContentSize = view.frame.size
        return vc
    }

    // MARK: finding VST3 plugins

    private static var folders: [String] {
        var f = ["/Library/Audio/Plug-Ins/VST3", NSHomeDirectory() + "/Library/Audio/Plug-Ins/VST3", "/Library/Audio/Plug-Ins/VST", NSHomeDirectory() + "/Library/Audio/Plug-Ins/VST"]
        if let extra = ProcessInfo.processInfo.environment["STRATUM_VST3_PATH"] { f.append(extra) }
        return f
    }

    /// Every VST3 plugin in the standard folders, as catalogue entries. Each bundle is opened once and the result remembered
    /// until the file changes, because opening a plugin runs its code.
    static func catalogue() -> [[String: String]] {
        let fm = FileManager.default, defaults = UserDefaults.standard
        var cache = defaults.dictionary(forKey: "vst3scan") as? [String: [String: Any]] ?? [:]
        var out: [[String: String]] = [], seen = Set<String>()
        for folder in folders {
            guard let walker = fm.enumerator(at: URL(fileURLWithPath: folder), includingPropertiesForKeys: [.contentModificationDateKey]) else { continue }
            for case let url as URL in walker where ["vst3", "vst"].contains(url.pathExtension.lowercased()) {
                walker.skipDescendants()
                let path = url.path, stamp = ((try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast).timeIntervalSince1970
                var classes = cache[path]?["stamp"] as? Double == stamp ? cache[path]?["classes"] as? [[String: String]] : nil
                if classes == nil {
                    var buf = [CChar](repeating: 0, count: 1 << 16)
                    classes = []
                    if v3_scan(path, &buf, Int32(buf.count)) >= 0, let d = String(cString: buf).data(using: .utf8), let j = try? JSONSerialization.jsonObject(with: d) as? [[String: String]] { classes = j }
                    cache[path] = ["stamp": stamp, "classes": classes!]
                }
                seen.insert(path)
                for c in classes! {
                    let inst = (c["sub"] ?? "").contains("Instrument")
                    out.append(["id": "\(inst ? "vst3i" : "vst3f")|\(c["cid"] ?? "")|\(path)", "name": ((c["name"] ?? "").isEmpty ? url.deletingPathExtension().lastPathComponent : c["name"]!) + (c["cid"] == "VST2" ? " (VST2)" : " (VST3)"), "maker": c["vendor"] ?? "", "kind": inst ? "inst" : "fx"])
                }
            }
        }
        defaults.set(cache.filter { seen.contains($0.key) }, forKey: "vst3scan")
        return out
    }
}
