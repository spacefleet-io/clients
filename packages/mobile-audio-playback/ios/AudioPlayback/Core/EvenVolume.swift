import Foundation

/// Even out volume (PAR-PLAY-03 item 2), the iPhone's counterpart of Android's `EvenVolume.kt`: off by default, every
/// song then plays as recorded (gain 0 dB). On, each song plays with its own gain in dB, set by the app per media id.
/// The gain is applied to the decoded samples of each queue item by that item's audio tap, so it holds from the item's
/// first sample and switches exactly where one song's samples end and the next one's begin. At Loud the
/// [ParrotLimiter] keeps the lifted peaks at −1 dB.
///
/// Pure Swift (no AVFoundation): `AudioTap` feeds it from the render thread, the XCTest cases drive it directly.
public final class EvenVolume {
  public static let shared = EvenVolume()

  private let lock = NSLock()
  private var gains: [String: Float] = [:]
  private var limitingOn = false

  public init() {}

  /// Gain in dB of `mediaId`; a song with none plays as recorded (0 dB).
  public func gainDb(_ mediaId: String?) -> Float {
    guard let mediaId else { return 0 }
    lock.lock()
    defer { lock.unlock() }
    return gains[mediaId] ?? 0
  }

  public func setGainDb(_ mediaId: String, _ db: Float) {
    lock.lock()
    gains[mediaId] = db
    lock.unlock()
  }

  public func setGainsDb(_ values: [String: Float]) {
    lock.lock()
    gains.merge(values) { _, new in new }
    lock.unlock()
  }

  /// The limiter runs (Even out volume at Loud). Turning it on or off shifts the sound by its 5 ms look-ahead once.
  public var limiting: Bool {
    get {
      lock.lock()
      defer { lock.unlock() }
      return limitingOn
    }
    set {
      lock.lock()
      limitingOn = newValue
      lock.unlock()
    }
  }

  /// Linear factor of a gain in dB.
  public static func linear(_ db: Float) -> Float { powf(10, db / 20) }
}

/// Scales float PCM by a song's gain, then limits it while `EvenVolume.limiting` is on. One processor serves every
/// queue item in play order, so the limiter's look-ahead runs on from one song into the next and gapless stays gapless
/// (Android's single `EvenVolumeProcessor`). `flush()` forgets the look-ahead after a jump (seek, another song).
///
/// Called from the audio render thread only, apart from `flush()` which only raises a flag.
public final class EvenVolumeProcessor {
  public typealias Log = (String) -> Void

  private let settings: EvenVolume
  private let log: Log
  private var limiter: ParrotLimiter?
  private let flushLock = NSLock()
  private var flushPending = false
  private var appliedId: String?
  private var appliedDb = Float.nan

  public init(settings: EvenVolume = .shared, log: @escaping Log = { _ in }) {
    self.settings = settings
    self.log = log
  }

  /// The audio before now and after it are not one stream (a seek, a jump to another song): the next samples start
  /// with an empty look-ahead.
  public func flush() {
    flushLock.lock()
    flushPending = true
    flushLock.unlock()
  }

  /// How many frames the limiter delays the sound right now (0 while it is off).
  public var latency: Int { limiter?.latency ?? 0 }

  /// The limiter for this format while limiting is on; nil (and forgotten) while it is off.
  private func activeLimiter(sampleRate: Int, channels: Int) -> ParrotLimiter? {
    flushLock.lock()
    let flushing = flushPending
    flushPending = false
    flushLock.unlock()
    guard settings.limiting else {
      if limiter != nil { log("audio.limiter on=false") }
      limiter = nil
      return nil
    }
    if let limiter, limiter.sampleRate == sampleRate, limiter.channels == channels {
      if flushing { limiter.reset() }
      return limiter
    }
    let created = ParrotLimiter(sampleRate: sampleRate, channels: channels)
    log("audio.limiter on=true rate=\(sampleRate) channels=\(channels) lookahead_frames=\(created.latency)")
    limiter = created
    return created
  }

  private func factor(for mediaId: String?) -> Float {
    let db = settings.gainDb(mediaId)
    if mediaId != appliedId || db != appliedDb {
      log("audio.gain media=\(mediaId ?? "-") db=\(String(format: "%.2f", db))")
      appliedId = mediaId
      appliedDb = db
    }
    return db == 0 ? 1 : EvenVolume.linear(db)
  }

  /// Non-interleaved float audio of `mediaId`: `channelData[c]` holds `frames` samples of channel `c`.
  public func process(
    planar channelData: UnsafeMutableBufferPointer<UnsafeMutablePointer<Float>>,
    channels: Int,
    frames: Int,
    sampleRate: Int,
    mediaId: String?
  ) {
    let gain = factor(for: mediaId)
    if gain != 1 {
      for channel in 0..<channels {
        let samples = channelData[channel]
        for frame in 0..<frames { samples[frame] *= gain }
      }
    }
    activeLimiter(sampleRate: sampleRate, channels: channels)?.process(planar: channelData, frames: frames)
  }

  /// Interleaved float audio of `mediaId`: `frames` frames of `channels` samples each.
  public func process(
    interleaved samples: UnsafeMutablePointer<Float>,
    channels: Int,
    frames: Int,
    sampleRate: Int,
    mediaId: String?
  ) {
    let gain = factor(for: mediaId)
    if gain != 1 {
      for index in 0..<(frames * channels) { samples[index] *= gain }
    }
    activeLimiter(sampleRate: sampleRate, channels: channels)?.process(interleaved: samples, frames: frames)
  }
}
