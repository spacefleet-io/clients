import XCTest

/// @req PAR-PLAY-03
///
/// Even out volume at Loud lifts quiet songs past their peaks; the iPhone's limiter keeps every sample at or under
/// −1 dB (Spotify's limiter: −1 dB, 5 ms attack, 100 ms decay) and leaves audio under that untouched, only 5 ms late.
/// Mirrors Android's `ParrotLimiterTest.kt`; the gain cases cover the per-song gain of `EvenVolumeProcessor`.
final class ParrotLimiterTests: XCTestCase {
  private let rate = 48_000
  private let ceiling = pow(10.0, -1.0 / 20.0)

  private func stereoSine(amplitude: Double, seconds: Double) -> [Float] {
    let frames = Int(Double(rate) * seconds)
    return (0..<(frames * 2)).map { index in
      let frame = index / 2
      let hz = index % 2 == 0 ? 220.0 : 331.0
      return Float(amplitude * sin(2 * Double.pi * hz * Double(frame) / Double(rate)))
    }
  }

  func testKeepsEverySampleAtOrUnderMinusOneDb() {
    let lift = pow(10.0, 9.0 / 20.0)
    var samples = stereoSine(amplitude: 0.5 * lift, seconds: 2.0)
    for hit in 0..<8 {
      samples[Int((Double(hit) + 0.5) * Double(rate) * 0.25) * 2] = Float(0.99 * lift * (hit % 2 == 0 ? 1 : -1))
    }
    let inputPeak = samples.map { abs($0) }.max()!
    let limiter = ParrotLimiter(sampleRate: rate, channels: 2)
    // In 512-frame blocks, as the render thread hands them over.
    var start = 0
    while start < samples.count / 2 {
      let frames = min(512, samples.count / 2 - start)
      var block = Array(samples[(start * 2)..<((start + frames) * 2)])
      limiter.process(&block, frames: frames)
      samples.replaceSubrange((start * 2)..<((start + frames) * 2), with: block)
      start += 512
    }
    let outputPeak = samples.map { abs($0) }.max()!
    print("[PARROT-LIMITER-IOS] input peak \(inputPeak), output peak \(outputPeak), ceiling \(ceiling), latency \(limiter.latency)")
    XCTAssertGreaterThan(inputPeak, 1.5)
    XCTAssertLessThanOrEqual(Double(outputPeak), ceiling + 1e-6, "output peak \(outputPeak) over \(ceiling)")
    XCTAssertEqual(limiter.latency, 239)
  }

  func testPassesQuietAudioThroughOnlyDelayed() {
    let input = stereoSine(amplitude: 0.8, seconds: 0.5)
    var output = input
    let limiter = ParrotLimiter(sampleRate: rate, channels: 2)
    limiter.process(&output, frames: output.count / 2)
    var worst: Float = 0
    for index in (limiter.latency * 2)..<output.count {
      worst = max(worst, abs(output[index] - input[index - limiter.latency * 2]))
    }
    print("[PARROT-LIMITER-IOS] largest difference from the delayed input \(worst), gain \(limiter.currentGain)")
    XCTAssertLessThan(worst, 1e-6)
    XCTAssertEqual(limiter.currentGain, 1.0)
  }

  /// The tap's buffers are non-interleaved: the planar path limits exactly like the interleaved one.
  func testPlanarMatchesInterleaved() {
    let lift = pow(10.0, 9.0 / 20.0)
    let interleavedIn = stereoSine(amplitude: 0.7 * lift, seconds: 0.3)
    let frames = interleavedIn.count / 2
    var interleaved = interleavedIn
    ParrotLimiter(sampleRate: rate, channels: 2).process(&interleaved, frames: frames)
    let left = UnsafeMutablePointer<Float>.allocate(capacity: frames)
    let right = UnsafeMutablePointer<Float>.allocate(capacity: frames)
    let table = UnsafeMutableBufferPointer<UnsafeMutablePointer<Float>>.allocate(capacity: 2)
    defer { left.deallocate(); right.deallocate(); table.deallocate() }
    for frame in 0..<frames {
      left[frame] = interleavedIn[frame * 2]
      right[frame] = interleavedIn[frame * 2 + 1]
    }
    table[0] = left
    table[1] = right
    ParrotLimiter(sampleRate: rate, channels: 2).process(planar: table, frames: frames)
    var worst: Float = 0
    for frame in 0..<frames {
      worst = max(worst, abs(left[frame] - interleaved[frame * 2]), abs(right[frame] - interleaved[frame * 2 + 1]))
    }
    print("[PARROT-LIMITER-IOS] planar vs interleaved largest difference \(worst) over \(frames) frames")
    XCTAssertEqual(worst, 0)
  }
}

/// @req PAR-PLAY-03
///
/// Each song plays at its own even-volume gain, as recorded (bit-exact) at 0 dB, and a live `setGains` change applies
/// from the next samples; the limiter runs on from one song into the next and starts empty after a flush (a jump).
final class EvenVolumeProcessorTests: XCTestCase {
  private func render(
    _ processor: EvenVolumeProcessor, _ samples: [Float], mediaId: String?, channels: Int = 1, rate: Int = 48_000
  ) -> [Float] {
    var out = samples
    out.withUnsafeMutableBufferPointer { buffer in
      processor.process(
        interleaved: buffer.baseAddress!, channels: channels, frames: samples.count / channels, sampleRate: rate,
        mediaId: mediaId)
    }
    return out
  }

  func testUnknownSongAndZeroDbPlayAsRecorded() {
    let settings = EvenVolume()
    settings.setGainDb("b", 0)
    let processor = EvenVolumeProcessor(settings: settings, log: { print("[EVEN-VOLUME-IOS] \($0)") })
    let input: [Float] = [0.1, -0.25, 0.5, -0.999, 0.3333]
    let a = render(processor, input, mediaId: "a")
    let b = render(processor, input, mediaId: "b")
    let none = render(processor, input, mediaId: nil)
    print("[EVEN-VOLUME-IOS] input \(input) a \(a) b \(b) nil \(none)")
    XCTAssertEqual(a, input)
    XCTAssertEqual(b, input)
    XCTAssertEqual(none, input)
  }

  func testEachSongTakesItsOwnGainAndLiveChanges() {
    let settings = EvenVolume()
    settings.setGainsDb(["quiet": 6, "loud": -6])
    let processor = EvenVolumeProcessor(settings: settings, log: { print("[EVEN-VOLUME-IOS] \($0)") })
    let input: [Float] = [0.25, -0.25]
    let quiet = render(processor, input, mediaId: "quiet")
    let loud = render(processor, input, mediaId: "loud")
    settings.setGainsDb(["loud": -12])
    let changed = render(processor, input, mediaId: "loud")
    print("[EVEN-VOLUME-IOS] input \(input) quiet(+6) \(quiet) loud(-6) \(loud) loud(-12) \(changed)")
    XCTAssertEqual(Double(quiet[0]), 0.25 * pow(10, 6.0 / 20), accuracy: 1e-6)
    XCTAssertEqual(Double(loud[1]), -0.25 * pow(10, -6.0 / 20), accuracy: 1e-6)
    XCTAssertEqual(Double(changed[0]), 0.25 * pow(10, -12.0 / 20), accuracy: 1e-6)
  }

  func testLimiterCarriesAcrossSongsAndEmptiesOnFlush() {
    let settings = EvenVolume()
    settings.limiting = true
    let processor = EvenVolumeProcessor(settings: settings, log: { print("[EVEN-VOLUME-IOS] \($0)") })
    let latency = 239
    // Song A ends on `latency` frames of 0.5; song B starts with silence: those frames come out at B's start.
    let tailOfA = render(processor, [Float](repeating: 0.5, count: latency), mediaId: "a")
    let startOfB = render(processor, [Float](repeating: 0, count: latency), mediaId: "b")
    print("[EVEN-VOLUME-IOS] latency \(processor.latency) A tail first \(tailOfA.first!) B start first \(startOfB.first!) last \(startOfB.last!)")
    XCTAssertEqual(processor.latency, latency)
    XCTAssertEqual(startOfB.last!, 0.5, accuracy: 1e-6)
    XCTAssertEqual(startOfB.first!, 0.5, accuracy: 1e-6)
    // A seek flushes: what was in the look-ahead never plays after it.
    _ = render(processor, [Float](repeating: 0.5, count: latency), mediaId: "b")
    processor.flush()
    let afterSeek = render(processor, [Float](repeating: 0, count: latency), mediaId: "b")
    print("[EVEN-VOLUME-IOS] after flush peak \(afterSeek.map { abs($0) }.max()!)")
    XCTAssertEqual(afterSeek.map { abs($0) }.max()!, 0)
    // Off: no look-ahead, the samples pass straight through.
    settings.limiting = false
    let off = render(processor, [0.5, 0.25], mediaId: "b")
    print("[EVEN-VOLUME-IOS] limiting off \(off) latency \(processor.latency)")
    XCTAssertEqual(off, [0.5, 0.25])
    XCTAssertEqual(processor.latency, 0)
  }
}
