// STRATUM plugin host: runs Audio Unit instruments and effects installed on the Mac.
// Each plugin track is a strip: instrument -> effects -> strip mixer -> main mixer -> output. Notes arrive from the web
// sequencer with a delay in seconds; mixdowns are rendered offline through the same strips.
import AVFoundation
import Cocoa
import CoreAudioKit

/// Song position and tempo as plugins see it. Written from the main thread, read on the audio thread.
final class Transport {
    var bpm = 120.0
    var playing = false
    var beat0 = 0.0
    var t0 = CFAbsoluteTimeGetCurrent()
    var offlineBeat: Double?
    var seenByVST = 0.0   // last tempo a wrapped VST plugin was given (used by the self-check)
    var beat: Double { offlineBeat ?? (playing ? beat0 + (CFAbsoluteTimeGetCurrent() - t0) * bpm / 60 : beat0) }
    static let shared = Transport()
    /// What Audio Units ask the host for.
    static let context: AUHostMusicalContextBlock = { tempo, sigNum, sigDen, beat, _, downbeat in
        let t = Transport.shared, b = t.beat
        tempo?.pointee = t.bpm; sigNum?.pointee = 4; sigDen?.pointee = 4; beat?.pointee = b; downbeat?.pointee = (b / 4).rounded(.down) * 4
        return true
    }
    static let state: AUHostTransportStateBlock = { flags, sample, _, _ in
        let t = Transport.shared
        flags?.pointee = t.playing || t.offlineBeat != nil ? [.moving] : []
        sample?.pointee = t.beat * 60 / t.bpm * 44100
        return true
    }
}

/// Audio held in memory for the native engine: recordings, loops and one-shots sent over from the web side.
final class Sample {
    let l: UnsafeMutablePointer<Float>, r: UnsafeMutablePointer<Float>
    let count: Int
    let rate: Double
    init(interleaved d: Data, rate: Double) {
        count = d.count / 8; self.rate = rate
        l = .allocate(capacity: max(1, count)); r = .allocate(capacity: max(1, count))
        d.withUnsafeBytes { raw in
            let f = raw.bindMemory(to: Float.self)
            for i in 0..<count { l[i] = f[2 * i]; r[i] = f[2 * i + 1] }
        }
    }
    deinit { l.deallocate(); r.deallocate() }
}

/// Plays samples on one track of the native engine: audio clips, drum pads and sampler notes, mixed into one stereo stream.
final class VoiceBank {
    struct Voice {
        var active = false
        var sample: Unmanaged<Sample>?
        var pos = 0.0, step = 1.0
        var gain: Float = 1
        var start: Int64 = 0        // engine sample time at which the voice begins
        var hold = Int.max          // output frames before the release begins
        var attack = 0, release = 1, age = 0, released = -1
        var loop = false
    }
    static let size = 96
    private let voices = UnsafeMutablePointer<Voice>.allocate(capacity: VoiceBank.size)
    private var lock = os_unfair_lock()
    init() { voices.initialize(repeating: Voice(), count: VoiceBank.size) }
    deinit { clear(); voices.deallocate() }

    func add(_ v: Voice) {
        os_unfair_lock_lock(&lock)
        var slot = 0, oldest = -1
        for i in 0..<VoiceBank.size { if !voices[i].active { slot = i; oldest = -2; break }; if voices[i].age > oldest { oldest = voices[i].age; slot = i } }
        voices[slot].sample?.release()
        voices[slot] = v; voices[slot].active = true
        os_unfair_lock_unlock(&lock)
    }
    func clear() {
        os_unfair_lock_lock(&lock)
        for i in 0..<VoiceBank.size { voices[i].sample?.release(); voices[i] = Voice() }
        os_unfair_lock_unlock(&lock)
    }
    func render(time: Int64, frames: Int, l: UnsafeMutablePointer<Float>, r: UnsafeMutablePointer<Float>) {
        l.update(repeating: 0, count: frames); r.update(repeating: 0, count: frames)
        guard os_unfair_lock_trylock(&lock) else { return }
        for i in 0..<VoiceBank.size where voices[i].active {
            var v = voices[i]
            guard let smp = v.sample?.takeUnretainedValue() else { voices[i].active = false; continue }
            var done = false
            let from = Int(max(0, min(Int64(frames), v.start - time)))   // a voice may start after this block
            for f in from..<frames {
                var env: Float = v.attack > 0 && v.age < v.attack ? Float(v.age) / Float(v.attack) : 1
                if v.age >= v.hold { v.released += 1; env *= max(0, 1 - Float(v.released) / Float(v.release)); if v.released >= v.release { done = true; break } }
                var i0 = Int(v.pos)
                if i0 >= smp.count - 1 { if v.loop && smp.count > 1 { v.pos -= Double(smp.count - 1); i0 = Int(v.pos) } else { done = true; break } }
                let fr = Float(v.pos - Double(i0)), g = v.gain * env
                l[f] += (smp.l[i0] + (smp.l[i0 + 1] - smp.l[i0]) * fr) * g
                r[f] += (smp.r[i0] + (smp.r[i0 + 1] - smp.r[i0]) * fr) * g
                v.pos += v.step; v.age += 1
            }
            if done { v.active = false }
            voices[i] = v
        }
        os_unfair_lock_unlock(&lock)
    }
}

final class PluginHost {
    private final class Strip {
        var inst: AVAudioUnit?
        var bank: VoiceBank?            // tracks without a plugin instrument play their own audio through this
        var bankNode: AVAudioSourceNode?
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
    private var samples: [String: Sample] = [:]

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
        out += AirwinUnit.catalogue()
        out += WaveUnit.catalogue()
        out += TuneUnit.catalogue()
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
        guard let src: AVAudioNode = s.inst ?? s.bankNode else { return }
        var prev: AVAudioNode = src
        engine.disconnectNodeOutput(src)
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
        if id == TuneUnit.id {
            TuneUnit.register()
            return finish(TuneUnit.effect, state: state, done: done)
        }
        if id == WaveUnit.id {
            WaveUnit.register()
            return finish(WaveUnit.instrument, state: state, done: done)
        }
        if id.hasPrefix("aw|") {   // Airwindows effects are built in and created through the same one-at-a-time queue
            let name = String(id.dropFirst(3))
            v3Queue.append { [weak self] in
                AirwinUnit.register()
                AirwinUnit.pending = name
                self?.finish(AirwinUnit.effect, state: state) { unit in
                    AirwinUnit.pending = nil
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
                unit?.auAudioUnit.musicalContextBlock = Transport.context
                unit?.auAudioUnit.transportStateBlock = Transport.state
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
            if let b = s.bankNode { engine.disconnectNodeOutput(b); engine.detach(b) }
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
            if s.instID == instID && s.fxIDs == fxIDs && (s.inst != nil || s.bankNode != nil) { continue }
            group.enter()
            let instChanged = s.instID != instID || (s.inst == nil && s.bankNode == nil)
            let load: (@escaping (AVAudioUnit?) -> Void) -> Void = { [weak self] cb in
                if instID.isEmpty { cb(nil) } else if instChanged { self?.instantiate(instID, state: t["state"] as? String, done: cb) } else { cb(s.inst) }
            }
            load { [weak self] inst in
                guard let self = self else { return group.leave() }
                if inst == nil && !instID.isEmpty { failed.append(instID); return group.leave() }
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
                    if instChanged {
                        self.drop(s.inst)
                        if let inst = inst { self.engine.attach(inst) }
                    }
                    if instID.isEmpty, s.bankNode == nil {
                        let bank = VoiceBank()
                        let node = AVAudioSourceNode(format: self.format) { _, ts, frames, abl in
                            let out = UnsafeMutableAudioBufferListPointer(abl)
                            guard out.count >= 2, let l = out[0].mData, let r = out[1].mData else { return noErr }
                            bank.render(time: Int64(ts.pointee.mSampleTime), frames: Int(frames), l: l.assumingMemoryBound(to: Float.self), r: r.assumingMemoryBound(to: Float.self))
                            return noErr
                        }
                        self.engine.attach(node)
                        s.bank = bank; s.bankNode = node
                    } else if !instID.isEmpty, let b = s.bankNode {
                        self.engine.disconnectNodeOutput(b); self.engine.detach(b)
                        s.bank = nil; s.bankNode = nil
                    }
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

    // MARK: samples

    func addSample(_ key: String, rate: Double, data: Data) { samples[key] = Sample(interleaved: data, rate: rate) }
    /// Forget audio the project no longer uses.
    func keepSamples(_ keys: Set<String>) { for k in samples.keys where !keys.contains(k) { samples[k] = nil } }

    private func voice(_ e: [String: Any], start: Int64) -> VoiceBank.Voice? {
        guard let key = e["key"] as? String, let smp = samples[key] else { return nil }
        let sr = format.sampleRate
        var v = VoiceBank.Voice()
        v.sample = Unmanaged.passRetained(smp)
        v.step = (e["rate"] as? Double ?? 1) * smp.rate / sr
        v.pos = max(0, (e["off"] as? Double ?? 0) * smp.rate)
        v.gain = Float(e["gain"] as? Double ?? 1)
        v.start = start
        v.attack = Int((e["att"] as? Double ?? 0) * sr)
        v.release = max(1, Int((e["rel"] as? Double ?? 0.004) * sr))
        if let d = e["d"] as? Double { v.hold = max(v.attack, Int(d * sr)) }
        v.loop = e["loop"] as? Bool ?? false
        return v
    }

    /// Starts a sample on a track: {t, key, delay, off, d, gain, rate, att, rel, loop} (seconds).
    func play(_ e: [String: Any]) {
        guard let s = strips[e["t"] as? String ?? ""], let bank = s.bank, let node = s.bankNode else { return }
        startIfNeeded()
        let delay = e["delay"] as? Double ?? 0
        var start: Int64 = 0
        if delay > 0.002, let t = node.lastRenderTime, t.isSampleTimeValid { start = t.sampleTime + Int64(delay * t.sampleRate) }
        if let v = voice(e, start: start) { bank.add(v) }
    }

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
            s.bank?.clear()
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
    private func unit(_ track: String, _ slot: Int) -> AVAudioUnit? {
        guard let s = strips[track] else { return nil }
        return slot < 0 ? s.inst : (slot < s.fx.count ? s.fx[slot] : nil)
    }

    /// A plugin's controls as STRATUM shows them: [{i, name, v (0...1), text}].
    func params(_ track: String, slot: Int) -> [[String: Any]] {
        guard let u = unit(track, slot), let tree = u.auAudioUnit.parameterTree else { return [] }
        return tree.allParameters.prefix(64).map { p in
            let span = max(1e-9, p.maxValue - p.minValue)
            var e: [String: Any] = ["i": Int(p.address), "name": p.displayName, "v": Double((p.value - p.minValue) / span), "text": p.string(fromValue: nil)]
            if let opts = p.valueStrings { e["options"] = opts; e["index"] = Int(p.value.rounded()) }
            return e
        }
    }

    /// Sets one control from a 0...1 position and returns its new display text.
    func setParam(_ track: String, slot: Int, address: Int, value: Double) -> String {
        guard let u = unit(track, slot), let p = u.auAudioUnit.parameterTree?.parameter(withAddress: AUParameterAddress(address)) else { return "" }
        p.value = p.minValue + Float(max(0, min(1, value))) * (p.maxValue - p.minValue)
        if p.valueStrings != nil { p.value = p.value.rounded() }
        return p.string(fromValue: nil)
    }

    // STRATUM Wave on a track: presets, wavetable import and the waveform display.
    private func wave(_ track: String) -> WaveUnit? { unit(track, -1)?.auAudioUnit as? WaveUnit }
    /// What STRATUM Tune on a track hears right now: [detected note, target note] (MIDI numbers, 0 when silent).
    func tuneMeter(_ track: String, slot: Int) -> [Double] {
        guard let t = unit(track, slot)?.auAudioUnit as? TuneUnit else { return [] }
        return [Double(tn_detected(t.tune)), Double(tn_target(t.tune))]
    }
    func wavePresets() -> [String] { (0..<Int(ws_preset_count())).map { String(cString: ws_preset_name(Int32($0))) } }
    func wavePreset(_ track: String, _ i: Int) -> Bool {
        guard let w = wave(track) else { return false }
        ws_preset(w.synth, Int32(i)); w.refreshParameters(); return true
    }
    func waveTable(_ track: String, osc: Int, data: Data, name: String) -> Bool {
        guard let w = wave(track), data.count >= 2048 * 4 else { return false }
        data.withUnsafeBytes { ws_load_table(w.synth, Int32(osc), $0.bindMemory(to: Float.self).baseAddress, Int32(data.count / (2048 * 4)), name) }
        w.refreshParameters(); return true
    }
    func waveFrame(_ track: String, osc: Int) -> [Double] {
        guard let w = wave(track) else { return [] }
        var out = [Float](repeating: 0, count: 128)
        ws_frame(w.synth, Int32(osc), &out, 128)
        return out.map { Double($0) }
    }

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
    func render(events: [[String: Any]], seconds: Double, lead: Double = 0.05) throws -> [Float] {
        struct Ev { let at: Int64; let strip: Strip; let bytes: [UInt8] }
        let sr = format.sampleRate
        var evs: [Ev] = []
        var plays: [(at: Int64, strip: Strip, e: [String: Any])] = []
        for e in events {
            guard let id = e["t"] as? String, let s = strips[id], let at = e["at"] as? Double else { continue }
            if e["key"] != nil { plays.append((Int64(at * sr), s, e)); continue }
            guard let p = e["p"] as? Int else { continue }
            let pitch = UInt8(max(0, min(127, p))), vel = UInt8(max(1, min(127, Int((e["v"] as? Double ?? 0.8) * 127))))
            evs.append(Ev(at: Int64(at * sr), strip: s, bytes: [0x90, pitch, vel]))
            evs.append(Ev(at: Int64((at + max(0.02, e["d"] as? Double ?? 0.25)) * sr), strip: s, bytes: [0x80, pitch, 0]))
        }
        evs.sort { $0.at < $1.at }
        plays.sort { $0.at < $1.at }
        var nextPlay = 0
        allOff()
        engine.stop()
        try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 1024)
        defer { engine.stop(); engine.disableManualRenderingMode(); Transport.shared.offlineBeat = nil; allOff(); startIfNeeded() }
        try engine.start()
        let total = Int64(seconds * sr), buffer = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: 1024)!
        var out = [Float](); out.reserveCapacity(Int(total) * 2)
        var next = 0
        while engine.manualRenderingSampleTime < total {
            let pos = engine.manualRenderingSampleTime, n = AVAudioFrameCount(min(1024, total - pos))
            Transport.shared.offlineBeat = max(0, Double(pos) / sr - lead) * Transport.shared.bpm / 60
            while nextPlay < plays.count, plays[nextPlay].at < pos + Int64(n) {
                let p = plays[nextPlay]; nextPlay += 1
                if let v = voice(p.e, start: p.at) { p.strip.bank?.add(v) }
            }
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
            let tr = Transport.shared
            tr.seenByVST = tr.bpm
            v3_transport(v3, tr.bpm, tr.beat, tr.playing || tr.offlineBeat != nil ? 1 : 0)
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

// MARK: - Airwindows

/// One Airwindows effect (compiled in from Airwindows Consolidated, MIT licence) wrapped as an Audio Unit effect, with its
/// controls published as Audio Unit parameters so STRATUM can show them.
final class AirwinUnit: AUAudioUnit {
    static let effect = AudioComponentDescription(componentType: kAudioUnitType_Effect, componentSubType: 0x61776678, componentManufacturer: 0x5374726D, componentFlags: 0, componentFlagsMask: 0)
    static let stateKey = "stratum.airwindows"
    /// The effect the next instance should be. Instances are created one at a time (see PluginHost).
    static var pending: String?
    private static var registered = false
    static func register() {
        guard !registered else { return }
        registered = true
        AUAudioUnit.registerSubclass(AirwinUnit.self, as: effect, name: "STRATUM: Airwindows", version: 1)
    }

    static func catalogue() -> [[String: String]] {
        (0..<Int(aw_count())).map { i in
            ["id": "aw|" + String(cString: aw_name(Int32(i))), "name": String(cString: aw_name(Int32(i))), "maker": "Airwindows", "kind": "fx",
             "category": String(cString: aw_category(Int32(i))), "what": String(cString: aw_what(Int32(i))), "collections": String(cString: aw_collections(Int32(i)))]
        }
    }

    private let fx: UnsafeMutableRawPointer
    private var inputs: AUAudioUnitBusArray!
    private var outputs: AUAudioUnitBusArray!
    private var frames = 0
    private var bufs: [UnsafeMutablePointer<Float>] = []
    private let inPtrs = UnsafeMutablePointer<UnsafeMutablePointer<Float>?>.allocate(capacity: 2)
    private let outPtrs = UnsafeMutablePointer<UnsafeMutablePointer<Float>?>.allocate(capacity: 2)
    private let abl = AudioBufferList.allocate(maximumBuffers: 2)

    override init(componentDescription: AudioComponentDescription, options: AudioComponentInstantiationOptions = []) throws {
        guard let name = AirwinUnit.pending, let made = aw_create(name, 44100) else { throw NSError(domain: "STRATUM", code: 5, userInfo: [NSLocalizedDescriptionKey: "Unknown Airwindows effect"]) }
        fx = made
        try super.init(componentDescription: componentDescription, options: options)
        let format = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 2)!
        outputs = AUAudioUnitBusArray(audioUnit: self, busType: .output, busses: [try AUAudioUnitBus(format: format)])
        inputs = AUAudioUnitBusArray(audioUnit: self, busType: .input, busses: [try AUAudioUnitBus(format: format)])
        maximumFramesToRender = 4096
        let params: [AUParameter] = (0..<Int(aw_params(fx))).map { i in
            var t = [CChar](repeating: 0, count: 256)
            aw_param_name(fx, Int32(i), &t, 256)
            let p = AUParameterTree.createParameter(withIdentifier: "p\(i)", name: String(cString: t), address: AUParameterAddress(i), min: 0, max: 1, unit: .generic, unitName: nil,
                                                    flags: [.flag_IsReadable, .flag_IsWritable], valueStrings: nil, dependentParameters: nil)
            p.value = aw_get(fx, Int32(i))
            return p
        }
        let tree = AUParameterTree.createTree(withChildren: params), fx = self.fx
        tree.implementorValueObserver = { p, v in aw_set(fx, Int32(p.address), v) }
        tree.implementorValueProvider = { p in aw_get(fx, Int32(p.address)) }
        tree.implementorStringFromValueCallback = { p, _ in
            var t = [CChar](repeating: 0, count: 256)
            aw_param_display(fx, Int32(p.address), &t, 256)
            return String(cString: t)
        }
        parameterTree = tree
    }
    deinit {
        aw_destroy(fx)
        bufs.forEach { $0.deallocate() }
        inPtrs.deallocate(); outPtrs.deallocate(); free(abl.unsafeMutablePointer)
    }

    override var inputBusses: AUAudioUnitBusArray { inputs }
    override var outputBusses: AUAudioUnitBusArray { outputs }

    override func allocateRenderResources() throws {
        try super.allocateRenderResources()
        aw_set_rate(fx, outputs[0].format.sampleRate)
        let n = Int(maximumFramesToRender)
        if n > frames { bufs.forEach { $0.deallocate() }; bufs = (0..<4).map { _ in .allocate(capacity: n) }; frames = n }
    }

    override var internalRenderBlock: AUInternalRenderBlock {
        let fx = self.fx, inPtrs = self.inPtrs, outPtrs = self.outPtrs, abl = self.abl, bufs = { [unowned self] in self.bufs }, cap = { [unowned self] in self.frames }
        return { _, timestamp, frameCount, _, outputData, _, pull in
            let b = bufs(), n = min(Int(frameCount), cap())
            guard b.count == 4, n > 0 else { return noErr }
            for c in 0..<2 { abl[c] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(n * 4), mData: UnsafeMutableRawPointer(b[c])) }
            abl.unsafeMutablePointer.pointee.mNumberBuffers = 2
            var flags = AudioUnitRenderActionFlags()
            if let pull = pull, pull(&flags, timestamp, AUAudioFrameCount(n), 0, abl.unsafeMutablePointer) == noErr {
                for c in 0..<2 { inPtrs[c] = abl[c].mData?.assumingMemoryBound(to: Float.self) ?? b[c] }
            } else {
                for c in 0..<2 { b[c].update(repeating: 0, count: n); inPtrs[c] = b[c] }
            }
            let out = UnsafeMutableAudioBufferListPointer(outputData)
            for c in 0..<2 {
                let i = min(c, out.count - 1)
                if out[i].mData == nil { out[i].mData = UnsafeMutableRawPointer(b[2 + c]) }
                outPtrs[c] = out[i].mData!.assumingMemoryBound(to: Float.self)
            }
            aw_process(fx, inPtrs, outPtrs, Int32(n))
            return noErr
        }
    }

    override var fullState: [String: Any]? {
        get { [AirwinUnit.stateKey: (0..<Int(aw_params(fx))).map { Double(aw_get(fx, Int32($0))) }] }
        set {
            guard let v = newValue?[AirwinUnit.stateKey] as? [Double] else { return }
            for (i, x) in v.enumerated() { aw_set(fx, Int32(i), Float(x)); parameterTree?.parameter(withAddress: AUParameterAddress(i))?.value = Float(x) }
        }
    }
}

// MARK: - STRATUM Wave

/// STRATUM's own wavetable synthesizer (wavesynth.cpp) as an Audio Unit instrument. Its controls are Audio Unit parameters,
/// so the Devices panel can show them; custom wavetables travel in the saved state.
final class WaveUnit: AUAudioUnit {
    static let instrument = AudioComponentDescription(componentType: kAudioUnitType_MusicDevice, componentSubType: 0x77617665, componentManufacturer: 0x5374726D, componentFlags: 0, componentFlagsMask: 0)
    static let id = "stratum|wave"
    private static var registered = false
    static func register() {
        guard !registered else { return }
        registered = true
        AUAudioUnit.registerSubclass(WaveUnit.self, as: instrument, name: "STRATUM: Wave", version: 1)
    }
    static func catalogue() -> [[String: String]] {
        [["id": id, "name": "STRATUM Wave", "maker": "STRATUM", "kind": "inst", "category": "Wavetable synth", "what": "STRATUM's own wavetable synthesizer.", "collections": "Recommended"]]
    }

    let synth: UnsafeMutableRawPointer
    private var outputs: AUAudioUnitBusArray!
    private var frames = 0
    private var bufs: [UnsafeMutablePointer<Float>] = []

    override init(componentDescription: AudioComponentDescription, options: AudioComponentInstantiationOptions = []) throws {
        synth = ws_create(44100)
        try super.init(componentDescription: componentDescription, options: options)
        outputs = AUAudioUnitBusArray(audioUnit: self, busType: .output, busses: [try AUAudioUnitBus(format: AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 2)!)])
        maximumFramesToRender = 4096
        let s = synth
        let params: [AUParameter] = (0..<Int(ws_param_count())).map { i in
            let name = String(cString: ws_param_name(Int32(i))), n = Int(ws_param_options(Int32(i)))
            let indexed = ws_param_kind(Int32(i)) == 1
            let labels = indexed ? (0..<n).map { String(cString: ws_param_option(Int32(i), Int32($0))) } : nil
            let p = AUParameterTree.createParameter(withIdentifier: "w\(i)", name: name, address: AUParameterAddress(i), min: 0, max: indexed ? AUValue(n - 1) : 1,
                                                    unit: indexed ? .indexed : .generic, unitName: nil, flags: [.flag_IsReadable, .flag_IsWritable], valueStrings: labels, dependentParameters: nil)
            p.value = ws_get(s, Int32(i))
            return p
        }
        let tree = AUParameterTree.createTree(withChildren: params)
        tree.implementorValueObserver = { p, v in ws_set(s, Int32(p.address), v) }
        tree.implementorValueProvider = { p in ws_get(s, Int32(p.address)) }
        tree.implementorStringFromValueCallback = { p, _ in
            var t = [CChar](repeating: 0, count: 128)
            ws_display(s, Int32(p.address), &t, 128)
            return String(cString: t)
        }
        parameterTree = tree
    }
    deinit { ws_destroy(synth); bufs.forEach { $0.deallocate() } }

    override var outputBusses: AUAudioUnitBusArray { outputs }

    override func allocateRenderResources() throws {
        try super.allocateRenderResources()
        ws_set_rate(synth, outputs[0].format.sampleRate)
        let n = Int(maximumFramesToRender)
        if n > frames { bufs.forEach { $0.deallocate() }; bufs = (0..<2).map { _ in .allocate(capacity: n) }; frames = n }
    }

    /// Re-reads every parameter after the engine changed them itself (a preset or an imported table).
    func refreshParameters() {
        for p in parameterTree?.allParameters ?? [] { p.setValue(ws_get(synth, Int32(p.address)), originator: nil) }
    }

    override var internalRenderBlock: AUInternalRenderBlock {
        let s = synth, bufs = { [unowned self] in self.bufs }, cap = { [unowned self] in self.frames }
        return { _, timestamp, frameCount, _, outputData, events, _ in
            let b = bufs(), n = min(Int(frameCount), cap())
            guard b.count == 2, n > 0 else { return noErr }
            let now = AUEventSampleTime(timestamp.pointee.mSampleTime)
            var ev = events
            while let e = ev {
                if e.pointee.head.eventType == .MIDI {
                    let m = e.pointee.MIDI, status = m.data.0 & 0xF0, off = Int32(max(0, min(AUEventSampleTime(n - 1), m.eventSampleTime - now)))
                    if status == 0x90 && m.data.2 > 0 { ws_note(s, 1, Int32(m.data.1), Float(m.data.2) / 127, off) }
                    else if status == 0x80 || status == 0x90 { ws_note(s, 0, Int32(m.data.1), 0, off) }
                    else if status == 0xB0 && (m.data.1 == 123 || m.data.1 == 120) { ws_all_off(s) }
                }
                ev = UnsafePointer(e.pointee.head.next)
            }
            let tr = Transport.shared
            ws_transport(s, tr.bpm, tr.beat)
            let out = UnsafeMutableAudioBufferListPointer(outputData)
            for c in 0..<min(2, out.count) where out[c].mData == nil { out[c].mData = UnsafeMutableRawPointer(b[c]) }
            let l = out[0].mData!.assumingMemoryBound(to: Float.self), r = out.count > 1 ? out[1].mData!.assumingMemoryBound(to: Float.self) : b[1]
            ws_process(s, l, r, Int32(n))
            return noErr
        }
    }

    override var fullState: [String: Any]? {
        get {
            var st: [String: Any] = ["stratum.wave": (0..<Int(ws_param_count())).map { Double(ws_get(synth, Int32($0))) }]
            for osc in 0..<2 {
                var data: UnsafePointer<Float>?, name: UnsafePointer<CChar>?
                let n = Int(ws_custom_table(synth, Int32(osc), &data, &name))
                if n > 0, let d = data { st["stratum.wave.table\(osc)"] = Data(bytes: d, count: n * 2048 * 4); st["stratum.wave.name\(osc)"] = String(cString: name!) }
            }
            return st
        }
        set {
            guard let st = newValue else { return }
            for osc in 0..<2 {
                if let d = st["stratum.wave.table\(osc)"] as? Data {
                    let name = st["stratum.wave.name\(osc)"] as? String ?? "Imported"
                    d.withUnsafeBytes { ws_load_table(synth, Int32(osc), $0.bindMemory(to: Float.self).baseAddress, Int32(d.count / (2048 * 4)), name) }
                }
            }
            if let v = st["stratum.wave"] as? [Double] { for (i, x) in v.enumerated() { ws_set(synth, Int32(i), Float(x)) } }
            refreshParameters()
        }
    }
}

// MARK: - STRATUM Tune

/// STRATUM's own pitch correction (tune.cpp) as an Audio Unit effect, with its controls as parameters.
final class TuneUnit: AUAudioUnit {
    static let effect = AudioComponentDescription(componentType: kAudioUnitType_Effect, componentSubType: 0x74756E65, componentManufacturer: 0x5374726D, componentFlags: 0, componentFlagsMask: 0)
    static let id = "stratum|tune"
    private static var registered = false
    static func register() {
        guard !registered else { return }
        registered = true
        AUAudioUnit.registerSubclass(TuneUnit.self, as: effect, name: "STRATUM: Tune", version: 1)
    }
    static func catalogue() -> [[String: String]] {
        [["id": id, "name": "STRATUM Tune", "maker": "STRATUM", "kind": "fx", "category": "Pitch correction", "what": "Pulls vocals and other single notes to the nearest note in the song's key.", "collections": "Recommended"]]
    }

    let tune: UnsafeMutableRawPointer
    private var inputs: AUAudioUnitBusArray!
    private var outputs: AUAudioUnitBusArray!
    private var frames = 0
    private var bufs: [UnsafeMutablePointer<Float>] = []
    private let inPtrs = UnsafeMutablePointer<UnsafePointer<Float>?>.allocate(capacity: 2)
    private let outPtrs = UnsafeMutablePointer<UnsafeMutablePointer<Float>?>.allocate(capacity: 2)
    private let abl = AudioBufferList.allocate(maximumBuffers: 2)

    override init(componentDescription: AudioComponentDescription, options: AudioComponentInstantiationOptions = []) throws {
        tune = tn_create(44100)
        try super.init(componentDescription: componentDescription, options: options)
        let format = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 2)!
        outputs = AUAudioUnitBusArray(audioUnit: self, busType: .output, busses: [try AUAudioUnitBus(format: format)])
        inputs = AUAudioUnitBusArray(audioUnit: self, busType: .input, busses: [try AUAudioUnitBus(format: format)])
        maximumFramesToRender = 4096
        let t = tune
        let params: [AUParameter] = (0..<Int(tn_param_count())).map { i in
            let n = Int(tn_param_options(Int32(i))), indexed = tn_param_kind(Int32(i)) == 1
            let labels = indexed ? (0..<n).map { String(cString: tn_param_option(Int32(i), Int32($0))) } : nil
            let p = AUParameterTree.createParameter(withIdentifier: "t\(i)", name: String(cString: tn_param_name(Int32(i))), address: AUParameterAddress(i), min: 0, max: indexed ? AUValue(n - 1) : 1,
                                                    unit: indexed ? .indexed : .generic, unitName: nil, flags: [.flag_IsReadable, .flag_IsWritable], valueStrings: labels, dependentParameters: nil)
            p.value = tn_get(t, Int32(i))
            return p
        }
        let tree = AUParameterTree.createTree(withChildren: params)
        tree.implementorValueObserver = { p, v in tn_set(t, Int32(p.address), v) }
        tree.implementorValueProvider = { p in tn_get(t, Int32(p.address)) }
        tree.implementorStringFromValueCallback = { p, _ in
            var s = [CChar](repeating: 0, count: 64)
            tn_display(t, Int32(p.address), &s, 64)
            return String(cString: s)
        }
        parameterTree = tree
    }
    deinit { tn_destroy(tune); bufs.forEach { $0.deallocate() }; inPtrs.deallocate(); outPtrs.deallocate(); free(abl.unsafeMutablePointer) }

    override var inputBusses: AUAudioUnitBusArray { inputs }
    override var outputBusses: AUAudioUnitBusArray { outputs }

    override func allocateRenderResources() throws {
        try super.allocateRenderResources()
        tn_set_rate(tune, outputs[0].format.sampleRate)
        let n = Int(maximumFramesToRender)
        if n > frames { bufs.forEach { $0.deallocate() }; bufs = (0..<4).map { _ in .allocate(capacity: n) }; frames = n }
    }

    override var internalRenderBlock: AUInternalRenderBlock {
        let t = tune, inPtrs = self.inPtrs, outPtrs = self.outPtrs, abl = self.abl, bufs = { [unowned self] in self.bufs }, cap = { [unowned self] in self.frames }
        return { _, timestamp, frameCount, _, outputData, _, pull in
            let b = bufs(), n = min(Int(frameCount), cap())
            guard b.count == 4, n > 0 else { return noErr }
            for c in 0..<2 { abl[c] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(n * 4), mData: UnsafeMutableRawPointer(b[c])) }
            abl.unsafeMutablePointer.pointee.mNumberBuffers = 2
            var flags = AudioUnitRenderActionFlags()
            if let pull = pull, pull(&flags, timestamp, AUAudioFrameCount(n), 0, abl.unsafeMutablePointer) == noErr {
                for c in 0..<2 { inPtrs[c] = UnsafePointer(abl[c].mData?.assumingMemoryBound(to: Float.self) ?? b[c]) }
            } else {
                for c in 0..<2 { b[c].update(repeating: 0, count: n); inPtrs[c] = UnsafePointer(b[c]) }
            }
            let out = UnsafeMutableAudioBufferListPointer(outputData)
            for c in 0..<2 {
                let i = min(c, out.count - 1)
                if out[i].mData == nil { out[i].mData = UnsafeMutableRawPointer(b[2 + c]) }
                outPtrs[c] = out[i].mData!.assumingMemoryBound(to: Float.self)
            }
            tn_process(t, inPtrs, outPtrs, Int32(n))
            return noErr
        }
    }

    override var fullState: [String: Any]? {
        get { ["stratum.tune": (0..<Int(tn_param_count())).map { Double(tn_get(tune, Int32($0))) }] }
        set {
            guard let v = newValue?["stratum.tune"] as? [Double] else { return }
            for (i, x) in v.enumerated() { tn_set(tune, Int32(i), Float(x)); parameterTree?.parameter(withAddress: AUParameterAddress(i))?.value = Float(x) }
        }
    }
}
