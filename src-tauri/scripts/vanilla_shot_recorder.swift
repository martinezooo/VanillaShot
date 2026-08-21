/// VanillaShot Memory – ScreenCaptureKit video recorder.
///
/// Records the primary display to a MOV file using H.264.
/// Periodically saves JPEG keyframes and prints their paths to stdout
/// so the parent process can run OCR on them.
///
/// Usage:
///   aye_recorder <video_path> <frames_dir> <duration_secs> <frame_interval_secs>
///
/// Control:
///   Sending "stop\n" on stdin or closing stdin triggers a graceful stop.
///   The process also exits after <duration_secs>.
///
/// Stdout protocol (one line per extracted frame):
///   <absolute_frame_path>\t<offset_seconds>

import Foundation
import AVFoundation
import CoreMedia
import CoreGraphics
import CoreImage

#if canImport(ScreenCaptureKit)
import ScreenCaptureKit
#endif

#if canImport(UniformTypeIdentifiers)
import UniformTypeIdentifiers
#endif

// ---------------------------------------------------------------------------
// MARK: - Args
// ---------------------------------------------------------------------------

guard CommandLine.arguments.count >= 5 else {
    fputs("Usage: aye_recorder <video_path> <frames_dir> <duration_secs> <frame_interval>\n", stderr)
    exit(1)
}

let videoPathArg   = CommandLine.arguments[1]
let framesDirArg   = CommandLine.arguments[2]
let durationArg    = Double(CommandLine.arguments[3]) ?? 300.0
let frameIntArg    = Double(CommandLine.arguments[4]) ?? 10.0

try? FileManager.default.createDirectory(atPath: framesDirArg, withIntermediateDirectories: true)

// ---------------------------------------------------------------------------
// MARK: - Recorder (macOS 12.3+)
// ---------------------------------------------------------------------------

guard #available(macOS 12.3, *) else {
    fputs("ERROR: VanillaShot Memory requires macOS 12.3 or later.\n", stderr)
    exit(1)
}

let finished = DispatchSemaphore(value: 0)
var processExitCode: Int32 = 0

@available(macOS 12.3, *)
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    let videoURL: URL
    let framesDirURL: URL
    let frameInterval: TimeInterval

    private var stream: SCStream?
    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var active = false
    private var baseTime: CMTime?
    private var lastFrameElapsed: TimeInterval = -999
    private var frameNum = 0
    private let ciCtx = CIContext()

    init(video: URL, frames: URL, interval: TimeInterval) {
        self.videoURL = video
        self.framesDirURL = frames
        self.frameInterval = interval
        super.init()
    }

    // MARK: Start

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: false
        )
        guard let display = content.displays.first else {
            throw NSError(domain: "Recorder", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "No display found"])
        }

        // Use 1× logical resolution for reasonable file sizes.
        let w = display.width
        let h = display.height

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.width = w
        config.height = h
        // 5 fps is plenty for a memory recorder.
        config.minimumFrameInterval = CMTime(value: 1, timescale: 5)
        config.queueDepth = 6
        config.showsCursor = true
        config.pixelFormat = kCVPixelFormatType_32BGRA

        // --- AVAssetWriter (H.264 MOV) ---
        try? FileManager.default.removeItem(at: videoURL)
        writer = try AVAssetWriter(url: videoURL, fileType: .mov)

        let vSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: w,
            AVVideoHeightKey: h,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 1_000_000,          // 1 Mbps
                AVVideoExpectedSourceFrameRateKey: 5,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ] as [String: Any],
        ]
        videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: vSettings)
        videoInput!.expectsMediaDataInRealTime = true

        adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: videoInput!,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: w,
                kCVPixelBufferHeightKey as String: h,
            ]
        )
        writer!.add(videoInput!)
        writer!.startWriting()
        writer!.startSession(atSourceTime: .zero)

        // --- SCStream ---
        stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream!.addStreamOutput(
            self, type: .screen,
            sampleHandlerQueue: DispatchQueue(label: "aye.recorder", qos: .userInitiated)
        )
        try await stream!.startCapture()
        active = true
        fputs("REC_STARTED\n", stderr)
    }

    // MARK: Stop

    func stop() {
        guard active else { return }
        active = false

        Task {
            try? await stream?.stopCapture()
            stream = nil
            videoInput?.markAsFinished()
            await writer?.finishWriting()
            fputs("REC_DONE\n", stderr)
            finished.signal()
        }
    }

    // MARK: SCStreamOutput

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer buf: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .screen, active, buf.isValid,
              let pb = CMSampleBufferGetImageBuffer(buf)
        else { return }

        let pts = CMSampleBufferGetPresentationTimeStamp(buf)
        if baseTime == nil { baseTime = pts }
        let elapsed = CMTimeGetSeconds(pts) - CMTimeGetSeconds(baseTime!)
        let rel = CMTimeSubtract(pts, baseTime!)

        // Write video frame.
        if let vi = videoInput, vi.isReadyForMoreMediaData {
            adaptor?.append(pb, withPresentationTime: rel)
        }

        // Periodic JPEG keyframe for OCR.
        if elapsed - lastFrameElapsed >= frameInterval {
            lastFrameElapsed = elapsed
            frameNum += 1
            saveJPEG(pb, n: frameNum, elapsed: elapsed)
        }
    }

    // MARK: SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("STREAM_ERROR: \(error.localizedDescription)\n", stderr)
        stop()
    }

    // MARK: JPEG extraction

    private func saveJPEG(_ pb: CVPixelBuffer, n: Int, elapsed: TimeInterval) {
        let ci = CIImage(cvPixelBuffer: pb)
        guard let cg = ciCtx.createCGImage(ci, from: ci.extent) else { return }

        let name = String(format: "frame-%06d.jpg", n)
        let url = framesDirURL.appendingPathComponent(name)

        let uti: CFString
        if #available(macOS 14.0, *) {
            uti = UTType.jpeg.identifier as CFString
        } else {
            uti = "public.jpeg" as CFString
        }
        guard let dst = CGImageDestinationCreateWithURL(url as CFURL, uti, 1, nil) else { return }
        let opts: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.60]
        CGImageDestinationAddImage(dst, cg, opts as CFDictionary)
        guard CGImageDestinationFinalize(dst) else { return }

        // Protocol line: <path>\t<offset_secs>
        print("\(url.path)\t\(String(format: "%.1f", elapsed))")
        fflush(stdout)
    }
}

// ---------------------------------------------------------------------------
// MARK: - Main
// ---------------------------------------------------------------------------

let recorder = Recorder(
    video: URL(fileURLWithPath: videoPathArg),
    frames: URL(fileURLWithPath: framesDirArg),
    interval: frameIntArg
)

// Listen for "stop" / EOF on stdin.
DispatchQueue.global(qos: .utility).async {
    while let line = readLine() {
        if line.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "stop" {
            recorder.stop()
            return
        }
    }
    // stdin closed → parent exited.
    recorder.stop()
}

// Start recording.
Task {
    do {
        try await recorder.start()

        // Auto-stop after duration.
        DispatchQueue.main.asyncAfter(deadline: .now() + durationArg) {
            recorder.stop()
        }
    } catch {
        fputs("FATAL: \(error.localizedDescription)\n", stderr)
        processExitCode = 1
        finished.signal()
    }
}

// Keep process alive.
finished.wait()
exit(processExitCode)
