import Foundation

/// The limiter of "Even out volume" at Loud (PAR-PLAY-03 item 2), as Spotify's: it engages at −1 dB (sample values),
/// with a 5 ms attack and a 100 ms decay. The iPhone's port of the Android `ParrotLimiter.kt` (itself the port of
/// `@space/parrot-core/limiter`), step for step: it looks ahead by the attack time, so every output sample stays at or
/// under −1 dB.
///
/// Each frame needs a gain of at most threshold / |sample| (the loudest channel; channels share one gain). The lowest
/// need over the last `attack` frames, averaged over another `attack` frames, is never above the need of the frame that
/// sits `attack − 1` frames back, so the input is delayed by that much. The gain falls at once and rises back with the
/// 100 ms decay.
///
/// Pure Swift (no AVFoundation): the audio tap feeds it, the XCTest cases drive it directly. Not thread-safe: one
/// render thread at a time.
public final class ParrotLimiter {
  public static let thresholdDb = -1.0
  public static let attackMs = 5.0
  public static let releaseMs = 100.0

  public let sampleRate: Int
  public let channels: Int
  private let threshold: Double
  private let attack: Int
  private let release: Double

  /// How many frames the output lags the input.
  public let latency: Int

  private var delay: [Float]
  private var delayAt = 0
  private var minPos: [Int64]
  private var minNeed: [Double]
  private var minHead = 0
  private var minSize = 0
  private var lows: [Double]
  private var lowsAt = 0
  private var lowsSum: Double
  private var position: Int64 = 0

  /// The gain applied to the last frame output (1 = untouched).
  public private(set) var currentGain = 1.0

  public init(sampleRate: Int, channels: Int) {
    self.sampleRate = sampleRate
    self.channels = max(1, channels)
    threshold = pow(10.0, Self.thresholdDb / 20.0)
    attack = max(1, Int((Double(sampleRate) * Self.attackMs / 1000.0).rounded()))
    release = 1 - exp(-1.0 / (Double(sampleRate) * Self.releaseMs / 1000.0))
    latency = attack - 1
    delay = [Float](repeating: 0, count: attack * self.channels)
    minPos = [Int64](repeating: 0, count: attack + 1)
    minNeed = [Double](repeating: 0, count: attack + 1)
    lows = [Double](repeating: 1.0, count: attack)
    lowsSum = Double(attack)
  }

  public func reset() {
    for index in delay.indices { delay[index] = 0 }
    delayAt = 0
    minHead = 0
    minSize = 0
    for index in lows.indices { lows[index] = 1.0 }
    lowsAt = 0
    lowsSum = Double(attack)
    currentGain = 1.0
  }

  /// Limits `frames` interleaved frames of `samples` in place.
  public func process(_ samples: inout [Float], frames: Int) {
    samples.withUnsafeMutableBufferPointer { buffer in
      process(interleaved: buffer.baseAddress!, frames: frames)
    }
  }

  /// Limits `frames` interleaved frames at `samples` in place (`channels` floats per frame).
  public func process(interleaved samples: UnsafeMutablePointer<Float>, frames: Int) {
    let stride = channels
    process(frames: frames) { frame, channel in samples + (frame * stride + channel) }
  }

  /// Limits `frames` frames of non-interleaved audio in place: `channelData[c]` holds channel `c`'s samples (the
  /// layout of an audio tap's float buffers). The caller owns the pointer table, so the render thread allocates nothing.
  public func process(planar channelData: UnsafeMutableBufferPointer<UnsafeMutablePointer<Float>>, frames: Int) {
    precondition(channelData.count >= channels, "one buffer per channel")
    process(frames: frames) { frame, channel in channelData[channel] + frame }
  }

  @inline(__always)
  private func process(frames: Int, sample: (Int, Int) -> UnsafeMutablePointer<Float>) {
    let capacity = minPos.count
    for frame in 0..<frames {
      var loudest = 0.0
      for channel in 0..<channels { loudest = max(loudest, abs(Double(sample(frame, channel).pointee))) }
      let need = loudest > threshold ? threshold / loudest : 1.0
      while minSize > 0 && minNeed[(minHead + minSize - 1) % capacity] >= need { minSize -= 1 }
      let tail = (minHead + minSize) % capacity
      minPos[tail] = position
      minNeed[tail] = need
      minSize += 1
      if minPos[minHead] <= position - Int64(attack) {
        minHead = (minHead + 1) % capacity
        minSize -= 1
      }
      let low = minNeed[minHead]
      lowsSum += low - lows[lowsAt]
      lows[lowsAt] = low
      lowsAt = (lowsAt + 1) % attack
      // Re-add from scratch once a window so rounding never drifts the average upwards.
      if lowsAt == 0 { lowsSum = lows.reduce(0, +) }
      let target = min(1.0, lowsSum / Double(attack))
      currentGain = target < currentGain ? target : currentGain + (target - currentGain) * release
      position += 1
      let readAt = (delayAt + 1) % attack
      for channel in 0..<channels {
        let pointer = sample(frame, channel)
        delay[delayAt * channels + channel] = pointer.pointee
        let delayed = attack == 1 ? delay[delayAt * channels + channel] : delay[readAt * channels + channel]
        pointer.pointee = Float(Double(delayed) * currentGain)
      }
      delayAt = readAt
    }
  }
}
