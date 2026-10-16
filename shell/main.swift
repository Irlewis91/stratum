// STRATUM macOS shell: a native window, menu bar and file dialogs around the bundled web app.
import AVFoundation
import Cocoa
import WebKit

// Captures the Mac's audio input. Monitoring goes input -> output inside this engine, so it bypasses every effect in the mixer.
final class Recorder {
    private let engine = AVAudioEngine()
    private var left = [Float](), right = [Float]()
    private let lock = NSLock()
    private(set) var sampleRate = 44100.0
    private var fakeStart: Date?
    private var fakeCount = 0
    var isRunning: Bool { engine.isRunning || fakeStart != nil }
    let fake = CommandLine.arguments.contains("--fake-input")
    private let maxSamples = 48000 * 60 * 15

    func start(monitor: Bool) throws {
        left.removeAll(keepingCapacity: true); right.removeAll(keepingCapacity: true)
        if fake { fakeStart = Date(); fakeCount += 1; return }
        let input = engine.inputNode, format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw NSError(domain: "STRATUM", code: 1, userInfo: [NSLocalizedDescriptionKey: "No audio input device is available."]) }
        sampleRate = format.sampleRate
        engine.connect(input, to: engine.mainMixerNode, format: format)
        engine.mainMixerNode.outputVolume = monitor ? 1 : 0
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self = self, let data = buffer.floatChannelData else { return }
            let n = Int(buffer.frameLength)
            self.lock.lock()
            if self.left.count < self.maxSamples {
                self.left.append(contentsOf: UnsafeBufferPointer(start: data[0], count: n))
                self.right.append(contentsOf: UnsafeBufferPointer(start: data[buffer.format.channelCount > 1 ? 1 : 0], count: n))
            }
            self.lock.unlock()
        }
        engine.prepare()
        try engine.start()
    }

    var inputLatency: Double { fake ? 0 : engine.inputNode.presentationLatency }

    // Stops and returns the pass as a 16-bit stereo WAV.
    func stop() -> Data {
        if let began = fakeStart {
            let n = Int(Date().timeIntervalSince(began) * sampleRate), freq = 220.0 * Double(fakeCount)
            left = (0..<n).map { Float(sin(Double($0) * 2 * .pi * freq / sampleRate) * 0.4) }
            right = left
            fakeStart = nil
        } else {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            engine.disconnectNodeOutput(engine.inputNode)
        }
        lock.lock(); defer { lock.unlock() }
        return Recorder.wav(left: left, right: right, sampleRate: sampleRate)
    }

    static func wav(left: [Float], right: [Float], sampleRate: Double) -> Data {
        let n = min(left.count, right.count)
        var d = Data(capacity: 44 + n * 4)
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        d.append("RIFF".data(using: .ascii)!); u32(UInt32(36 + n * 4)); d.append("WAVEfmt ".data(using: .ascii)!)
        u32(16); u16(1); u16(2); u32(UInt32(sampleRate)); u32(UInt32(sampleRate) * 4); u16(4); u16(16)
        d.append("data".data(using: .ascii)!); u32(UInt32(n * 4))
        var pcm = [Int16](repeating: 0, count: n * 2)
        for i in 0..<n {
            pcm[i * 2] = Int16(max(-1, min(1, left[i])) * 32767)
            pcm[i * 2 + 1] = Int16(max(-1, min(1, right[i])) * 32767)
        }
        pcm.withUnsafeBytes { d.append(contentsOf: $0) }
        return d
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    let recorder = Recorder()
    let plugins = PluginHost()
    static weak var shared: AppDelegate?

    func applicationDidFinishLaunching(_ notification: Notification) {
        AppDelegate.shared = self
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "stratum")
        config.mediaTypesRequiringUserActionForPlayback = []
        web = WKWebView(frame: .zero, configuration: config)
        web.uiDelegate = self

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "STRATUM"
        window.minSize = NSSize(width: 1100, height: 680)
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("StratumMain")
        window.makeKeyAndOrderFront(nil)

        let dir = Bundle.main.resourceURL!.appendingPathComponent("web")
        web.loadFileURL(dir.appendingPathComponent("index.html"), allowingReadAccessTo: dir)
        buildMenu()
        NSApp.activate(ignoringOtherApps: true)
        if CommandLine.arguments.contains("--selftest") { selfTest() }
        if CommandLine.arguments.contains("--rec-test") { recTest() }
        if CommandLine.arguments.contains("--stem-test") { stemTest() }
        if CommandLine.arguments.contains("--sampler-test") { samplerTest() }
        if CommandLine.arguments.contains("--plugin-test") { pluginTest() }
        if CommandLine.arguments.contains("--fx-test") { fxTest() }
        if CommandLine.arguments.contains("--auto-test") { autoTest() }
        if CommandLine.arguments.contains("--share-test") { shareTest() }
        if CommandLine.arguments.contains("--lib-test") { libTest() }
        if CommandLine.arguments.contains("--wave-test") { waveTest() }
        if let i = CommandLine.arguments.firstIndex(of: "--import-test") { importTest(Array(CommandLine.arguments[(i + 1)...])) }
    }

    // Sampler check: loads tone files through the same path as the file picker, then measures the pitch of what plays.
    private func samplerTest() {
        let js = """
        let msg = ''; S.ui.toast = (m) => { msg = m; };
        const ctx = S.engine.ensure();
        const tone = (hz) => { const b = ctx.createBuffer(1, 22050, 44100), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = 0.8 * Math.sin(2 * Math.PI * hz * i / 44100); return S.io.wav(b); };
        const b64 = (u) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
        // Dominant frequency by zero crossings over the loudest stretch.
        const pitch = (buf) => { const d = buf.getChannelData(0); let z = 0, n = 0; for (let i = 3000; i < 12000; i++) { if (d[i - 1] <= 0 && d[i] > 0) z++; n++; } return Math.round(z * 44100 / n); };
        const p = S.blankProject(); if (!p.scenes.length) S.newScene(p, 'A', 1);
        const dr = S.newTrack(p, 'drums', 'Kit'), sy = S.newTrack(p, 'synth', 'Keys');
        S.ui.imported({ proj: p, report: '' });
        const sc = S.proj.scenes[0], D = S.proj.tracks[0], Y = S.proj.tracks[1];
        S.ui.pendingSample = { t: D.id };
        for (const [n, hz] of [['My Kick 01.wav', 1000], ['Crunchy Snare.wav', 1500], ['weird fx.wav', 3000], ['second kick.wav', 500]]) await S.io.nativeOpen(n, b64(tone(hz)));
        S.ui.openDone();
        const pads = Object.keys(D.pads).map((k) => k + ':' + D.pads[k].name);
        const solo = async (track, notes) => { S.proj.tracks.forEach((t) => { t.mute = t !== track; t.clips = {}; }); track.clips[sc.id] = { bars: 1, notes }; return pitch(await S.engine.render(S.proj, 'scene', sc.id, 2)); };
        const kick = await solo(D, [{ t: 0, d: 0.5, p: 36, v: 1 }]);
        const extra = await solo(D, [{ t: 0, d: 0.5, p: 60, v: 1 }]);
        D.pads[36].tune = 12; const kickUp = await solo(D, [{ t: 0, d: 0.5, p: 36, v: 1 }]);
        const builtIn = await solo(D, [{ t: 0, d: 0.5, p: 42, v: 1 }]);
        S.ui.pendingSample = { t: Y.id };
        await S.io.nativeOpen('lead tone.wav', b64(tone(1000))); S.ui.openDone();
        Y.inst.cutoff = 1;
        const root = await solo(Y, [{ t: 0, d: 1, p: 60, v: 1 }]), octave = await solo(Y, [{ t: 0, d: 1, p: 72, v: 1 }]);
        const saved = JSON.parse(await new Promise((res) => { S.io.saveFile = (n, d) => res(d); S.io.saveProject(); }));
        return JSON.stringify({ pads, kick, extra, kickUp, builtIn, sample: Y.inst.sample, root, octave, savedBuffers: Object.keys(saved.buffers).length, rows: S.drumRows(D).map((r) => r.n), msg });
        """
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            self.web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
                switch result {
                case .success(let v): print("SAMPLER", v)
                case .failure(let e): print("SAMPLER error", e)
                }
                NSApp.terminate(nil)
            }
        }
    }

    // Plugin check: puts Apple's built-in DLS instrument and a delay on a track, plays it live, renders a mixdown and saves.
    private func pluginTest() {
        var livePeak: Float = 0
        let js = """
        let msg = ''; S.ui.toast = (m) => { msg = m; };
        const list = await S.plug.list();
        const v3 = list.filter((p) => p.id.startsWith('vst3'));
        const inst = vst3 ? v3.find((p) => p.kind === 'inst' && /piano|jx10|dx10|testtone/i.test(p.name)) : list.find((p) => p.id === 'aumu:dls :appl'), fx = vst3 ? v3.find((p) => p.kind === 'fx' && /delay|testgain/i.test(p.name)) : list.find((p) => p.id === 'aufx:dely:appl');
        if (!inst || !fx) return JSON.stringify({ error: 'test plugins not found', vst3: v3.map((p) => p.name + ':' + p.kind) });
        const p = S.blankProject(); if (!p.scenes.length) S.newScene(p, 'A', 1);
        const t = S.newTrack(p, 'synth', 'Plugin keys');
        t.plugin = { id: inst.id, name: inst.name, maker: inst.maker, state: '', fx: [{ id: fx.id, name: fx.name, state: '' }] };
        t.clips[p.scenes[0].id] = { bars: 1, notes: [{ t: 0, d: 1, p: 60, v: 1 }, { t: 2, d: 1, p: 67, v: 1 }] };
        S.ui.imported({ proj: p, report: '' });
        S.engine.ensure(); S.engine.rebuild();
        await new Promise((r) => setTimeout(r, 1500));
        S.engine.audition(S.proj.tracks[0], 64, 1);
        await new Promise((r) => setTimeout(r, 900));
        const buf = await S.engine.render(S.proj, 'scene', S.proj.scenes[0].id, 4), before = buf.getChannelData(0).reduce((m, x) => Math.max(m, Math.abs(x)), 0);
        await S.plug.mixInto(buf, S.engine.plugEvents);
        const d = buf.getChannelData(0), peak = d.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
        const rms = (a, b) => { let s = 0; for (let i = Math.floor(a * 44100); i < b * 44100 && i < d.length; i++) s += d[i] * d[i]; return +Math.sqrt(s / ((b - a) * 44100)).toFixed(4); };
        const saved = JSON.parse(await new Promise((res) => { S.io.saveFile = (n, x) => res(x); S.io.saveProject(); }));
        const sp = saved.proj.tracks[0].plugin;
        // Unload every plugin, then load them again from the saved settings and render once more.
        const T = S.proj.tracks[0]; T.type = 'audio'; await S.plug.sync(); T.type = 'synth'; await S.plug.sync();
        await new Promise((r) => setTimeout(r, 800));
        const buf2 = await S.engine.render(S.proj, 'scene', S.proj.scenes[0].id, 4); await S.plug.mixInto(buf2, S.engine.plugEvents);
        const reloadPeak = +buf2.getChannelData(0).reduce((m, x) => Math.max(m, Math.abs(x)), 0).toFixed(4);
        const onset = (from) => { for (let i = Math.floor(from * 44100); i < d.length; i++) if (Math.abs(d[i]) > 0.01) return +(i / 44100).toFixed(3); return -1; };
        return JSON.stringify({ reloadPeak, firstOnset: onset(0), quietBeforeSecond: rms(0.9, 1.04), secondOnsetAfter1s: onset(1.0), using: [inst.name, fx.name], vst3Found: v3.length, installed: list.length, instruments: list.filter((x) => x.kind === 'inst').length, events: S.engine.plugEvents.length, webOnlyPeak: +before.toFixed(4), mixPeak: +peak.toFixed(4), firstNote: rms(0.1, 0.6), gap: rms(1.6, 2.0), secondNote: rms(2.2, 2.7), stateBytes: sp.state.length, fxStateBytes: sp.fx[0].state.length, msg });
        """
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            _ = self.plugins.livePeak()
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.2) { livePeak = self.plugins.livePeak() }
            self.web.callAsyncJavaScript(js, arguments: ["vst3": CommandLine.arguments.contains("--vst3")], in: nil, in: .page) { result in
                switch result {
                case .success(let v): print("PLUGIN", v, "livePeak", livePeak)
                case .failure(let e): print("PLUGIN error", e)
                }
                NSApp.terminate(nil)
            }
        }
    }

    // Plugin-effects check: an audio track and a drum track (one loaded pad, one built-in sound) each get a plugin effect,
    // so they play in the native engine. Measures the live output and the mixdown, and the tempo plugins were given.
    private func fxTest() {
        var livePeak: Float = 0
        let js = """
        let msg = ''; S.ui.toast = (m) => { msg = m; };
        const ctx = S.engine.ensure(), list = await S.plug.list(), v = list.filter((p) => p.id.startsWith('vst3'));
        const fx = aw ? list.find((p) => p.id === 'aw|' + aw) : vst3 ? v.find((p) => p.kind === 'fx' && /testgain|delay/i.test(p.name)) : list.find((p) => p.id === 'aufx:dely:appl');
        if (!fx) return JSON.stringify({ error: 'effect not found' });
        const tone = (hz, sec) => { const b = ctx.createBuffer(2, Math.floor(44100 * sec), 44100); for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin(2 * Math.PI * hz * i / 44100); } const id = S.uid(); S.buffers[id] = { id, name: 'tone', buf: b, bpm: 0 }; return id; };
        const p = S.blankProject(); p.bpm = 97; if (!p.scenes.length) S.newScene(p, 'A', 1);
        const A = S.newTrack(p, 'audio', 'Loop'), Dr = S.newTrack(p, 'drums', 'Kit'), Sy = S.newTrack(p, 'synth', 'Synth');
        Sy.regions.push({ id: S.uid(), start: 4, len: 2, off: 0, clip: { bars: 1, notes: [{ t: 0.5, d: 0.5, p: 57, v: 1 }] } });
        A.regions.push({ id: S.uid(), start: 0, len: 1.5, off: 0, clip: { audio: tone(440, 2), warp: false, bars: 1, gain: 1 } });
        Dr.pads = { 36: { audio: tone(1000, 0.15), name: 'pad', tune: 0, gain: 1 } };
        Dr.regions.push({ id: S.uid(), start: 0, len: 4, off: 0, clip: { bars: 1, notes: [{ t: 2, d: 0.25, p: 36, v: 1 }, { t: 3, d: 0.25, p: 42, v: 1 }] } });
        const render = async () => { const b = await S.engine.render(S.proj, 'song', S.proj.scenes[0].id, 6); const web = b.getChannelData(0).reduce((m, x) => Math.max(m, Math.abs(x)), 0); await S.plug.mixInto(b, S.engine.plugEvents); return [b.getChannelData(0), web]; };
        const rms = (d, a, b) => { let s = 0; for (let i = Math.floor(a * 44100); i < b * 44100 && i < d.length; i++) s += d[i] * d[i]; return +Math.sqrt(s / ((b - a) * 44100)).toFixed(4); };
        S.ui.imported({ proj: p, report: '' }); S.engine.rebuild();
        const [dry] = await render();
        for (const t of S.proj.tracks) t.pfx = [{ id: fx.id, name: fx.name, state: '' }];
        S.engine.rebuild();
        await new Promise((r) => setTimeout(r, 1800));
        S.engine.mode = 'song'; S.engine.play(4);   // from beat 4 only the built-in synth note plays
        await new Promise((r) => setTimeout(r, 1200));
        S.engine.stop();
        await new Promise((r) => setTimeout(r, 300));
        const dbg = await new Promise((res) => { const id = 99999; S.plug.cb0 = S.plug.cb; window.webkit.messageHandlers.stratum.postMessage({ op: 'auDebug', req: id }); const old = S.plug.cb; S.plug.cb = (i, x) => (i === id ? (S.plug.cb = old, res(x)) : old(i, x)); });
        const [wet, webPeak] = await render(), spb = 60 / 97;
        const controls = await S.plug.params(S.proj.tracks[0], 0), turned = controls.length ? await S.plug.setParam(S.proj.tracks[0], 0, controls[0].i, 0.9) : '';
        const saved = JSON.parse(await new Promise((res) => { S.io.saveFile = (n, x) => res(x); S.io.saveProject(); }));
        const win = (d) => ({ loop: rms(d, 0.1, 0.5), afterLoop: rms(d, 1.05, 1.2), pad: rms(d, 0.05 + 2 * spb, 0.05 + 2 * spb + 0.12), hat: rms(d, 0.05 + 3 * spb, 0.05 + 3 * spb + 0.04), beforeSynth: rms(d, 0.05 + 4.2 * spb, 0.05 + 4.45 * spb), synth: rms(d, 0.05 + 4.55 * spb, 0.05 + 4.95 * spb) });
        return JSON.stringify({ airwindows: list.filter((p) => p.id.startsWith('aw|')).length, controls: controls.map((q) => q.name + '=' + q.text), firstControlAt90: turned, effect: fx.name, withoutPlugin: win(dry), withPlugin: win(wet), webAudioPeakWithPlugin: +webPeak.toFixed(4), events: S.engine.plugEvents.length, tempo: dbg, fxStateBytes: saved.proj.tracks.map((t) => t.pfx[0].state.length), synthPitchHz: (() => { let z = 0; const a = Math.floor((0.05 + 4.6 * spb) * 44100), b = Math.floor((0.05 + 4.9 * spb) * 44100); for (let i = a + 1; i < b; i++) if (wet[i - 1] <= 0 && wet[i] > 0) z++; return Math.round(z * 44100 / (b - a)); })(), msg });
        """
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            _ = self.plugins.livePeak()
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.4) { livePeak = self.plugins.livePeak() }
            self.web.callAsyncJavaScript(js, arguments: ["vst3": CommandLine.arguments.contains("--vst3"), "aw": CommandLine.arguments.firstIndex(of: "--aw").map { CommandLine.arguments[$0 + 1] } ?? ""], in: nil, in: .page) { result in
                switch result {
                case .success(let v): print("FXTEST", v, "livePeak", livePeak)
                case .failure(let e): print("FXTEST error", e)
                }
                NSApp.terminate(nil)
            }
        }
    }

    // Automation check: a held note with volume automation falling from full to silent, and a pan sweep, rendered in Song mode.
    private func autoTest() {
        let js = """
        const p = S.blankProject(); p.bpm = 120; if (!p.scenes.length) S.newScene(p, 'A', 1);
        const t = S.newTrack(p, 'synth', 'Pad'); t.vol = 1; t.inst.release = 0.01; t.inst.cutoff = 1;
        t.regions.push({ id: S.uid(), start: 0, len: 8, off: 0, clip: { bars: 2, notes: [{ t: 0, d: 8, p: 60, v: 1 }] } });
        S.ui.imported({ proj: p, report: '' }); S.engine.ensure(); S.engine.rebuild();
        const run = async () => { const b = await S.engine.render(S.proj, 'song', S.proj.scenes[0].id, 8); return [b.getChannelData(0), b.getChannelData(1)]; };
        const rms = (d, a, b) => { let s = 0; for (let i = Math.floor(a * 44100); i < b * 44100; i++) s += d[i] * d[i]; return +Math.sqrt(s / ((b - a) * 44100)).toFixed(4); };
        const [flat] = await run();
        S.proj.tracks[0].auto = { vol: [{ t: 0, v: 1 }, { t: 8, v: 0 }] };
        const [fall] = await run();
        S.proj.tracks[0].auto = { pan: [{ t: 0, v: -1 }, { t: 8, v: 1 }] };
        const [L, R] = await run();
        return JSON.stringify({ noAutomation: [rms(flat, 0.3, 0.8), rms(flat, 3.2, 3.7)], volumeFalling: [rms(fall, 0.3, 0.8), rms(fall, 1.8, 2.3), rms(fall, 3.2, 3.7)], panLeftToRight: { start: [rms(L, 0.3, 0.8), rms(R, 0.3, 0.8)], end: [rms(L, 3.2, 3.7), rms(R, 3.2, 3.7)] } });
        """
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            self.web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
                switch result {
                case .success(let v): print("AUTOTEST", v)
                case .failure(let e): print("AUTOTEST error", e)
                }
                NSApp.terminate(nil)
            }
        }
    }

    // Share check: renders the demo song's first 12 seconds to the branded video and audio file, then reports what was made.
    private func shareTest() {
        let js = """
        await new Promise((res) => { S.ui.shareDone = (ok, msg) => res([ok, msg]); S.io.share('save', 'Since I Been Away', 'Slade', 12); }).then((r) => window.__shared = r);
        return JSON.stringify(window.__shared);
        """
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            self.web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
                let dir = FileManager.default.urls(for: .moviesDirectory, in: .userDomainMask)[0].appendingPathComponent("STRATUM")
                for f in ["Since I Been Away.mp4", "Since I Been Away.m4a"] {
                    let u = dir.appendingPathComponent(f), a = AVURLAsset(url: u)
                    let size = (try? FileManager.default.attributesOfItem(atPath: u.path)[.size] as? Int) ?? 0
                    print("SHARETEST", f, "seconds", String(format: "%.2f", a.duration.seconds), "bytes", size, "video", a.tracks(withMediaType: .video).first?.naturalSize ?? .zero, "audioTracks", a.tracks(withMediaType: .audio).count)
                }
                ShareRenderer.preview(title: "Since I Been Away", artist: "Slade", peaks: (0..<96).map { Float(0.25 + 0.75 * abs(sin(Double($0) * 0.37))) }, progress: 0.4,
                                      to: URL(fileURLWithPath: CommandLine.arguments.last!))
                if case .success(let v) = result { print("SHARETEST", v) } else if case .failure(let e) = result { print("SHARETEST error", e) }
                NSApp.terminate(nil)
            }
        }
    }

    // Sound library check: lists the bundled sounds, decodes one of each kind, and uses them through the Sounds browser.
    private func libTest() {
        let js = """
        const all = await S.io.libList(), P = S.proj, cats = {};
        for (const x of all) cats[x.category] = (cats[x.category] || 0) + 1;
        const ctx = S.engine.ensure(), pick = (c) => all.findIndex((x) => x.category === c);
        const decoded = {};
        for (const c of ['Kicks', 'Vocal Shouts', 'Percussion']) { const ab = await S.io.libRead(all[pick(c)].path); const b = await ctx.decodeAudioData(ab); decoded[c] = [+b.duration.toFixed(2), b.numberOfChannels, +b.getChannelData(0).reduce((m, v) => Math.max(m, Math.abs(v)), 0).toFixed(3)]; }
        const drums = P.tracks.find((t) => t.type === 'drums'), synth = P.tracks.find((t) => t.type === 'synth');
        S.ui.track = drums.id; await S.ui.act('libUse', { dataset: { i: pick('Kicks') } });
        S.ui.track = synth.id; await S.ui.act('libUse', { dataset: { i: pick('Vocal Shouts') } });
        const regionsBefore = synth.regions.length; await S.ui.act('libUse', { dataset: { i: pick('MIDI') } });
        const outside = await S.io.libRead('../Info.plist');
        return JSON.stringify({ sounds: all.length, cats, decoded, drumPads: Object.values(drums.pads || {}).map((p) => p.name), synthSample: synth.inst.sample && synth.inst.sample.name, midiRegionAdded: synth.regions.length - regionsBefore, midiNotes: synth.regions[synth.regions.length - 1].clip.notes.length, readOutsideLibrary: outside ? 'ALLOWED' : 'blocked' });
        """
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            self.web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
                switch result {
                case .success(let v): print("LIBTEST", v)
                case .failure(let e): print("LIBTEST error", e)
                }
                NSApp.terminate(nil)
            }
        }
    }

    // STRATUM Wave check: every preset renders a chord, a custom wavetable loads and survives saving, and a dense
    // 8-voice supersaw passage renders faster than real time.
    private func waveTest() {
        let js = """
        const p = S.blankProject(); p.bpm = 120; if (!p.scenes.length) S.newScene(p, 'A', 1);
        const t = S.newTrack(p, 'synth', 'Wave'); t.vol = 1;
        t.plugin = { id: 'stratum|wave', name: 'STRATUM Wave', maker: 'STRATUM', state: '', fx: [] };
        const chord = (n) => [48, 55, 60, 64].map((q) => ({ t: 0, d: n, p: q, v: 0.9 }));
        t.regions.push({ id: S.uid(), start: 0, len: 4, off: 0, clip: { bars: 1, notes: chord(2) } });
        S.ui.imported({ proj: p, report: '' }); S.engine.ensure(); S.engine.rebuild();
        await new Promise((r) => setTimeout(r, 1500));
        const T = S.proj.tracks[0], ask = S.plug.ask;
        const render = async (beats) => { const b = await S.engine.render(S.proj, 'song', S.proj.scenes[0].id, beats); const t0 = Date.now(); await S.plug.mixInto(b, S.engine.plugEvents); return [b.getChannelData(0), b.getChannelData(1), Date.now() - t0, b.duration]; };
        const rms = (d, a, b) => { let s = 0; for (let i = Math.floor(a * 44100); i < b * 44100 && i < d.length; i++) s += d[i] * d[i]; return +Math.sqrt(s / ((b - a) * 44100)).toFixed(4); };
        const zc = (d, a, b) => { let z = 0; for (let i = Math.floor(a * 44100) + 1; i < b * 44100; i++) if (d[i - 1] <= 0 && d[i] > 0) z++; return Math.round(z / (b - a)); };
        const peak = (d) => +d.reduce((m, x) => Math.max(m, Math.abs(x)), 0).toFixed(3);
        const names = await ask({ op: 'auWavePresets' }), params = await S.plug.params(T, -1), out = {};
        for (let i = 0; i < names.length; i++) {
          await ask({ op: 'auWavePreset', t: T.id, i });
          const [L, R] = await render(4);
          out[names[i]] = { held: rms(L, 0.3, 0.9), afterRelease: rms(L, 1.9, 2.0), peak: peak(L), stereoDiff: rms(L.map((x, k) => x - R[k]), 0.3, 0.9), zeroCross: zc(L, 0.3, 0.9) };
        }
        // Custom wavetable: 8 frames from a sine to a square.
        const frames = 8, data = new Float32Array(frames * 2048);
        for (let f = 0; f < frames; f++) for (let i = 0; i < 2048; i++) { const s = Math.sin(2 * Math.PI * i / 2048); data[f * 2048 + i] = Math.tanh(s * (1 + f * 3)); }
        let bin = ''; const u8 = new Uint8Array(data.buffer); for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        await ask({ op: 'auWavePreset', t: T.id, i: 0 });
        const loaded = await ask({ op: 'auWaveTable', t: T.id, osc: 0, name: 'Test Table', b64: btoa(bin) });
        const tableParam = (await S.plug.params(T, -1)).find((q) => q.name === 'Osc A · Wavetable').text;
        await S.plug.capture();
        const saved = T.plugin.state.length;
        T.type = 'audio'; await S.plug.sync(); T.type = 'synth'; await S.plug.sync();
        await new Promise((r) => setTimeout(r, 800));
        const afterReload = (await S.plug.params(T, -1)).find((q) => q.name === 'Osc A · Wavetable').text;
        const frame = await ask({ op: 'auWaveFrame', t: T.id });
        // Dense passage: Supersaw Lead (two 7- and 5-voice unison oscillators), 4-note chords for 16 seconds.
        await ask({ op: 'auWavePreset', t: T.id, i: names.indexOf('Supersaw Lead') });
        T.regions = [{ id: S.uid(), start: 0, len: 32, off: 0, clip: { bars: 8, notes: [0, 4, 8, 12, 16, 20, 24, 28].flatMap((b) => chord(4).map((n) => ({ ...n, t: b }))) } }];
        const [D, , ms, dur] = await render(32);
        return JSON.stringify({ params: params.length, groups: [...new Set(params.map((q) => q.name.split(' · ')[0]))], presets: out, customLoaded: loaded, tableParam, stateBytes: saved, afterReload, framePoints: frame[0].length, frameShapeMinMax: [Math.min(...frame[0]).toFixed(2), Math.max(...frame[0]).toFixed(2)], dense: { seconds: dur.toFixed(1), renderMs: ms, peak: peak(D) } });
        """
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            self.web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
                switch result {
                case .success(let v): print("WAVETEST", v)
                case .failure(let e): print("WAVETEST error", e)
                }
                NSApp.terminate(nil)
            }
        }
    }

    // Importer check: opens each file through the same path as File > Open and prints what came in.
    private func importTest(_ paths: [String]) {
        var queue = paths
        func next() {
            guard !queue.isEmpty else { NSApp.terminate(nil); return }
            let path = queue.removeFirst(), url = URL(fileURLWithPath: path)
            guard let data = try? Data(contentsOf: url) else { print("IMPORT", path, "unreadable"); next(); return }
            let js = """
            let msg = ''; S.ui.toast = (m) => { msg = m; };
            await S.io.nativeOpen(name, b64, path);
            const p = S.proj;
            return JSON.stringify({ file: name, msg, bpm: p.bpm, scenes: p.scenes.map((s) => s.name + ':' + s.bars), sections: p.sections.length, songBeats: S.songEnd(p), regions: p.tracks.reduce((a, t) => a + t.regions.length, 0),
              tracks: p.tracks.map((t) => [t.name, t.type, +t.vol.toFixed(2), +t.pan.toFixed(2), Object.values(t.clips).reduce((a, c) => a + (c.notes ? c.notes.length : 0), 0), t.regions.length, t.mute, t.pads ? Object.values(t.pads).map((x) => x.name).join('+') : t.inst && t.inst.sample ? t.inst.sample.name : '']), wanted: (p.wanted || []).map((w) => w.file), auto: p.tracks.filter((t) => t.auto).map((t) => [t.name, Object.keys(t.auto).map((k) => k + ':' + t.auto[k].map((q) => +q.t.toFixed(2) + '=' + +q.v.toFixed(2)).join(' ')).join(' | ')]), masterAuto: p.master.auto ? p.master.auto.vol.map((q) => +q.t.toFixed(2) + '=' + +q.v.toFixed(2)).join(' ') : '', wantPlugins: (p.wantPlugins || []).map((w) => w.name), insts: p.tracks.filter((t) => t.inst).map((t) => t.name + ':' + t.inst.wave),
              firstRegions: p.tracks.map((t) => t.regions.slice(0, 3).map((r) => [+r.start.toFixed(3), +r.len.toFixed(3), +r.off.toFixed(3), r.clip.notes ? r.clip.notes.length + 'n' : 'audio'])),
              buffers: Object.values(S.buffers).map((b) => [b.name, +b.buf.duration.toFixed(2), b.bpm, +b.buf.getChannelData(0).reduce((m, x) => Math.max(m, Math.abs(x)), 0).toFixed(3)]) });
            """
            web.callAsyncJavaScript(js, arguments: ["name": url.lastPathComponent, "b64": data.base64EncodedString(), "path": url.path], in: nil, in: .page) { result in
                switch result {
                case .success(let v): print("IMPORT", v)
                case .failure(let e): print("IMPORT", url.lastPathComponent, "error", e.localizedDescription)
                }
                next()
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { next() }
    }

    // Stem check: separates the demo song and compares each stem with the solo renders of the drum and bass tracks.
    private func stemTest() {
        let code = """
        const p = S.proj, E = S.engine, beats = S.songEnd(p), t0 = performance.now();
        const render = async (solo) => { for (const t of p.tracks) t.mute = solo ? t.name !== solo : false; return E.render(p, 'song', p.scenes[0].id, beats); };
        const mix = await render(null), drums = await render('Drums'), bass = await render('Bass');
        for (const t of p.tracks) t.mute = false;
        const stems = await S.io.separate(mix);
        const at = async (b, sr) => { const c = new OfflineAudioContext(1, Math.ceil(b.duration * sr), sr), s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(); return (await c.startRendering()).getChannelData(0); };
        const sr = stems[0].sampleRate, ref = { mix: await at(mix, sr), drums: await at(drums, sr), bass: await at(bass, sr) };
        const corr = (a, b) => { let ab = 0, aa = 0, bb = 0; for (let i = 0, n = Math.min(a.length, b.length); i < n; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; } return +(ab / Math.sqrt(aa * bb + 1e-12)).toFixed(3); };
        const names = ['drums', 'bass', 'other', 'vocals'], out = { seconds: +mix.duration.toFixed(1), tookSeconds: 0, stems: {} };
        const mono = [];
        for (let i = 0; i < 4; i++) { const d = await at(stems[i], sr); mono.push(d); let e = 0; for (const v of d) e += v * v; out.stems[names[i]] = { rms: +Math.sqrt(e / d.length).toFixed(4), vsDrumsSolo: corr(d, ref.drums), vsBassSolo: corr(d, ref.bass) }; }
        const sum = new Float32Array(mono[0].length); for (const d of mono) for (let i = 0; i < sum.length; i++) sum[i] += d[i];
        out.sumVsMix = corr(sum, ref.mix); out.tookSeconds = +((performance.now() - t0) / 1000).toFixed(1);
        return JSON.stringify(out);
        """
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            self.web.callAsyncJavaScript(code, arguments: [:], in: nil, in: .page) { r in
                switch r {
                case .success(let v): print("STEMTEST", v)
                case .failure(let e): print("STEMTEST failed", e)
                }
                NSApp.terminate(nil)
            }
        }
    }

    // Recording check (use with --fake-input): two passes over the same range, then a comp edit, then an offline render.
    private func recTest() {
        let steps: [(Double, String)] = [
            (2.0, "S.proj.master.vol = 0; S.menu('rec'); 'rec1'"),
            (2.5, "S.menu('pause'); 'stop1'"),
            (1.5, "S.ui.playFrom = 0; S.menu('rec'); 'rec2'"),
            (2.5, "S.menu('pause'); 'stop2'"),
            (1.5, "(() => { const t = S.proj.tracks.find((x) => x.type === 'audio'), rg = t.regions[0]; S.paintComp(rg, 0, 2, 0); return JSON.stringify({ track: t.name, regions: t.regions.length, start: rg.start, len: rg.len, takes: rg.takes.map((k) => [k.shift, +S.buffers[k.audio].buf.duration.toFixed(2), S.buffers[k.audio].buf.sampleRate]), comp: rg.comp }); })()"),
        ]
        var i = 0
        func next() {
            guard i < steps.count else {
                let render = "const p = S.proj; for (const t of p.tracks) t.mute = t.type !== 'audio'; p.master.vol = 0.8; const b = await S.engine.render(p, 'song', p.scenes[0].id, 4); const d = b.getChannelData(0), sr = b.sampleRate; const zc = (a, z) => { let n = 0; for (let i = Math.floor(a * sr) + 1; i < z * sr; i++) if (d[i - 1] < 0 && d[i] >= 0) n++; return Math.round(n / (z - a)); }; const spb = 60 / p.bpm; return JSON.stringify({ hzInFirstTwoBeats: zc(0.1, 0.05 + 2 * spb - 0.05), hzAfter: zc(0.05 + 2 * spb + 0.05, 0.05 + 3.5 * spb) });"
                web.callAsyncJavaScript(render, arguments: [:], in: nil, in: .page) { r in
                    if case .success(let v) = r { print("RECTEST render", v) } else { print("RECTEST render failed", r) }
                    NSApp.terminate(nil)
                }
                return
            }
            let (delay, code) = steps[i]; i += 1
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                self.web.evaluateJavaScript(code) { result, error in
                    print("RECTEST", result ?? "nil", error?.localizedDescription ?? "")
                    next()
                }
            }
        }
        next()
    }

    // Launch check used by the build: plays the demo silently for a moment and prints engine state.
    private func selfTest() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            self.web.evaluateJavaScript("S.proj.master.vol = 0; S.menu('play'); 'started'") { _, _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                    let js = "JSON.stringify({state: S.engine.ctx.state, playing: S.engine.playing, beat: S.engine.beatAt(S.engine.ctx.currentTime), trackPeak: Math.max(...Object.values(S.engine.graph.tracks).map(t => S.engine.peak(t.an))), gunzip: typeof DecompressionStream})"
                    self.web.evaluateJavaScript(js) { result, error in
                        print("SELFTEST", result ?? "nil", error?.localizedDescription ?? "")
                        NSApp.terminate(nil)
                    }
                }
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // MARK: menu

    private func item(_ title: String, _ action: String, _ key: String = "", _ mods: NSEvent.ModifierFlags = [.command]) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: #selector(runJS(_:)), keyEquivalent: key)
        i.keyEquivalentModifierMask = mods
        i.representedObject = action
        i.target = self
        return i
    }

    private func buildMenu() {
        let main = NSMenu()
        func add(_ title: String, _ items: [NSMenuItem]) {
            let top = NSMenuItem(), menu = NSMenu(title: title)
            items.forEach { menu.addItem($0) }
            top.submenu = menu
            main.addItem(top)
        }
        add("STRATUM", [
            NSMenuItem(title: "About STRATUM", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""),
            .separator(),
            NSMenuItem(title: "Hide STRATUM", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"),
            NSMenuItem(title: "Quit STRATUM", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"),
        ])
        add("File", [
            item("New Project", "new", "n"),
            item("Open or Import…", "open", "o"),
            item("Save Project…", "save", "s"),
            .separator(),
            item("Export Audio Mixdown (.wav)…", "export:wav", "e", [.command, .shift]),
            item("Export MIDI File (.mid)…", "export:mid"),
            item("Export DAWproject (experimental)…", "export:dawproject"),
        ])
        add("Edit", [
            item("Undo", "undo", "z"),
            .separator(),
            NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"),
            NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"),
            NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"),
            NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"),
        ])
        add("Transport", [
            item("Play / Stop", "play", ""),
            item("Return to Start", "stop", ""),
            item("Record", "rec", ""),
            item("Metronome", "metronome", ""),
            item("Dump Score Log", "dump", ""),
        ])
        add("Window", [
            NSMenuItem(title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"),
            NSMenuItem(title: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: ""),
        ])
        add("Help", [item("Shortcuts for This Skin", "help", "/")])
        NSApp.mainMenu = main
    }

    @objc func runJS(_ sender: NSMenuItem) {
        guard let action = sender.representedObject as? String else { return }
        if action == "open" { openFile(); return }
        web.evaluateJavaScript("window.S && S.menu('\(action)')", completionHandler: nil)
    }

    /// Looks for sample files a project points at: where it says they are, then beside the project file. Found files are handed
    /// to the web side one at a time.
    private func findFiles(_ paths: [String], near: String) {
        let fm = FileManager.default, home = NSHomeDirectory()
        let dir = near.isEmpty ? nil : URL(fileURLWithPath: near).deletingLastPathComponent()
        let stem = near.isEmpty ? "" : URL(fileURLWithPath: near).deletingPathExtension().lastPathComponent
        var queue: [(String, URL)] = []
        for p in paths {
            let name = (p.replacingOccurrences(of: "\\", with: "/") as NSString).lastPathComponent
            var tries = [p.replacingOccurrences(of: "%FLStudioUserData%", with: home + "/Documents/Image-Line/FL Studio")]
            if let d = dir { tries += [d.appendingPathComponent(name).path, d.appendingPathComponent("Samples/" + name).path, d.appendingPathComponent(stem + "/Samples/" + name).path, d.appendingPathComponent(stem + "/" + name).path] }
            if let hit = tries.first(where: { var isDir: ObjCBool = false; return fm.fileExists(atPath: $0, isDirectory: &isDir) && !isDir.boolValue }) { queue.append((p, URL(fileURLWithPath: hit))) }
        }
        func next() {
            guard !queue.isEmpty else { web.evaluateJavaScript("S.io.foundDone()", completionHandler: nil); return }
            let (wanted, url) = queue.removeFirst()
            guard let data = try? Data(contentsOf: url), data.count < 400_000_000 else { return next() }
            web.callAsyncJavaScript("await S.io.found(name, b64);", arguments: ["name": (wanted.replacingOccurrences(of: "\\", with: "/") as NSString).lastPathComponent, "b64": data.base64EncodedString()], in: nil, in: .page) { _ in next() }
        }
        next()
    }

    // MARK: sharing

    private var lastShare: (key: String, out: ShareRenderer.Output)?

    private func share(_ body: [String: Any]) {
        guard let data = Data(base64Encoded: body["b64"] as? String ?? "") else { return }
        let title = body["title"] as? String ?? "Untitled", artist = body["artist"] as? String ?? "", target = body["target"] as? String ?? "save"
        let peaks = (body["peaks"] as? [Double] ?? []).map { Float($0) }
        let key = "\(title)|\(artist)|\(data.count)|\(data.hashValue)"
        if let l = lastShare, l.key == key, FileManager.default.fileExists(atPath: l.out.video.path) { return deliver(l.out, target: target, title: title, artist: artist) }
        let wav = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".wav")
        do { try data.write(to: wav) } catch { return shareDone(false, "Could not prepare the audio: \(error.localizedDescription)") }
        let out = FileManager.default.urls(for: .moviesDirectory, in: .userDomainMask)[0].appendingPathComponent("STRATUM")
        ShareRenderer.render(.init(wav: wav, title: title, artist: artist, peaks: peaks, outDir: out), progress: { [weak self] f in
            self?.web.evaluateJavaScript("S.ui.shareProgress(\(f))", completionHandler: nil)
        }) { [weak self] result in
            try? FileManager.default.removeItem(at: wav)
            switch result {
            case .success(let o): self?.lastShare = (key, o); self?.deliver(o, target: target, title: title, artist: artist)
            case .failure(let e): self?.shareDone(false, "Could not make the video: \(e.localizedDescription)")
            }
        }
    }

    private func shareDone(_ ok: Bool, _ msg: String) {
        guard let d = try? JSONSerialization.data(withJSONObject: [msg]), let json = String(data: d, encoding: .utf8) else { return }
        web.evaluateJavaScript("S.ui.shareDone(\(ok), \(json)[0])", completionHandler: nil)
    }

    private func deliver(_ o: ShareRenderer.Output, target: String, title: String, artist: String) {
        let line = "\u{201C}\(title)\u{201D}\(artist.isEmpty ? "" : " by \(artist)") \u{2014} made with STRATUM. \(ShareBrand.linkURL)"
        func send(_ name: NSSharingService.Name, _ items: [Any], subject: String? = nil, done: String) {
            guard let s = NSSharingService(named: name), s.canPerform(withItems: items) else {
                NSWorkspace.shared.activateFileViewerSelecting([o.video, o.audio])
                return shareDone(false, "That sharing option is not set up on this Mac. Your video and audio are in Movies \u{203A} STRATUM.")
            }
            if let subject = subject { s.subject = subject }
            s.perform(withItems: items)
            shareDone(true, done)
        }
        switch target {
        case "mail": send(.composeEmail, [line, o.audio], subject: "\(title) \u{2014} made with STRATUM", done: "Mail is open with your track attached.")
        case "messages": send(.composeMessage, [line, o.video], done: "Messages is open with your video attached.")
        case "airdrop": send(.sendViaAirDrop, [o.video], done: "Choose who to AirDrop your video to.")
        case "more":
            let picker = NSSharingServicePicker(items: [o.video, o.audio])
            picker.show(relativeTo: NSRect(x: web.bounds.midX, y: web.bounds.maxY - 40, width: 1, height: 1), of: web, preferredEdge: .minY)
            shareDone(true, "Choose where to send your track.")
        default:
            NSWorkspace.shared.activateFileViewerSelecting([o.video])
            if let page = ShareBrand.uploadPages[target], let url = URL(string: page) {
                NSWorkspace.shared.open(url)
                shareDone(true, "The upload page is open and your video is selected in Finder \u{2014} drag it in to post.")
            } else { shareDone(true, "Saved in Movies \u{203A} STRATUM: \(o.video.lastPathComponent) and \(o.audio.lastPathComponent).") }
        }
    }

    // MARK: plugins

    private func reply(_ body: [String: Any], _ value: Any) {
        guard let req = body["req"] as? Int, let d = try? JSONSerialization.data(withJSONObject: [value]), let json = String(data: d, encoding: .utf8) else { return }
        web.evaluateJavaScript("S.plug.cb(\(req), \(json)[0])", completionHandler: nil)
    }

    private func pluginOp(_ op: String, _ body: [String: Any]) {
        let track = body["t"] as? String ?? ""
        switch op {
        case "auList": reply(body, plugins.list())
        case "auSync": plugins.sync(body["tracks"] as? [[String: Any]] ?? []) { [weak self] failed in self?.reply(body, failed) }
        case "auMix":
            for t in body["tracks"] as? [[String: Any]] ?? [] {
                plugins.setMix(t["id"] as? String ?? "", vol: t["vol"] as? Double ?? 0.8, pan: t["pan"] as? Double ?? 0, mute: t["mute"] as? Bool ?? false)
            }
            plugins.setMaster(body["master"] as? Double ?? 1)
        case "auNote": plugins.note(track, pitch: body["p"] as? Int ?? 60, velocity: body["v"] as? Double ?? 0.8, delay: body["delay"] as? Double ?? 0, duration: body["d"] as? Double ?? 0.25)
        case "auOff": plugins.allOff()
        case "auPlay": plugins.play(body)
        case "auSample":
            if let key = body["key"] as? String, let d = Data(base64Encoded: body["b64"] as? String ?? "") { plugins.addSample(key, rate: body["rate"] as? Double ?? 44100, data: d) }
        case "auKeep": plugins.keepSamples(Set(body["keys"] as? [String] ?? []))
        case "auTransport":
            let t = Transport.shared
            t.bpm = max(20, body["bpm"] as? Double ?? 120); t.playing = body["playing"] as? Bool ?? false
            t.beat0 = body["beat"] as? Double ?? 0; t.t0 = CFAbsoluteTimeGetCurrent() + (body["delay"] as? Double ?? 0)
        case "auUI": plugins.showUI(track, slot: body["slot"] as? Int ?? -1, title: body["title"] as? String ?? "Plugin")
        case "auStates": reply(body, plugins.states())
        case "auWavePresets": reply(body, plugins.wavePresets())
        case "auWavePreset": reply(body, plugins.wavePreset(track, body["i"] as? Int ?? 0))
        case "auWaveTable": reply(body, plugins.waveTable(track, osc: body["osc"] as? Int ?? 0, data: Data(base64Encoded: body["b64"] as? String ?? "") ?? Data(), name: body["name"] as? String ?? "Imported"))
        case "auWaveFrame": reply(body, [plugins.waveFrame(track, osc: 0), plugins.waveFrame(track, osc: 1)])
        case "libList":
            let index = Bundle.main.resourceURL!.appendingPathComponent("library/library.json")
            reply(body, (try? String(contentsOf: index, encoding: .utf8)) ?? "[]")
        case "libRead":
            // Only files inside the bundled library can be read.
            let root = Bundle.main.resourceURL!.appendingPathComponent("library").standardizedFileURL
            let file = root.appendingPathComponent(body["path"] as? String ?? "").standardizedFileURL
            reply(body, file.path.hasPrefix(root.path + "/") ? ((try? Data(contentsOf: file))?.base64EncodedString() ?? "") : "")
        case "auParams": reply(body, plugins.params(track, slot: body["slot"] as? Int ?? 0))
        case "auSetParam": reply(body, plugins.setParam(track, slot: body["slot"] as? Int ?? 0, address: body["i"] as? Int ?? 0, value: body["v"] as? Double ?? 0))
        case "auDebug": reply(body, ["tempoSeenByVST": Transport.shared.seenByVST, "livePeakSoFar": Double(plugins.livePeak())])
        case "auRender":
            if let bpm = body["bpm"] as? Double { Transport.shared.bpm = max(20, bpm) }
            let floats = (try? plugins.render(events: body["events"] as? [[String: Any]] ?? [], seconds: body["seconds"] as? Double ?? 0)) ?? []
            reply(body, floats.withUnsafeBufferPointer { Data(buffer: $0) }.base64EncodedString())
        default: break
        }
    }

    // MARK: files

    private func openFile(many: Bool = false) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = many
        panel.canChooseDirectories = false
        panel.message = many ? "Choose one or more sound files" : "Open a STRATUM project, or import MIDI, Ableton .als, FL Studio .flp or zipped loop package, a Reason song or an audio file"
        panel.beginSheetModal(for: window) { [weak self] result in
            guard let self = self else { return }
            var queue = result == .OK ? panel.urls : []
            func next() {
                guard !queue.isEmpty else { self.web.evaluateJavaScript("S.ui.openDone()", completionHandler: nil); return }
                let url = queue.removeFirst()
                guard let data = try? Data(contentsOf: url) else { self.alert("Could not read \(url.lastPathComponent)."); return next() }
                if data.count > 400_000_000 { self.alert("That file is too large to import (limit 400 MB)."); return next() }
                self.web.callAsyncJavaScript("await S.io.nativeOpen(name, b64, path);", arguments: ["name": url.lastPathComponent, "b64": data.base64EncodedString(), "path": url.path], in: nil, in: .page) { _ in next() }
            }
            next()
        }
    }

    private func saveFile(name: String, base64: String) {
        guard let data = Data(base64Encoded: base64) else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { [weak self] result in
            guard result == .OK, let url = panel.url else { return }
            do { try data.write(to: url) } catch { self?.alert("Could not save: \(error.localizedDescription)") }
        }
    }

    // MARK: stem separation

    // Runs the bundled HT-Demucs model on a 44.1 kHz stereo 16-bit WAV and hands four stems back to the page.
    private func separateStems(wavBase64: String) {
        func fail(_ text: String) { DispatchQueue.main.async { self.js("S.io.stemsFailed('\(text.replacingOccurrences(of: "'", with: "’").replacingOccurrences(of: "\n", with: " "))')") } }
        #if !arch(arm64)
        return fail("Stem separation needs an Apple-silicon Mac.")
        #else
        let lib = Bundle.main.bundleURL.appendingPathComponent("Contents/Frameworks/libonnxruntime.dylib").path
        let model = Bundle.main.resourceURL!.appendingPathComponent("models/htdemucs.onnx").path
        guard FileManager.default.fileExists(atPath: lib), FileManager.default.fileExists(atPath: model) else { return fail("This build does not include the stem separation model.") }
        guard let wav = Data(base64Encoded: wavBase64), wav.count > 48 else { return fail("The audio could not be read.") }
        DispatchQueue.global(qos: .userInitiated).async {
            let n = (wav.count - 44) / 4
            var left = [Float](repeating: 0, count: n), right = [Float](repeating: 0, count: n)
            wav.withUnsafeBytes { raw in
                let pcm = UnsafeRawPointer(raw.baseAddress! + 44)
                for i in 0..<n {
                    left[i] = Float(Int16(littleEndian: pcm.loadUnaligned(fromByteOffset: i * 4, as: Int16.self))) / 32768
                    right[i] = Float(Int16(littleEndian: pcm.loadUnaligned(fromByteOffset: i * 4 + 2, as: Int16.self))) / 32768
                }
            }
            var out = [Float](repeating: 0, count: n * 8), err = [CChar](repeating: 0, count: 512)
            let progress: stratum_progress = { fraction, _ in
                DispatchQueue.main.async { AppDelegate.shared?.js("S.io.stemProgress(\(fraction))") }
            }
            let rc = stratum_separate(lib, model, left, right, n, &out, progress, nil, &err, 512)
            if rc != 0 { return fail(String(cString: err)) }
            for s in 0..<4 {
                let l = Array(out[(s * 2) * n..<(s * 2 + 1) * n]), r = Array(out[(s * 2 + 1) * n..<(s * 2 + 2) * n])
                let b64 = Recorder.wav(left: l, right: r, sampleRate: 44100).base64EncodedString()
                DispatchQueue.main.async { self.js("S.io.stemResult(\(s), '\(b64)')") }
            }
            DispatchQueue.main.async { self.js("S.io.stemsDone()") }
        }
        #endif
    }

    // MARK: recording

    private func js(_ code: String) { web.evaluateJavaScript(code, completionHandler: nil) }

    private func startRecording(monitor: Bool) {
        let begin = {
            do { try self.recorder.start(monitor: monitor); self.js("S.ui.recStarted()") }
            catch { self.recFailed(error.localizedDescription) }
        }
        if recorder.fake { begin(); return }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: begin()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { ok in
                DispatchQueue.main.async { ok ? begin() : self.recFailed("microphone access was not allowed") }
            }
        default: recFailed("microphone access is switched off for STRATUM in System Settings › Privacy & Security › Microphone")
        }
    }

    private func recFailed(_ text: String) {
        let quoted = (try? JSONSerialization.data(withJSONObject: [text])).flatMap { String(data: $0, encoding: .utf8) } ?? "[\"error\"]"
        js("S.ui.recFailed(\(quoted)[0])")
    }

    private func stopRecording() {
        guard recorder.isRunning else { return }
        let latency = recorder.inputLatency, wav = recorder.stop()
        js("S.io.recorded('\(wav.base64EncodedString())', \(latency))")
    }

    private func alert(_ text: String) {
        let a = NSAlert()
        a.messageText = text
        a.beginSheetModal(for: window, completionHandler: nil)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else { return }
        if op == "open" { openFile(many: body["many"] as? Bool ?? false) }
        if op.hasPrefix("au") || op.hasPrefix("lib") { return pluginOp(op, body) }
        if op == "share" { share(body) }
        if op == "findFiles" { findFiles(body["paths"] as? [String] ?? [], near: body["near"] as? String ?? "") }
        if op == "recStart" { startRecording(monitor: body["monitor"] as? Bool ?? false) }
        if op == "recStop" { stopRecording() }
        if op == "stems", let b64 = body["b64"] as? String { separateStems(wavBase64: b64) }
        if op == "save", let name = body["name"] as? String, let b64 = body["b64"] as? String { saveFile(name: name, base64: b64) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        alert(message)
        completionHandler()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
