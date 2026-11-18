import AVFoundation
import MediaPlayer
import React
import UIKit

/// The device media volume as 0..1, shared by both phone apps (PAR-PLAY-05). Badger's player gestures read and set it;
/// `mediaVolumeChanged` fires when the hardware buttons or Control Center move it.
@objc(MediaVolume)
final class MediaVolume: RCTEventEmitter {
  typealias Resolve = RCTPromiseResolveBlock
  typealias Reject = RCTPromiseRejectBlock

  private var observation: NSKeyValueObservation?

  override static func requiresMainQueueSetup() -> Bool { false }
  override func supportedEvents() -> [String]! { ["mediaVolumeChanged"] }

  override func startObserving() {
    // outputVolume is KVO-observable; it reports changes only while the app's audio session is active (during playback).
    observation = AVAudioSession.sharedInstance().observe(\.outputVolume, options: [.new]) { [weak self] _, change in
      guard let value = change.newValue else { return }
      self?.sendEvent(withName: "mediaVolumeChanged", body: Double(value))
    }
  }

  override func stopObserving() {
    observation?.invalidate()
    observation = nil
  }

  #if os(iOS)
  private static var volumeView: MPVolumeView?

  private static func keyWindow() -> UIWindow? {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap { $0.windows }
      .first { $0.isKeyWindow }
  }
  #endif

  @objc(getMediaVolume:reject:)
  func getMediaVolume(_ resolve: @escaping Resolve, reject: @escaping Reject) {
    resolve(Double(AVAudioSession.sharedInstance().outputVolume))
  }

  /// iOS has no public volume setter: the only sanctioned route is the slider inside an (off-screen) `MPVolumeView`.
  /// tvOS has no `MPVolumeView` and no app-settable volume at all (the remote drives the TV / receiver): it rejects.
  @objc(setMediaVolume:resolve:reject:)
  func setMediaVolume(_ level: Double, resolve: @escaping Resolve, reject: @escaping Reject) {
    #if os(iOS)
    let clamped = min(1, max(0, level))
    DispatchQueue.main.async {
      if Self.volumeView == nil, let window = Self.keyWindow() {
        let v = MPVolumeView(frame: CGRect(x: -2000, y: -2000, width: 10, height: 10))
        v.alpha = 0.01
        window.addSubview(v)
        Self.volumeView = v
      }
      guard let slider = Self.volumeView?.subviews.compactMap({ $0 as? UISlider }).first else {
        reject("volume_denied", "volume control unavailable", nil)
        return
      }
      // The slider only takes effect once it has been laid out.
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
        slider.setValue(Float(clamped), animated: false)
        slider.sendActions(for: .valueChanged)
        resolve(clamped)
      }
    }
    #else
    reject("volume_denied", "tvOS apps cannot set the output volume", nil)
    #endif
  }
}
