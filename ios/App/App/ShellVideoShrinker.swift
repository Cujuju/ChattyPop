import AVFoundation

/// Re-encodes a library video to H.264 and AAC in MP4 at the page's send quality (ShellVideoShrink in src/shared/shell.ts), so a
/// large video is cut down before the page reads it: WebKit holds the page's File in memory. Upright, HDR tone-mapped to SDR,
/// its shorter side scaled down to the target's (never up), at the target's rate scaled by area, frames capped at its rate.
enum ShellVideoShrinker {
    struct Target {
        let shortSide: Int
        /// Video bitrate at the full shorter side, bit/s.
        let videoBitrate: Int
        let audioBitrate: Int
        let maxFrameRate: Int
    }

    enum ShrinkError: LocalizedError {
        case noVideo, notStarted

        var errorDescription: String? {
            switch self {
            case .noVideo: return "The video has no picture to send."
            case .notStarted: return "Could not start shrinking the video."
            }
        }
    }

    private static let audioChannels = 2
    private static let audioSampleRate = 48_000
    /// Seconds between key frames.
    private static let keyFrameInterval = 2
    /// H.264 4:2:0 needs even dimensions.
    private static let dimensionStep: CGFloat = 2
    /// Timescale for the frame duration: divisible by common frame rates.
    private static let frameTimescale: Int32 = 600

    /// The upright shorter side of the video's picture, px.
    static func shortSide(of asset: AVAsset) async throws -> Int {
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw ShrinkError.noVideo }
        let (natural, transform) = try await track.load(.naturalSize, .preferredTransform)
        let upright = natural.applying(transform)
        return Int(min(abs(upright.width), abs(upright.height)))
    }

    /// Writes `asset` to `url` at `target`. Throws if reading or writing fails; the caller removes `url` then.
    static func shrink(_ asset: AVAsset, to url: URL, target: Target) async throws {
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw ShrinkError.noVideo }
        let (natural, transform, nominalRate) = try await track.load(.naturalSize, .preferredTransform, .nominalFrameRate)
        let duration = try await asset.load(.duration)
        let audioTracks = try await asset.loadTracks(withMediaType: .audio)

        let upright = natural.applying(transform)
        let source = CGSize(width: abs(upright.width), height: abs(upright.height))
        let sourceShort = min(source.width, source.height)
        let scale = min(1, CGFloat(target.shortSide) / sourceShort)
        let even = { (px: CGFloat) in max(dimensionStep, (px * scale / dimensionStep).rounded(.down) * dimensionStep) }
        let size = CGSize(width: even(source.width), height: even(source.height))
        // The target's rate at its full shorter side, scaled down by area below it (presetBitrate in src/shared/videoEncode.ts).
        let areaRatio = min(1, pow(min(size.width, size.height) / CGFloat(target.shortSide), 2))
        let videoBitrate = Int((CGFloat(target.videoBitrate) * areaRatio).rounded())
        let frameRate = nominalRate > 0 ? min(Int(nominalRate.rounded()), target.maxFrameRate) : target.maxFrameRate

        // The composition turns the picture upright, scales it and tone-maps HDR to Rec. 709.
        let instruction = AVMutableVideoCompositionInstruction()
        instruction.timeRange = CMTimeRange(start: .zero, duration: duration)
        let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: track)
        layer.setTransform(transform.concatenating(CGAffineTransform(scaleX: size.width / source.width, y: size.height / source.height)), at: .zero)
        instruction.layerInstructions = [layer]
        let composition = AVMutableVideoComposition()
        composition.instructions = [instruction]
        composition.renderSize = size
        composition.frameDuration = CMTime(value: CMTimeValue(Int(frameTimescale) / max(frameRate, 1)), timescale: frameTimescale)
        composition.colorPrimaries = AVVideoColorPrimaries_ITU_R_709_2
        composition.colorTransferFunction = AVVideoTransferFunction_ITU_R_709_2
        composition.colorYCbCrMatrix = AVVideoYCbCrMatrix_ITU_R_709_2

        let reader = try AVAssetReader(asset: asset)
        let videoOut = AVAssetReaderVideoCompositionOutput(videoTracks: [track], videoSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        ])
        videoOut.videoComposition = composition
        reader.add(videoOut)

        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        writer.shouldOptimizeForNetworkUse = true
        let videoIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: size.width,
            AVVideoHeightKey: size.height,
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: videoBitrate,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoMaxKeyFrameIntervalDurationKey: keyFrameInterval,
            ],
        ])
        videoIn.expectsMediaDataInRealTime = false
        writer.add(videoIn)
        var pumps = [Pump(output: videoOut, input: videoIn)]

        if !audioTracks.isEmpty {
            var stereo = AudioChannelLayout()
            stereo.mChannelLayoutTag = kAudioChannelLayoutTag_Stereo
            let layout = Data(bytes: &stereo, count: MemoryLayout<AudioChannelLayout>.size)
            let audioOut = AVAssetReaderAudioMixOutput(audioTracks: audioTracks, audioSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: audioSampleRate,
                AVNumberOfChannelsKey: audioChannels,
                AVChannelLayoutKey: layout,
            ])
            reader.add(audioOut)
            let audioIn = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: audioSampleRate,
                AVNumberOfChannelsKey: audioChannels,
                AVChannelLayoutKey: layout,
                AVEncoderBitRateKey: target.audioBitrate,
            ])
            audioIn.expectsMediaDataInRealTime = false
            writer.add(audioIn)
            pumps.append(Pump(output: audioOut, input: audioIn))
        }

        guard reader.startReading(), writer.startWriting() else {
            reader.cancelReading()
            throw writer.error ?? reader.error ?? ShrinkError.notStarted
        }
        writer.startSession(atSourceTime: .zero)
        await withTaskGroup(of: Void.self) { group in
            for pump in pumps { group.addTask { await pump.run() } }
        }
        guard reader.status == .completed else {
            writer.cancelWriting()
            throw reader.error ?? ShrinkError.notStarted
        }
        await writer.finishWriting()
        guard writer.status == .completed else { throw writer.error ?? ShrinkError.notStarted }
    }

    /// Moves one track's samples from the reader to the writer as the writer takes them. Sendable: only its queue touches it.
    private final class Pump: @unchecked Sendable {
        private let output: AVAssetReaderOutput
        private let input: AVAssetWriterInput
        private let queue = DispatchQueue(label: "com.cujuju.chattypop.video-shrink")

        init(output: AVAssetReaderOutput, input: AVAssetWriterInput) {
            self.output = output
            self.input = input
        }

        /// Returns once the track ends, or the writer refuses a sample (the writer's status then tells why).
        func run() async {
            await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
                var finished = false
                input.requestMediaDataWhenReady(on: queue) { [self] in
                    while !finished && input.isReadyForMoreMediaData {
                        guard let sample = output.copyNextSampleBuffer(), input.append(sample) else {
                            finished = true
                            input.markAsFinished()
                            done.resume()
                            return
                        }
                    }
                }
            }
        }
    }
}
