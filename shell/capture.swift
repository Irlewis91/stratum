// STRATUM "Record from another app": captures the sound one running app makes (a browser, a music player…) with
// ScreenCaptureKit, so it can become a sample or an audio clip. Needs macOS 13 and the Screen & System Audio Recording
// permission, which macOS asks for the first time.
import AVFoundation
import Cocoa
import ScreenCaptureKit

@available(macOS 13.0, *)
final class AppAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var left = [Float](), right = [Float]()
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "stratum.capture")
    private(set) var appName = ""
    let rate = 48000.0
    var seconds: Double { lock.lock(); defer { lock.unlock() }; return Double(left.count) / rate }

    /// Running apps that can be recorded: [{id, name}].
    static func apps(_ done: @escaping ([[String: String]]) -> Void) {
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, _ in
            let me = Bundle.main.bundleIdentifier
            var seen = Set<String>()
            let list = (content?.applications ?? []).filter { !$0.applicationName.isEmpty && $0.bundleIdentifier != me && seen.insert($0.bundleIdentifier).inserted }
                .map { ["id": $0.bundleIdentifier, "name": $0.applicationName] }
                .sorted { $0["name"]!.lowercased() < $1["name"]!.lowercased() }
            DispatchQueue.main.async { done(list) }
        }
    }

    func start(bundle: String, done: @escaping (String?) -> Void) {
        lock.lock(); left.removeAll(); right.removeAll(); lock.unlock()
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, err in
            guard let content = content, let display = content.displays.first, let app = content.applications.first(where: { $0.bundleIdentifier == bundle }) else {
                return DispatchQueue.main.async { done(err.map { "macOS did not allow it: \($0.localizedDescription)" } ?? "That app is no longer running.") }
            }
            let cfg = SCStreamConfiguration()
            cfg.capturesAudio = true; cfg.excludesCurrentProcessAudio = true
            cfg.sampleRate = Int(self.rate); cfg.channelCount = 2
            cfg.width = 2; cfg.height = 2; cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)   // sound only; the picture is ignored
            let s = SCStream(filter: SCContentFilter(display: display, including: [app], exceptingWindows: []), configuration: cfg, delegate: self)
            do { try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: self.queue) } catch { return DispatchQueue.main.async { done(error.localizedDescription) } }
            s.startCapture { e in
                DispatchQueue.main.async {
                    if e == nil { self.stream = s; self.appName = app.applicationName }
                    done(e.map { "macOS did not allow it: \($0.localizedDescription). Allow STRATUM in System Settings › Privacy & Security › Screen & System Audio Recording." })
                }
            }
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sb.isValid else { return }
        let frames = CMSampleBufferGetNumSamples(sb)
        let abl = AudioBufferList.allocate(maximumBuffers: 2)
        defer { free(abl.unsafeMutablePointer) }
        var block: CMBlockBuffer?
        guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sb, bufferListSizeNeededOut: nil, bufferListOut: abl.unsafeMutablePointer, bufferListSize: AudioBufferList.sizeInBytes(maximumBuffers: 2),
                                                                      blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: &block) == noErr, abl.count > 0 else { return }
        let l = abl[0].mData!.assumingMemoryBound(to: Float.self), r = abl[min(1, abl.count - 1)].mData!.assumingMemoryBound(to: Float.self)
        lock.lock()
        if left.count < Int(rate) * 60 * 10 {   // ten minutes at most
            left.append(contentsOf: UnsafeBufferPointer(start: l, count: frames))
            right.append(contentsOf: UnsafeBufferPointer(start: r, count: frames))
        }
        lock.unlock()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) { self.stream = nil }

    /// Stops and returns the recording as a WAV, with silence trimmed from both ends (nil if nothing was heard).
    func stop(_ done: @escaping (Data?) -> Void) {
        let finish = {
            self.lock.lock()
            let l = self.left, r = self.right
            self.lock.unlock()
            let loud = { (i: Int) in max(abs(l[i]), abs(r[i])) > 0.003 }
            guard let first = l.indices.first(where: loud), let last = l.indices.last(where: loud) else { return DispatchQueue.main.async { done(nil) } }
            let a = max(0, first - Int(self.rate * 0.005)), b = min(l.count, last + Int(self.rate * 0.05))
            let data = Recorder.wav(left: Array(l[a..<b]), right: Array(r[a..<b]), sampleRate: self.rate)
            DispatchQueue.main.async { done(data) }
        }
        guard let s = stream else { return finish() }
        stream = nil
        s.stopCapture { _ in finish() }
    }
}
