import AVFoundation
import MediaPlayer
import React
import UIKit

/// The iPhone side of `@space/mobile-media-session` (PLAY-OSMEDIA-01): hands the Badger player to Now Playing (lock
/// screen, Control Center, AirPods / headset buttons, CarPlay). JS sends the plan `planMediaSession` built; every
/// remote command comes back as the `SpaceMediaSessionAction` event `{ action, seekTimeMs?, seekOffsetMs? }`, the same
/// contract as the Android Media3 session.
///
/// iOS only shows Now Playing for the app that owns an active `.playback` audio session and last produced sound. Local
/// playback has mpv's audio unit for that (MpvEngine sets `.playback` / `.moviePlayback`), but in TV-remote mode the
/// phone plays nothing. So, like Badger desktop's silent WAV, the module loops a silent clip while the plan is
/// `playing`, pauses it while `paused` (Now Playing stays and play resumes) and stops it on `none`. Next to mpv it is
/// inaudible and harmless (same app, same session).
@objc(SpaceMediaSession)
final class SpaceMediaSession: RCTEventEmitter {
  private static let actionEvent = "SpaceMediaSessionAction"
  private static let seekStepS = 10.0

  private var hasListeners = false
  private var playbackState = "none"
  /// Commands this module added a target to, so `none` can remove exactly those.
  private var targets: [(MPRemoteCommand, Any)] = []
  private var artworkUri: String?
  private var artwork: MPMediaItemArtwork?
  private var keepAlive: AVAudioPlayer?

  override static func requiresMainQueueSetup() -> Bool { true }
  // MPRemoteCommandCenter and the audio session are driven from the main queue.
  override var methodQueue: DispatchQueue! { DispatchQueue.main }
  override func supportedEvents() -> [String]! { [Self.actionEvent] }
  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }

  deinit {
    // Runs on whatever thread drops the bridge; command targets and the player belong to main.
    let targets = self.targets
    let player = keepAlive
    DispatchQueue.main.async {
      for (command, target) in targets { command.removeTarget(target); command.isEnabled = false }
      player?.stop()
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }
  }

  // MARK: JS API

  @objc(update:)
  func update(_ plan: NSDictionary) {
    let state = plan["playbackState"] as? String ?? "none"
    guard state == "playing" || state == "paused" else {
      releaseSession()
      return
    }
    let actions = Set((plan["actions"] as? [String]) ?? [])
    let rate = (plan["rate"] as? NSNumber)?.doubleValue ?? 1
    var info: [String: Any] = [
      MPMediaItemPropertyTitle: plan["title"] as? String ?? "",
      MPMediaItemPropertyArtist: plan["artist"] as? String ?? "",
      MPMediaItemPropertyAlbumTitle: plan["album"] as? String ?? "",
      MPNowPlayingInfoPropertyPlaybackRate: state == "playing" ? rate : 0,
      MPNowPlayingInfoPropertyDefaultPlaybackRate: 1,
    ]
    if let durationMs = (plan["durationMs"] as? NSNumber)?.doubleValue, durationMs > 0 {
      info[MPMediaItemPropertyPlaybackDuration] = durationMs / 1000
    }
    if let positionMs = (plan["positionMs"] as? NSNumber)?.doubleValue, positionMs >= 0 {
      info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = positionMs / 1000
    }
    if let artwork = loadArtwork(plan["artworkUri"] as? String) {
      info[MPMediaItemPropertyArtwork] = artwork
    }
    let wasReleased = playbackState == "none"
    playbackState = state
    setKeepAlive(playing: state == "playing")
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    bindCommands(actions)
    if wasReleased {
      NSLog("[SpaceMediaSession] session.start state=%@ actions=%@", state, actions.sorted().joined(separator: ","))
    }
  }

  /// JS `release()`; `release` itself is NSObject's retain/release selector (see SpaceMediaSession.m).
  @objc func releaseSession() {
    guard playbackState != "none" || !targets.isEmpty || keepAlive != nil else { return }
    playbackState = "none"
    unbindCommands()
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    keepAlive?.stop()
    keepAlive = nil
    artworkUri = nil
    artwork = nil
    NSLog("[SpaceMediaSession] session.release")
  }

  // MARK: remote commands

  private func bindCommands(_ actions: Set<String>) {
    unbindCommands()
    let center = MPRemoteCommandCenter.shared()
    bind(center.playCommand, enabled: actions.contains("play")) { [weak self] _ in self?.emit("play") }
    bind(center.pauseCommand, enabled: actions.contains("pause")) { [weak self] _ in self?.emit("pause") }
    bind(center.togglePlayPauseCommand, enabled: actions.contains("play") || actions.contains("pause")) { [weak self] _ in
      guard let self else { return .commandFailed }
      return self.emit(self.playbackState == "playing" ? "pause" : "play")
    }
    bind(center.stopCommand, enabled: actions.contains("stop")) { [weak self] _ in self?.emit("stop") }
    bind(center.nextTrackCommand, enabled: actions.contains("nexttrack")) { [weak self] _ in self?.emit("nexttrack") }
    bind(center.previousTrackCommand, enabled: actions.contains("previoustrack")) { [weak self] _ in
      self?.emit("previoustrack")
    }
    bind(center.changePlaybackPositionCommand, enabled: actions.contains("seekto")) { [weak self] event in
      guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
      return self?.emit("seekto", ["seekTimeMs": event.positionTime * 1000])
    }
    center.skipBackwardCommand.preferredIntervals = [NSNumber(value: Self.seekStepS)]
    center.skipForwardCommand.preferredIntervals = [NSNumber(value: Self.seekStepS)]
    bind(center.skipBackwardCommand, enabled: actions.contains("seekbackward")) { [weak self] event in
      let interval = (event as? MPSkipIntervalCommandEvent)?.interval ?? Self.seekStepS
      return self?.emit("seekbackward", ["seekOffsetMs": interval * 1000])
    }
    bind(center.skipForwardCommand, enabled: actions.contains("seekforward")) { [weak self] event in
      let interval = (event as? MPSkipIntervalCommandEvent)?.interval ?? Self.seekStepS
      return self?.emit("seekforward", ["seekOffsetMs": interval * 1000])
    }
  }

  private func bind(
    _ command: MPRemoteCommand,
    enabled: Bool,
    handler: @escaping (MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus?
  ) {
    command.isEnabled = enabled
    guard enabled else { return }
    let target = command.addTarget { event in handler(event) ?? .commandFailed }
    targets.append((command, target))
  }

  private func unbindCommands() {
    for (command, target) in targets {
      command.removeTarget(target)
      command.isEnabled = false
    }
    targets.removeAll()
  }

  private func emit(_ action: String, _ extra: [String: Any] = [:]) -> MPRemoteCommandHandlerStatus {
    NSLog("[SpaceMediaSession] command action=%@ listeners=%d", action, hasListeners ? 1 : 0)
    guard hasListeners else { return .noActionableNowPlayingItem }
    var body = extra
    body["action"] = action
    sendEvent(withName: Self.actionEvent, body: body)
    return .success
  }

  // MARK: artwork

  /// Only local files (the decrypted cover JS wrote): Now Playing never fetches a remote URL.
  private func loadArtwork(_ uri: String?) -> MPMediaItemArtwork? {
    guard let uri, !uri.isEmpty else {
      artworkUri = nil
      artwork = nil
      return nil
    }
    if uri == artworkUri { return artwork }
    artworkUri = uri
    artwork = nil
    let path = URL(string: uri).flatMap { $0.isFileURL ? $0.path : nil } ?? (uri.hasPrefix("/") ? uri : nil)
    guard let path, let image = UIImage(contentsOfFile: path) else {
      NSLog("[SpaceMediaSession] artwork.unreadable uri=%@", uri)
      return nil
    }
    artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
    return artwork
  }

  // MARK: silent keep-alive

  private func setKeepAlive(playing: Bool) {
    guard playing else {
      keepAlive?.pause()
      return
    }
    let session = AVAudioSession.sharedInstance()
    do {
      // Keep whatever mode mpv chose (`.moviePlayback`); only a non-playback category would hide Now Playing.
      if session.category != .playback { try session.setCategory(.playback, mode: .default) }
      try session.setActive(true)
    } catch {
      NSLog("[SpaceMediaSession] audio_session error=%@", error.localizedDescription)
    }
    if keepAlive == nil {
      do {
        let player = try AVAudioPlayer(data: Self.silentWav())
        player.numberOfLoops = -1
        player.prepareToPlay()
        keepAlive = player
      } catch {
        NSLog("[SpaceMediaSession] keep_alive error=%@", error.localizedDescription)
        return
      }
    }
    if keepAlive?.isPlaying == false { keepAlive?.play() }
  }

  /// One second of 8-bit unsigned mono PCM silence (0x80), looped.
  private static func silentWav(sampleRate: UInt32 = 8000) -> Data {
    var data = Data()
    func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
    func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
    let samples = sampleRate
    data.append(contentsOf: Array("RIFF".utf8)); u32(36 + samples)
    data.append(contentsOf: Array("WAVE".utf8))
    data.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(sampleRate); u32(sampleRate); u16(1); u16(8)
    data.append(contentsOf: Array("data".utf8)); u32(samples)
    data.append(Data(repeating: 0x80, count: Int(samples)))
    return data
  }
}
