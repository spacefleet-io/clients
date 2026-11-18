#if os(iOS)
import AVFoundation
import Foundation
import MediaProxy
import React

/// AirPlay for the iPhone (UX-TV-03, MPV-MODEL-02). `AVPlayer` is used ONLY to hand the HLS stream of the cast server to the
/// AirPlay device (`allowsExternalPlayback`); the phone never plays it:
///  - `load` refuses unless an AirPlay route is already active (the user picked one with `AVRoutePickerView`),
///  - no `AVPlayerLayer` exists, so there is nothing to render on the phone,
///  - the player stays muted and paused until the item is ready, and playback is stopped when the external playback is not
///    active a few seconds after `play`, or when the route is left (`airplay_route_lost`).
/// Everything runs on the main queue (AVFoundation + KVO).
@objc(AirPlayPlayer)
final class AirPlayPlayer: NSObject {
  private static let externalDeadlineSeconds = 8.0

  private var player: AVPlayer?
  private var item: AVPlayerItem?
  private var observations: [NSKeyValueObservation] = []
  private var tokens: [NSObjectProtocol] = []
  private var status = "idle"
  private var error: String?
  private var externalDeadline: DispatchWorkItem?

  @objc static func requiresMainQueueSetup() -> Bool { true }
  @objc var methodQueue: DispatchQueue { .main }

  // MARK: route

  private static func routeInfo() -> [String: Any] {
    let out = AVAudioSession.sharedInstance().currentRoute.outputs.first { $0.portType == .airPlay }
    return ["active": out != nil, "name": out?.portName ?? NSNull()]
  }

  @objc(getRoute:reject:)
  func getRoute(_ resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    resolve(Self.routeInfo())
  }

  // MARK: load / controls

  @objc(load:startSeconds:resolve:reject:)
  func load(
    _ urlString: String, startSeconds: Double, resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    teardown()
    guard let url = URL(string: urlString) else { return reject("airplay_bad_url", "invalid stream url", nil) }
    do {
      // `.longFormVideo` is what lets the route picker offer AirPlay video devices for an app with no visible player.
      try AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback, policy: .longFormVideo, options: [])
      try AVAudioSession.sharedInstance().setActive(true)
    } catch {
      return reject("airplay_session_error", error.localizedDescription, error)
    }
    // MPV-MODEL-02: the phone never plays. No route, no player.
    guard (Self.routeInfo()["active"] as? Bool) == true else {
      return reject("airplay_no_route", "no AirPlay route is active", nil)
    }

    let item = AVPlayerItem(url: url)
    let player = AVPlayer(playerItem: item)
    player.allowsExternalPlayback = true
    player.usesExternalPlaybackWhileExternalScreenIsActive = true
    player.isMuted = true
    self.item = item
    self.player = player
    status = "loading"
    error = nil

    observations.append(item.observe(\.status, options: [.new]) { [weak self] item, _ in
      guard let self else { return }
      switch item.status {
      case .readyToPlay:
        PlaybackLog.info("airplay.item.ready duration=\(item.duration.seconds)")
        if startSeconds > 0 {
          player.seek(to: CMTime(seconds: startSeconds, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { _ in
            self.startExternalPlayback()
          }
        } else {
          self.startExternalPlayback()
        }
      case .failed:
        self.fail(item.error?.localizedDescription ?? "airplay_item_failed")
      default:
        break
      }
    })
    observations.append(player.observe(\.isExternalPlaybackActive, options: [.new]) { [weak self] player, _ in
      guard let self else { return }
      PlaybackLog.info("airplay.external active=\(player.isExternalPlaybackActive)")
      if player.isExternalPlaybackActive {
        self.externalDeadline?.cancel()
        player.isMuted = false
      } else if self.status == "playing" {
        // The device stopped being the output: do not let the phone carry on.
        self.fail("airplay_route_lost")
      }
    })
    observations.append(player.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
      guard let self, self.error == nil, self.status != "loading", self.status != "ended" else { return }
      self.status = player.timeControlStatus == .paused ? "paused" : "playing"
    })
    tokens.append(
      NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
        self?.status = "ended"
      })
    tokens.append(
      NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) {
        [weak self] _ in
        guard let self, self.player != nil, (Self.routeInfo()["active"] as? Bool) != true else { return }
        self.fail("airplay_route_lost")
      })
    PlaybackLog.info("airplay.load start=\(startSeconds)")
    resolve(true)
  }

  /// Item ready: the first `play()`. The phone is on an AirPlay route and the player is muted; if the external playback does
  /// not become active in time the load is abandoned rather than letting the phone play.
  private func startExternalPlayback() {
    guard let player else { return }
    player.play()
    let deadline = DispatchWorkItem { [weak self] in
      guard let self, let player = self.player, !player.isExternalPlaybackActive else { return }
      self.fail("airplay_not_external")
    }
    externalDeadline = deadline
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.externalDeadlineSeconds, execute: deadline)
  }

  private func fail(_ message: String) {
    PlaybackLog.warn("airplay.fail \(message)")
    player?.pause()
    player?.replaceCurrentItem(with: nil)
    status = "failed"
    error = message
  }

  @objc(play:reject:)
  func play(_ resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    guard let player else { return reject("airplay_not_loaded", "nothing loaded", nil) }
    guard player.isExternalPlaybackActive else { return reject("airplay_not_external", "AirPlay is not the output", nil) }
    player.play()
    resolve(true)
  }

  @objc(pause:reject:)
  func pause(_ resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    player?.pause()
    resolve(true)
  }

  @objc(seek:resolve:reject:)
  func seek(_ seconds: Double, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    guard let player else { return reject("airplay_not_loaded", "nothing loaded", nil) }
    player.seek(to: CMTime(seconds: max(0, seconds), preferredTimescale: 600)) { finished in resolve(finished) }
  }

  @objc(stop:reject:)
  func stop(_ resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    teardown()
    resolve(true)
  }

  @objc(getState:reject:)
  func getState(_ resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    let position = player?.currentTime().seconds ?? 0
    let duration = item?.duration.seconds ?? 0
    resolve([
      "route": Self.routeInfo(),
      "external": player?.isExternalPlaybackActive ?? false,
      "status": status,
      "position": position.isFinite ? position : 0,
      "duration": duration.isFinite ? duration : 0,
      "error": error.map { $0 as Any } ?? NSNull(),
    ])
  }

  /// Index into the stream's legible options; -1 = off.
  @objc(setSubtitleIndex:resolve:reject:)
  func setSubtitleIndex(_ index: Int, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    guard let item, let group = item.asset.mediaSelectionGroup(forMediaCharacteristic: .legible) else {
      return resolve(false)
    }
    if index < 0 {
      item.select(nil, in: group)
    } else if index < group.options.count {
      item.select(group.options[index], in: group)
    } else {
      return reject("airplay_bad_subtitle", "no legible option \(index)", nil)
    }
    resolve(true)
  }

  private func teardown() {
    externalDeadline?.cancel()
    externalDeadline = nil
    observations.forEach { $0.invalidate() }
    observations.removeAll()
    tokens.forEach { NotificationCenter.default.removeObserver($0) }
    tokens.removeAll()
    player?.pause()
    player?.replaceCurrentItem(with: nil)
    player = nil
    item = nil
    status = "idle"
    error = nil
  }

  @objc func invalidate() {
    teardown()
  }
}
#endif
