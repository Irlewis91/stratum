// STRATUM Go Live: streams the STRATUM window (with an optional camera box) and the sound the Mac is playing (with an
// optional microphone) to Twitch, YouTube, Instagram or TikTok as 1280x720, 30 fps H.264 video and AAC audio over RTMP.
import AVFoundation
import Cocoa
import CoreImage
import ScreenCaptureKit
import Security
import VideoToolbox
import WebKit

final class LiveSession: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {
    static let width = 1280, height = 720, fps = 30
    let rtmp = RTMPPublisher()
    private weak var web: WKWebView?
    private let renderQueue = DispatchQueue(label: "stratum.live.render"), audioQueue = DispatchQueue(label: "stratum.live.audio")
    private var vt: VTCompressionSession?
    private var timer: DispatchSourceTimer?
    private var silence: DispatchSourceTimer?
    private let ci = CIContext(options: [.cacheIntermediates: false])
    private let lock = NSLock()
    private var windowImage: CGImage?, cameraImage: CIImage?
    private var snapping = false, running = false, sentVideoHeader = false, sentAudioHeader = false
    private var t0 = CACurrentMediaTime(), frameNo: Int64 = 0
    private var cam: AVCaptureSession?
    private var sysStream: AnyObject?
    private var aac: AVAudioConverter?
    private let pcmFormat = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!
    private var fifoL = [Float](), fifoR = [Float](), micL = [Float](), micR = [Float]()
    private var audioFrames: Int64 = 0, audioStart: Double = -1
    private var micConverter: AVAudioConverter?
    private(set) var audioSource = "silent"
    private(set) var cameraOn = false
    var problem: String?
    /// Off in self-checks, so they never ask for the Screen & System Audio Recording permission.
    static var systemSound = true

    init(web: WKWebView) { self.web = web }

    // MARK: start and stop

    func start(url: String, key: String, camera: Bool, mic: Bool, done: @escaping (String?) -> Void) {
        guard setupEncoder() else { return done("The video encoder could not start.") }
        guard setupAAC() else { return done("The audio encoder could not start.") }
        rtmp.onState = { [weak self] s in
            guard let self = self else { return }
            switch s {
            case .live:
                self.rtmp.metadata(width: Self.width, height: Self.height, fps: Double(Self.fps), videoKbps: 4500, audioKbps: 160)
                self.t0 = CACurrentMediaTime(); self.frameNo = 0; self.audioFrames = 0; self.audioStart = -1
                self.running = true
                self.startVideo()
                self.startAudio(mic: mic)
                if camera { self.startCamera() }
                done(nil)
            case .failed(let m): if !self.running { done(m) } else { self.problem = m; self.stop() }
            default: break
            }
        }
        rtmp.connect(url: url, key: key)
    }

    func stop() {
        running = false
        timer?.cancel(); timer = nil
        silence?.cancel(); silence = nil
        cam?.stopRunning(); cam = nil
        if #available(macOS 13.0, *), let s = sysStream as? SCStream { s.stopCapture(completionHandler: nil) }
        sysStream = nil
        if let v = vt { VTCompressionSessionCompleteFrames(v, untilPresentationTimeStamp: .invalid); VTCompressionSessionInvalidate(v) }
        vt = nil
        rtmp.close()
    }

    var status: [String: Any] {
        var st: String
        switch rtmp.state { case .idle: st = "idle"; case .connecting: st = "connecting"; case .live: st = "live"; case .failed: st = "failed"; case .closed: st = "closed" }
        let secs = running ? CACurrentMediaTime() - t0 : 0
        return ["state": st, "seconds": secs, "kbps": secs > 1 ? Double(rtmp.bytesSent) * 8 / 1000 / secs : 0, "audio": audioSource, "camera": cameraOn, "message": problem ?? ""]
    }

    // MARK: video: window snapshots + camera, composed 30 times a second

    private func setupEncoder() -> Bool {
        var s: VTCompressionSession?
        guard VTCompressionSessionCreate(allocator: nil, width: Int32(Self.width), height: Int32(Self.height), codecType: kCMVideoCodecType_H264, encoderSpecification: nil,
                                         imageBufferAttributes: [kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey: Self.width, kCVPixelBufferHeightKey: Self.height] as CFDictionary,
                                         compressedDataAllocator: nil, outputCallback: nil, refcon: nil, compressionSessionOut: &s) == noErr, let v = s else { return false }
        VTSessionSetProperty(v, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(v, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Main_AutoLevel)
        VTSessionSetProperty(v, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(v, key: kVTCompressionPropertyKey_AverageBitRate, value: 4_500_000 as CFNumber)
        VTSessionSetProperty(v, key: kVTCompressionPropertyKey_DataRateLimits, value: [6_000_000 / 8, 1] as CFArray)
        VTSessionSetProperty(v, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: (Self.fps * 2) as CFNumber)
        VTSessionSetProperty(v, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: Self.fps as CFNumber)
        VTCompressionSessionPrepareToEncodeFrames(v)
        vt = v; sentVideoHeader = false
        return true
    }

    private func startVideo() {
        snapLoop()
        let t = DispatchSource.makeTimerSource(queue: renderQueue)
        t.schedule(deadline: .now(), repeating: .nanoseconds(1_000_000_000 / Self.fps))
        t.setEventHandler { [weak self] in self?.renderFrame() }
        t.resume(); timer = t
    }

    /// Keeps a fresh picture of the STRATUM window (about 20 a second); WebKit draws it, so no screen permission is needed.
    private func snapLoop() {
        guard running, let web = web else { return }
        let cfg = WKSnapshotConfiguration()
        cfg.snapshotWidth = NSNumber(value: Self.width)
        web.takeSnapshot(with: cfg) { [weak self] img, _ in
            guard let self = self else { return }
            if let img = img, let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) { self.lock.lock(); self.windowImage = cg; self.lock.unlock() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { self.snapLoop() }
        }
    }

    private func renderFrame() {
        guard running, let v = vt, let pool = VTCompressionSessionGetPixelBufferPool(v) else { return }
        var pb: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb)
        guard let px = pb else { return }
        lock.lock(); let win = windowImage, camImg = cameraImage; lock.unlock()
        let W = CGFloat(Self.width), H = CGFloat(Self.height)
        var canvas = CIImage(color: CIColor(red: 0x0f / 255, green: 0x10 / 255, blue: 0x16 / 255)).cropped(to: CGRect(x: 0, y: 0, width: W, height: H))
        // With the camera on, the window shrinks a little to leave a column on the right, and the camera box sits at the
        // bottom of that column, so it never covers any of the session.
        let pad: CGFloat = 12, bw = camImg == nil ? 0 : (W * 0.17).rounded(), bh = (bw * 9 / 16).rounded()
        let area = CGRect(x: pad, y: 0, width: W - (bw > 0 ? bw + pad * 3 : pad * 2), height: H)
        if let win = win {
            let w = CGFloat(win.width), h = CGFloat(win.height), s = min(area.width / w, area.height / h)
            let x = bw > 0 ? area.minX : (W - w * s) / 2
            let img = CIImage(cgImage: win).transformed(by: CGAffineTransform(scaleX: s, y: s)).transformed(by: CGAffineTransform(translationX: x, y: (H - h * s) / 2))
            canvas = img.composited(over: canvas)
        }
        if let cam = camImg {
            let x = W - bw - pad, y = pad + 3
            let e = cam.extent, s = max(bw / e.width, bh / e.height)
            let scaled = cam.transformed(by: CGAffineTransform(scaleX: s, y: s))
            let fitted = scaled.transformed(by: CGAffineTransform(translationX: x - scaled.extent.minX - (scaled.extent.width - bw) / 2, y: y - scaled.extent.minY - (scaled.extent.height - bh) / 2))
                .cropped(to: CGRect(x: x, y: y, width: bw, height: bh))
            let frame = CIImage(color: CIColor(red: 0xe3 / 255, green: 0x9a / 255, blue: 0x12 / 255)).cropped(to: CGRect(x: x - 2, y: y - 2, width: bw + 4, height: bh + 4))
            canvas = fitted.composited(over: frame.composited(over: canvas))
        }
        ci.render(canvas, to: px, bounds: CGRect(x: 0, y: 0, width: W, height: H), colorSpace: CGColorSpaceCreateDeviceRGB())
        let pts = CMTime(value: frameNo, timescale: CMTimeScale(Self.fps)); frameNo += 1
        VTCompressionSessionEncodeFrame(v, imageBuffer: px, presentationTimeStamp: pts, duration: CMTime(value: 1, timescale: CMTimeScale(Self.fps)), frameProperties: nil, infoFlagsOut: nil) { [weak self] status, _, sb in
            guard status == noErr, let sb = sb, let self = self else { return }
            self.sendVideo(sb)
        }
    }

    private func sendVideo(_ sb: CMSampleBuffer) {
        let ms = UInt32(max(0, CMSampleBufferGetPresentationTimeStamp(sb).seconds * 1000))
        let attach = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[CFString: Any]]
        let key = !(attach?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
        if key && !sentVideoHeader, let fmt = CMSampleBufferGetFormatDescription(sb) {
            var sps: UnsafePointer<UInt8>?, pps: UnsafePointer<UInt8>?, sl = 0, pl = 0, count = 0
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 0, parameterSetPointerOut: &sps, parameterSetSizeOut: &sl, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 1, parameterSetPointerOut: &pps, parameterSetSizeOut: &pl, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
            guard let s = sps, let p = pps, sl > 3 else { return }
            var rec = Data([1, s[1], s[2], s[3], 0xFF, 0xE1, UInt8(sl >> 8), UInt8(sl & 255)])
            rec.append(s, count: sl)
            rec.append(contentsOf: [1, UInt8(pl >> 8), UInt8(pl & 255)])
            rec.append(p, count: pl)
            rtmp.video(Data([0x17, 0, 0, 0, 0]) + rec, ts: 0)
            sentVideoHeader = true
        }
        guard sentVideoHeader, let bb = CMSampleBufferGetDataBuffer(sb) else { return }
        var len = 0, ptr: UnsafeMutablePointer<CChar>?
        CMBlockBufferGetDataPointer(bb, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &len, dataPointerOut: &ptr)
        guard let p = ptr else { return }
        var body = Data([key ? 0x17 : 0x27, 1, 0, 0, 0])
        body.append(UnsafeRawPointer(p).assumingMemoryBound(to: UInt8.self), count: len)
        rtmp.video(body, ts: ms)
    }

    // MARK: camera

    /// Self-checks show a stand-in picture where the camera would be.
    func testCamera(_ img: CIImage) { lock.lock(); cameraImage = img; lock.unlock(); cameraOn = true }

    private func startCamera() {
        AVCaptureDevice.requestAccess(for: .video) { ok in
            DispatchQueue.main.async {
                guard ok, self.running, let dev = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: dev) else { return }
                let s = AVCaptureSession()
                s.sessionPreset = .hd1280x720
                let out = AVCaptureVideoDataOutput()
                out.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
                out.setSampleBufferDelegate(self, queue: self.renderQueue)
                if s.canAddInput(input) { s.addInput(input) }
                if s.canAddOutput(out) { s.addOutput(out) }
                s.startRunning()
                self.cam = s; self.cameraOn = true
            }
        }
    }

    // MARK: audio: the sound the Mac plays (ScreenCaptureKit), plus the microphone, as AAC

    private func setupAAC() -> Bool {
        let out = AVAudioFormat(settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2])!
        guard let c = AVAudioConverter(from: pcmFormat, to: out) else { return false }
        c.bitRate = 160_000
        aac = c; sentAudioHeader = false
        return true
    }

    private func startAudio(mic: Bool) {
        if mic { startMic() }
        if #available(macOS 13.0, *), Self.systemSound {
            SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, _ in
                guard self.running, let display = content?.displays.first else { return self.fallbackAudio(mic: mic) }
                let cfg = SCStreamConfiguration()
                cfg.capturesAudio = true; cfg.excludesCurrentProcessAudio = false; cfg.sampleRate = 48000; cfg.channelCount = 2
                cfg.width = 2; cfg.height = 2; cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
                let s = SCStream(filter: SCContentFilter(display: display, excludingApplications: [], exceptingWindows: []), configuration: cfg, delegate: nil)
                let sink = SystemAudioSink { [weak self] l, r in self?.systemAudio(l, r) }
                do { try s.addStreamOutput(sink, type: .audio, sampleHandlerQueue: self.audioQueue) } catch { return self.fallbackAudio(mic: mic) }
                s.startCapture { e in
                    if e != nil { self.fallbackAudio(mic: mic); self.problem = "Allow STRATUM under Privacy & Security › Screen & System Audio Recording to stream your sound." }
                    else { self.audioSource = mic ? "Mac sound + microphone" : "Mac sound"; self.sysSink = sink }
                }
                self.sysStream = s
            }
        } else { fallbackAudio(mic: mic) }
    }
    private var sysSink: AnyObject?

    /// Without system sound: the microphone drives the audio, or silence keeps the stream valid.
    private func fallbackAudio(mic: Bool) {
        audioSource = mic ? "microphone" : "silent"
        let t = DispatchSource.makeTimerSource(queue: audioQueue)
        t.schedule(deadline: .now(), repeating: .milliseconds(20))
        t.setEventHandler { [weak self] in
            guard let self = self, self.running else { return }
            let want = Int((CACurrentMediaTime() - self.t0) * 48000) - Int(self.audioFrames) - self.fifoL.count
            guard want > 0 else { return }
            self.systemAudio([Float](repeating: 0, count: want), [Float](repeating: 0, count: want))
        }
        t.resume(); silence = t
    }

    private func startMic() {
        AVCaptureDevice.requestAccess(for: .audio) { ok in
            DispatchQueue.main.async {
                guard ok, self.running, let dev = AVCaptureDevice.default(for: .audio), let input = try? AVCaptureDeviceInput(device: dev) else { return }
                let s = self.cam ?? AVCaptureSession()
                let out = AVCaptureAudioDataOutput()
                out.setSampleBufferDelegate(self, queue: self.audioQueue)
                if s.canAddInput(input) { s.addInput(input) }
                if s.canAddOutput(out) { s.addOutput(out) }
                if !s.isRunning { s.startRunning() }
                if self.cam == nil { self.cam = s }
            }
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sb: CMSampleBuffer, from connection: AVCaptureConnection) {
        if output is AVCaptureVideoDataOutput {
            guard let px = CMSampleBufferGetImageBuffer(sb) else { return }
            let img = CIImage(cvPixelBuffer: px).transformed(by: CGAffineTransform(scaleX: -1, y: 1))   // mirror, like a selfie view
            lock.lock(); cameraImage = img; lock.unlock()
            return
        }
        // Microphone: convert to 48 kHz stereo and queue it to be mixed in.
        guard let fmtDesc = CMSampleBufferGetFormatDescription(sb), let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmtDesc) else { return }
        var desc = asbd.pointee
        guard let inFmt = AVAudioFormat(streamDescription: &desc) else { return }
        let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sb))
        guard let inBuf = AVAudioPCMBuffer(pcmFormat: inFmt, frameCapacity: frames) else { return }
        inBuf.frameLength = frames
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sb, at: 0, frameCount: Int32(frames), into: inBuf.mutableAudioBufferList) == noErr else { return }
        if micConverter == nil || micConverter?.inputFormat != inFmt { micConverter = AVAudioConverter(from: inFmt, to: pcmFormat) }
        guard let conv = micConverter, let outBuf = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: frames * 2 + 1024) else { return }
        var fed = false
        conv.convert(to: outBuf, error: nil) { _, st in if fed { st.pointee = .noDataNow; return nil }; fed = true; st.pointee = .haveData; return inBuf }
        guard let ch = outBuf.floatChannelData else { return }
        let n = Int(outBuf.frameLength)
        micL.append(contentsOf: UnsafeBufferPointer(start: ch[0], count: n)); micR.append(contentsOf: UnsafeBufferPointer(start: ch[1], count: n))
        if micL.count > 48000 / 2 { let drop = micL.count - 48000 / 4; micL.removeFirst(drop); micR.removeFirst(drop) }   // never more than a quarter second behind
        if audioSource == "microphone" { let l = micL, r = micR; micL = []; micR = []; feed(l, r) }
    }

    /// System sound arrives here; any queued microphone sound is mixed in, then it is encoded.
    private func systemAudio(_ l: [Float], _ r: [Float]) {
        var l = l, r = r
        if audioSource != "microphone" && !micL.isEmpty {
            let n = min(l.count, micL.count)
            for i in 0..<n { l[i] += micL[i]; r[i] += micR[i] }
            micL.removeFirst(n); micR.removeFirst(n)
        }
        feed(l, r)
    }

    private func feed(_ l: [Float], _ r: [Float]) {
        guard running, let conv = aac else { return }
        if audioStart < 0 { audioStart = CACurrentMediaTime() - t0 }
        fifoL += l; fifoR += r
        while fifoL.count >= 1024 {
            guard let pcm = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: 1024), let ch = pcm.floatChannelData else { return }
            pcm.frameLength = 1024
            for i in 0..<1024 { ch[0][i] = fifoL[i]; ch[1][i] = fifoR[i] }
            fifoL.removeFirst(1024); fifoR.removeFirst(1024)
            let out = AVAudioCompressedBuffer(format: conv.outputFormat, packetCapacity: 4, maximumPacketSize: max(conv.maximumOutputPacketSize, 1536))
            var fed = false
            conv.convert(to: out, error: nil) { _, st in if fed { st.pointee = .noDataNow; return nil }; fed = true; st.pointee = .haveData; return pcm }
            if !sentAudioHeader {
                rtmp.audio(Data([0xAF, 0, 0x11, 0x90]), ts: 0)   // AAC-LC, 48 kHz, stereo
                sentAudioHeader = true
            }
            for p in 0..<Int(out.packetCount) {
                guard let descs = out.packetDescriptions else { break }
                let d = descs[p], start = out.data.advanced(by: Int(d.mStartOffset))
                var body = Data([0xAF, 1]); body.append(start.assumingMemoryBound(to: UInt8.self), count: Int(d.mDataByteSize))
                let ms = UInt32(max(0, (audioStart + Double(audioFrames) / 48000) * 1000))
                rtmp.audio(body, ts: ms)
                audioFrames += 1024
            }
        }
    }

    // MARK: stream keys, kept in the Keychain when the producer asks

    static func saveKey(_ platform: String, url: String, key: String) {
        let base: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: "STRATUM Live", kSecAttrAccount: platform]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData] = (try? JSONSerialization.data(withJSONObject: ["url": url, "key": key])) ?? Data()
        SecItemAdd(add as CFDictionary, nil)
    }
    static func loadKey(_ platform: String) -> [String: String]? {
        let q: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: "STRATUM Live", kSecAttrAccount: platform, kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return (try? JSONSerialization.jsonObject(with: d)) as? [String: String]
    }
}

/// Receives system sound from ScreenCaptureKit as two channels of floats.
@available(macOS 13.0, *)
final class SystemAudioSink: NSObject, SCStreamOutput {
    let deliver: ([Float], [Float]) -> Void
    init(_ deliver: @escaping ([Float], [Float]) -> Void) { self.deliver = deliver }
    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sb.isValid else { return }
        let frames = CMSampleBufferGetNumSamples(sb)
        let abl = AudioBufferList.allocate(maximumBuffers: 2)
        defer { free(abl.unsafeMutablePointer) }
        var block: CMBlockBuffer?
        guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sb, bufferListSizeNeededOut: nil, bufferListOut: abl.unsafeMutablePointer, bufferListSize: AudioBufferList.sizeInBytes(maximumBuffers: 2),
                                                                      blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: &block) == noErr, abl.count > 0 else { return }
        let l = abl[0].mData!.assumingMemoryBound(to: Float.self), r = abl[min(1, abl.count - 1)].mData!.assumingMemoryBound(to: Float.self)
        deliver(Array(UnsafeBufferPointer(start: l, count: frames)), Array(UnsafeBufferPointer(start: r, count: frames)))
    }
}
