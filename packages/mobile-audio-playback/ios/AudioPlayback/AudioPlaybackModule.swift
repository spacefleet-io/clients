import AVKit
import React
import UIKit

/// `NativeModules.AudioPlayback` on the iPhone: the JS face of `AudioPlayer`, method for method the Android
/// `AudioPlaybackModule.kt`. Every call runs on the main thread and resolves the `AudioPlaybackState` after it; every
/// change reaches JS as the `AudioPlaybackState` event, which `DeviceEventEmitter.addListener` hears: the emitter
/// sends with observation disabled, since JS listens through `DeviceEventEmitter` and never calls `addListener` here.
@objc(AudioPlayback)
final class AudioPlaybackModule: RCTEventEmitter {
  static let stateEvent = "AudioPlaybackState"

  #if os(iOS)
  /// The AirPlay picker `showOutputSwitcher` opens, kept (invisible) in the key window.
  private static var routePicker: AVRoutePickerView?
  #endif

  override init() {
    super.init(disabledObservation: ())
    let player = AudioPlayer.shared
    DispatchQueue.main.async { [weak self] in
      player.onState = { state in self?.sendEvent(withName: Self.stateEvent, body: state) }
    }
    AudioLog.info("audio.module.init silent=\(AudioPlayer.silent)")
  }

  override class func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! { [Self.stateEvent] }

  override func invalidate() {
    // The music keeps playing (as Android's service does); only this module stops hearing it.
    DispatchQueue.main.async { AudioPlayer.shared.onState = nil }
    super.invalidate()
  }

  private func onMain(_ resolve: @escaping RCTPromiseResolveBlock, _ block: @escaping (AudioPlayer) -> Any?) {
    DispatchQueue.main.async {
      let result = block(AudioPlayer.shared)
      resolve(result)
    }
  }

  private func stateAfter(_ resolve: @escaping RCTPromiseResolveBlock, _ block: @escaping (AudioPlayer) -> Void) {
    onMain(resolve) { player in
      block(player)
      return player.snapshot()
    }
  }

  private static func parseItems(_ json: String) throws -> [[String: Any]] {
    guard let items = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [[String: Any]] else {
      throw NSError(domain: "AudioPlayback", code: 1, userInfo: [NSLocalizedDescriptionKey: "items must be an array"])
    }
    return items
  }

  /// `itemsJson`: `[{id, url, mimeType?, title, artist?, album?, artworkUri?, gainDb?, key?}]`.
  @objc(setQueue:startIndex:startPositionMs:resolve:reject:)
  func setQueue(
    _ itemsJson: String, startIndex: Double, startPositionMs: Double, resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      let items = try Self.parseItems(itemsJson)
      stateAfter(resolve) { $0.setQueue(items, start: Int(startIndex), positionMs: startPositionMs) }
    } catch {
      AudioLog.error("audio.call_failed method=setQueue \(AudioPlayer.describe(error))")
      reject("audio_playback_failed", error.localizedDescription, error)
    }
  }

  @objc(addItems:where:resolve:reject:)
  func addItems(
    _ itemsJson: String, where position: String, resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      let items = try Self.parseItems(itemsJson)
      stateAfter(resolve) { $0.addItems(items, where: position) }
    } catch {
      AudioLog.error("audio.call_failed method=addItems \(AudioPlayer.describe(error))")
      reject("audio_playback_failed", error.localizedDescription, error)
    }
  }

  @objc(play:reject:)
  func play(_ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    stateAfter(resolve) { $0.play() }
  }

  @objc(pause:reject:)
  func pause(_ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    stateAfter(resolve) { $0.pause() }
  }

  @objc(next:reject:)
  func next(_ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    stateAfter(resolve) { $0.next() }
  }

  /// Restarts the track past its first 3 seconds, else goes to the previous one (the system's rule).
  @objc(previous:reject:)
  func previous(_ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    stateAfter(resolve) { $0.previous() }
  }

  @objc(seekTo:resolve:reject:)
  func seekTo(_ positionMs: Double, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    stateAfter(resolve) { $0.seek(to: positionMs) }
  }

  @objc(getState:reject:)
  func getState(_ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    stateAfter(resolve) { _ in }
  }

  @objc(getUpNext:reject:)
  func getUpNext(_ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    onMain(resolve) { $0.upNext() }
  }

  /// Clears the queue and gives the sound back (sign out).
  @objc(stop:reject:)
  func stop(_ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    stateAfter(resolve) { $0.stop() }
  }

  @objc(setShuffle:resolve:reject:)
  func setShuffle(_ enabled: Bool, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    stateAfter(resolve) { $0.setShuffle(enabled) }
  }

  /// Changes songs' even-volume gains, the playing song's included (from its next samples); `gainsJson`: `{id: dB}`.
  @objc(setGains:resolve:reject:)
  func setGains(_ gainsJson: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    guard let object = (try? JSONSerialization.jsonObject(with: Data(gainsJson.utf8))) as? [String: Any] else {
      AudioLog.error("audio.call_failed method=setGains reason=not_an_object")
      reject("audio_playback_failed", "gains must be an object", nil)
      return
    }
    var gains: [String: Float] = [:]
    for (id, value) in object {
      if let number = value as? NSNumber { gains[id] = number.floatValue }
    }
    EvenVolume.shared.setGainsDb(gains)
    AudioLog.info("audio.gains.set n=\(gains.count)")
    resolve(nil)
  }

  /// Turns the limiter of Even out volume at Loud on or off, from the next samples.
  @objc(setLimiting:resolve:reject:)
  func setLimiting(_ on: Bool, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    EvenVolume.shared.limiting = on
    AudioLog.info("audio.limiting.set on=\(on)")
    resolve(nil)
  }

  @objc(setRepeatMode:resolve:reject:)
  func setRepeatMode(_ mode: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    stateAfter(resolve) { $0.setRepeatMode(mode) }
  }

  /// The iPhone always has the system's AirPlay picker (speaker, AirPlay and Bluetooth devices). tvOS has no
  /// `AVRoutePickerView`: the Apple TV picks its audio output in its own Settings (PAR-TV-11).
  @objc(canShowOutputSwitcher:reject:)
  func canShowOutputSwitcher(_ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    #if os(iOS)
    resolve(true)
    #else
    resolve(false)
    #endif
  }

  /// Opens the system's AirPlay picker, as a tap on an `AVRoutePickerView` does (the view sits invisible in the key
  /// window, and its button is pressed for the user). Resolves false when no window or button was found.
  @objc(showOutputSwitcher:reject:)
  func showOutputSwitcher(_ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    #if os(tvOS)
    AudioLog.info("audio.output_switcher shown=false reason=tvos")
    resolve(false)
    #else
    DispatchQueue.main.async {
      let window = UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .flatMap { $0.windows }
        .first { $0.isKeyWindow }
      guard let window else {
        AudioLog.warn("audio.output_switcher shown=false reason=no_key_window")
        resolve(false)
        return
      }
      let picker = Self.routePicker ?? AVRoutePickerView(frame: CGRect(x: -100, y: -100, width: 1, height: 1))
      picker.prioritizesVideoDevices = false
      picker.alpha = 0.01
      picker.isUserInteractionEnabled = false
      Self.routePicker = picker
      if picker.superview !== window { window.addSubview(picker) }
      guard let button = Self.firstButton(in: picker) else {
        AudioLog.warn("audio.output_switcher shown=false reason=no_button")
        resolve(false)
        return
      }
      button.sendActions(for: .touchUpInside)
      let outputs = AVAudioSession.sharedInstance().currentRoute.outputs.map { $0.portType.rawValue }
      AudioLog.info("audio.output_switcher shown=true outputs=\(outputs)")
      resolve(true)
    }
    #endif
  }

  /// What JS last asked for. The idle timer is put back each time the app becomes active while it is still wanted, so a
  /// trip through the background never leaves the screen free to sleep under Now playing (Badger's `MpvControl` does the
  /// same for films). In the background the system ignores it: the TV's screensaver starts as usual.
  private static var keepScreenOnWanted = false
  private static var keepScreenOnObserver: NSObjectProtocol?

  /// Keeps the screen awake (no screensaver, no sleep) while `enabled`: Parrot TV's Now playing and lyrics (PAR-TV-12).
  @objc(setKeepScreenOn:resolve:reject:)
  func setKeepScreenOn(_ enabled: Bool, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      let previous = UIApplication.shared.isIdleTimerDisabled
      Self.keepScreenOnWanted = enabled
      UIApplication.shared.isIdleTimerDisabled = enabled
      AudioLog.info("audio.keep_awake enabled=\(enabled) previous=\(previous)")
      if Self.keepScreenOnObserver == nil {
        Self.keepScreenOnObserver = NotificationCenter.default.addObserver(
          forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { _ in
          if Self.keepScreenOnWanted && !UIApplication.shared.isIdleTimerDisabled {
            AudioLog.info("audio.keep_awake restored=true")
            UIApplication.shared.isIdleTimerDisabled = true
          }
        }
      }
      resolve(true)
    }
  }

  private static func firstButton(in view: UIView) -> UIButton? {
    for subview in view.subviews {
      if let button = subview as? UIButton { return button }
      if let button = firstButton(in: subview) { return button }
    }
    return nil
  }
}
