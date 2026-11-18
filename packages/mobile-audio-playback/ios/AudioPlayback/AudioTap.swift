import AVFoundation
import MediaToolbox

/// The even-volume tap of one queue item (PAR-PLAY-03 item 2): an `MTAudioProcessingTap` on the item's audio mix runs
/// every decoded sample of that item through the shared `EvenVolumeProcessor` with the item's media id, so the song's
/// gain holds from its first sample and the limiter's look-ahead runs on from one song into the next.
enum AudioTap {
  /// One processor for every item, in play order (the render thread runs one item's samples at a time); the lock
  /// covers the moments two items' taps overlap (a preroll of the next item).
  static let processor = EvenVolumeProcessor(log: { AudioLog.info($0) })
  private static let lock = NSLock()

  final class Context {
    let mediaId: String
    var sampleRate = 44_100
    var channels = 0
    var float = false
    var interleaved = false
    var table: UnsafeMutableBufferPointer<UnsafeMutablePointer<Float>>?
    var loggedFormat = false

    init(mediaId: String) { self.mediaId = mediaId }

    deinit { table?.deallocate() }
  }

  /// The audio mix that runs `track`'s samples through the tap of `mediaId`; nil (logged) when the tap cannot be made.
  static func mix(track: AVAssetTrack, mediaId: String) -> AVAudioMix? {
    let context = Context(mediaId: mediaId)
    var callbacks = MTAudioProcessingTapCallbacks(
      version: kMTAudioProcessingTapCallbacksVersion_0,
      clientInfo: UnsafeMutableRawPointer(Unmanaged.passRetained(context).toOpaque()),
      init: { _, clientInfo, tapStorageOut in tapStorageOut.pointee = clientInfo },
      finalize: { tap in Unmanaged<Context>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).release() },
      prepare: { tap, _, format in
        let context = Unmanaged<Context>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue()
        let description = format.pointee
        context.sampleRate = Int(description.mSampleRate)
        context.channels = Int(description.mChannelsPerFrame)
        context.float = description.mFormatFlags & kAudioFormatFlagIsFloat != 0 && description.mBitsPerChannel == 32
        context.interleaved = description.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0
        context.table?.deallocate()
        context.table = context.channels > 0
          ? UnsafeMutableBufferPointer<UnsafeMutablePointer<Float>>.allocate(capacity: context.channels) : nil
        AudioLog.info(
          "audio.tap.prepare media=\(context.mediaId) rate=\(context.sampleRate) channels=\(context.channels) "
            + "float=\(context.float) interleaved=\(context.interleaved) bits=\(description.mBitsPerChannel)")
      },
      unprepare: { tap in
        let context = Unmanaged<Context>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue()
        AudioLog.debug("audio.tap.unprepare media=\(context.mediaId)")
      },
      process: { tap, frameCount, _, bufferList, frameCountOut, flagsOut in
        let status = MTAudioProcessingTapGetSourceAudio(tap, frameCount, bufferList, flagsOut, nil, frameCountOut)
        guard status == noErr else { return }
        let context = Unmanaged<Context>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue()
        AudioTap.process(context, bufferList, frames: Int(frameCountOut.pointee))
      }
    )
    var tapOut: MTAudioProcessingTap?
    let status = MTAudioProcessingTapCreate(
      kCFAllocatorDefault, &callbacks, kMTAudioProcessingTapCreationFlag_PreEffects, &tapOut)
    guard status == noErr, let tap = tapOut else {
      // The context retained for the tap is never handed over: give it back.
      Unmanaged.passUnretained(context).release()
      AudioLog.error("audio.tap.create_failed media=\(mediaId) status=\(status)")
      return nil
    }
    let parameters = AVMutableAudioMixInputParameters(track: track)
    parameters.audioTapProcessor = tap
    let mix = AVMutableAudioMix()
    mix.inputParameters = [parameters]
    return mix
  }

  private static func process(_ context: Context, _ bufferList: UnsafeMutablePointer<AudioBufferList>, frames: Int) {
    guard frames > 0, context.float, context.channels > 0 else {
      if !context.loggedFormat {
        context.loggedFormat = true
        AudioLog.warn("audio.tap.unprocessed media=\(context.mediaId) reason=not_float32 channels=\(context.channels)")
      }
      return
    }
    let buffers = UnsafeMutableAudioBufferListPointer(bufferList)
    lock.lock()
    defer { lock.unlock() }
    if context.interleaved {
      guard let data = buffers.first?.mData else { return }
      processor.process(
        interleaved: data.assumingMemoryBound(to: Float.self), channels: context.channels, frames: frames,
        sampleRate: context.sampleRate, mediaId: context.mediaId)
      return
    }
    guard let table = context.table, buffers.count >= context.channels else { return }
    for channel in 0..<context.channels {
      guard let data = buffers[channel].mData else { return }
      table[channel] = data.assumingMemoryBound(to: Float.self)
    }
    processor.process(
      planar: table, channels: context.channels, frames: frames, sampleRate: context.sampleRate,
      mediaId: context.mediaId)
  }
}
