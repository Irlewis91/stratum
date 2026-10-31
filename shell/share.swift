// STRATUM sharing: turns a mixdown into a branded vertical video (for TikTok, Reels, Shorts, X) and an AAC audio file,
// then hands them to Messages, Mail, AirDrop, the system share menu, or a platform's upload page.
import AVFoundation
import Cocoa

enum ShareBrand {
    static let background = NSColor(srgbRed: 0x0f / 255, green: 0x10 / 255, blue: 0x16 / 255, alpha: 1)
    static let cream = NSColor(srgbRed: 0xed / 255, green: 0xe9 / 255, blue: 0xe0 / 255, alpha: 1)
    static let amber = NSColor(srgbRed: 0xe3 / 255, green: 0x9a / 255, blue: 0x12 / 255, alpha: 1)
    /// Where people can get STRATUM. Shown on every shared video and in shared messages.
    static let link = "github.com/matovalabs/stratum"
    static let linkURL = "https://github.com/matovalabs/stratum/releases/latest"
    /// Upload pages for platforms that have no macOS share extension.
    static let uploadPages = [
        "tiktok": "https://www.tiktok.com/upload",
        "ig_reel": "https://www.instagram.com/",
        "ig_post": "https://www.instagram.com/",
        "facebook": "https://www.facebook.com/",
        "youtube": "https://studio.youtube.com/",
        "x": "https://x.com/compose/post",
        "threads": "https://www.threads.com/",
    ]
    /// Video shape for each place a track can be posted: 9:16 for Stories, Reels, TikTok and Shorts, 4:5 for feed posts,
    /// 1:1 for X.
    static let shapes: [String: (w: Int, h: Int, label: String)] = [
        "ig_post": (1080, 1350, "4x5"), "facebook": (1080, 1350, "4x5"), "threads": (1080, 1350, "4x5"), "x": (1080, 1080, "1x1"),
    ]
    static func shape(_ target: String) -> (w: Int, h: Int, label: String) { shapes[target] ?? (1080, 1920, "9x16") }
}

final class ShareRenderer {
    struct Job { let wav: URL; let title: String; let artist: String; let peaks: [Float]; let outDir: URL; var width = 1080; var height = 1920; var label = "9x16" }
    struct Output { let video: URL; let audio: URL; let seconds: Double }

    static let fps: Int32 = 30

    /// The parts of a frame that never change: background, wordmark, title, artist and footer.
    /// Layout is the 9:16 design scaled by `k`, with heights placed as fractions of the frame so other shapes still fit.
    static func scale(_ width: Int, _ height: Int) -> CGFloat { min(CGFloat(width) / 1080, CGFloat(height) / 1920) }

    static func baseImage(title: String, artist: String, width: Int, height: Int) -> CGImage? {
        let k = scale(width, height), H = CGFloat(height), W = CGFloat(width)
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4,
                                   hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        ShareBrand.background.setFill()
        NSRect(x: 0, y: 0, width: width, height: height).fill()
        let res = Bundle.main.resourceURL!.appendingPathComponent("brand")
        if let mark = NSImage(contentsOf: res.appendingPathComponent("stratum-wordmark.png")) {
            let w = 620 * k, h = w * mark.size.height / max(1, mark.size.width)
            mark.draw(in: NSRect(x: (W - w) / 2, y: H * (1 - 0.12) - h, width: w, height: h))
        }
        let center = NSMutableParagraphStyle()
        center.alignment = .center
        center.lineBreakMode = .byWordWrapping
        func text(_ s: String, size: CGFloat, weight: NSFont.Weight, color: NSColor, y: CGFloat, height h: CGFloat, kern: CGFloat = 0) {
            let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: size * k, weight: weight), .foregroundColor: color, .paragraphStyle: center, .kern: kern * k]
            (s as NSString).draw(with: NSRect(x: 90 * k, y: y, width: W - 180 * k, height: h * k), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attrs)
        }
        text(title.isEmpty ? "Untitled" : title, size: 84, weight: .bold, color: ShareBrand.cream, y: H * 1180 / 1920, height: 210)
        if !artist.isEmpty { text(artist, size: 46, weight: .medium, color: ShareBrand.amber, y: H * 1110 / 1920, height: 64) }
        text("MADE WITH STRATUM", size: 30, weight: .semibold, color: ShareBrand.amber, y: H * 200 / 1920, height: 44, kern: 6)
        text(ShareBrand.link, size: 30, weight: .regular, color: ShareBrand.cream.withAlphaComponent(0.65), y: H * 150 / 1920, height: 44)
        NSGraphicsContext.restoreGraphicsState()
        return rep.cgImage
    }

    /// Draws one frame: the base image, then the waveform with everything before `progress` (0...1) lit.
    static func drawFrame(_ ctx: CGContext, base: CGImage, peaks: [Float], progress: Double, time: String, width: Int, height: Int) {
        ctx.draw(base, in: CGRect(x: 0, y: 0, width: width, height: height))
        let k = Double(scale(width, height)), margin = max(90 * k, 0.083 * Double(width))
        let n = max(1, peaks.count), left = margin, span = Double(width) - 2 * margin, mid = Double(height) * 760 / 1920, maxH = 300 * k
        let slot = span / Double(n), bar = max(2, slot * 0.62)
        for (i, p) in peaks.enumerated() {
            let h = max(6, Double(min(1, max(0, p))) * maxH), x = left + Double(i) * slot + (slot - bar) / 2
            let lit = (Double(i) + 0.5) / Double(n) <= progress
            ctx.setFillColor((lit ? ShareBrand.amber : ShareBrand.cream.withAlphaComponent(0.28)).cgColor)
            ctx.addPath(CGPath(roundedRect: CGRect(x: x, y: mid - h / 2, width: bar, height: h), cornerWidth: bar / 2, cornerHeight: bar / 2, transform: nil))
            ctx.fillPath()
        }
        let px = left + span * min(1, max(0, progress))
        ctx.setFillColor(ShareBrand.cream.cgColor)
        ctx.fill(CGRect(x: px - 2 * k, y: mid - maxH / 2 - 30 * k, width: 4 * k, height: maxH + 60 * k))
        let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedDigitSystemFont(ofSize: 34 * k, weight: .medium), .foregroundColor: ShareBrand.cream.withAlphaComponent(0.8)]
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: time, attributes: attrs))
        let w = CTLineGetTypographicBounds(line, nil, nil, nil)
        ctx.textPosition = CGPoint(x: (Double(width) - w) / 2, y: mid - maxH / 2 - 110 * k)
        CTLineDraw(line, ctx)
    }

    static func clock(_ s: Double) -> String { String(format: "%d:%02d", Int(s) / 60, Int(s) % 60) }

    /// Renders on a background queue; `progress` and `done` are called on the main queue.
    static func render(_ job: Job, progress: @escaping (Double) -> Void, done: @escaping (Result<Output, Error>) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { try make(job) { f in DispatchQueue.main.async { progress(f) } } }
            DispatchQueue.main.async { done(result) }
        }
    }

    private static func fail(_ m: String) -> NSError { NSError(domain: "STRATUM", code: 10, userInfo: [NSLocalizedDescriptionKey: m]) }

    private static func make(_ job: Job, progress: (Double) -> Void) throws -> Output {
        try FileManager.default.createDirectory(at: job.outDir, withIntermediateDirectories: true)
        let safe = String(job.title.map { "/:\\?%*|\"<>".contains($0) ? "-" : $0 }).trimmingCharacters(in: .whitespaces)
        let stem = safe.isEmpty ? "STRATUM" : safe
        let width = job.width, height = job.height
        let audioURL = job.outDir.appendingPathComponent(stem + ".m4a"), videoURL = job.outDir.appendingPathComponent(stem + " " + job.label + ".mp4")
        let silentURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mp4")
        for u in [audioURL, videoURL, silentURL] { try? FileManager.default.removeItem(at: u) }

        // 1. AAC audio.
        let src = try AVAudioFile(forReading: job.wav)
        let settings: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: src.processingFormat.sampleRate,
                                       AVNumberOfChannelsKey: src.processingFormat.channelCount, AVEncoderBitRateKey: 256_000]
        do {
            let dst = try AVAudioFile(forWriting: audioURL, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
            let buf = AVAudioPCMBuffer(pcmFormat: src.processingFormat, frameCapacity: 8192)!
            while src.framePosition < src.length { try src.read(into: buf); if buf.frameLength == 0 { break }; try dst.write(from: buf) }
        }
        let seconds = Double(src.length) / src.processingFormat.sampleRate
        progress(0.05)

        // 2. Picture.
        guard let base = baseImage(title: job.title, artist: job.artist, width: width, height: height) else { throw fail("Could not draw the video frame") }
        let writer = try AVAssetWriter(outputURL: silentURL, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 2_500_000, AVVideoMaxKeyFrameIntervalKey: 60],
        ])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
        ])
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? fail("Could not start the video") }
        writer.startSession(atSourceTime: .zero)
        let frames = max(1, Int((seconds * Double(fps)).rounded(.up)))
        for f in 0..<frames {
            while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.002) }
            guard let pool = adaptor.pixelBufferPool else { throw fail("No video buffer pool") }
            var pb: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb)
            guard let px = pb else { throw fail("No video buffer") }
            CVPixelBufferLockBaseAddress(px, [])
            if let ctx = CGContext(data: CVPixelBufferGetBaseAddress(px), width: width, height: height, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(px),
                                   space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) {
                let t = Double(f) / Double(fps)
                drawFrame(ctx, base: base, peaks: job.peaks, progress: t / seconds, time: clock(t) + " / " + clock(seconds), width: width, height: height)
            }
            CVPixelBufferUnlockBaseAddress(px, [])
            adaptor.append(px, withPresentationTime: CMTime(value: CMTimeValue(f), timescale: fps))
            if f % 30 == 0 { progress(0.05 + 0.85 * Double(f) / Double(frames)) }
        }
        input.markAsFinished()
        let sem = DispatchSemaphore(value: 0)
        writer.finishWriting { sem.signal() }
        sem.wait()
        guard writer.status == .completed else { throw writer.error ?? fail("The video could not be finished") }

        // 3. Picture plus sound.
        let comp = AVMutableComposition(), pic = AVURLAsset(url: silentURL), snd = AVURLAsset(url: audioURL)
        guard let vt = pic.tracks(withMediaType: .video).first, let at = snd.tracks(withMediaType: .audio).first,
              let cv = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
              let ca = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw fail("Could not combine picture and sound") }
        let range = CMTimeRange(start: .zero, duration: CMTimeMinimum(pic.duration, snd.duration))
        try cv.insertTimeRange(range, of: vt, at: .zero)
        try ca.insertTimeRange(range, of: at, at: .zero)
        guard let export = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetPassthrough) else { throw fail("Could not export the video") }
        export.outputURL = videoURL
        export.outputFileType = .mp4
        export.exportAsynchronously { sem.signal() }
        sem.wait()
        try? FileManager.default.removeItem(at: silentURL)
        guard export.status == .completed else { throw export.error ?? fail("The video could not be saved") }
        progress(1)
        return Output(video: videoURL, audio: audioURL, seconds: seconds)
    }

    /// Writes one frame as a PNG (used by the self-check to look at the design).
    static func preview(title: String, artist: String, peaks: [Float], progress: Double, to url: URL, width: Int = 1080, height: Int = 1920) {
        guard let base = baseImage(title: title, artist: artist, width: width, height: height),
              let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
        drawFrame(ctx, base: base, peaks: peaks, progress: progress, time: "1:12 / 2:58", width: width, height: height)
        if let img = ctx.makeImage(), let data = NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:]) { try? data.write(to: url) }
    }
}
