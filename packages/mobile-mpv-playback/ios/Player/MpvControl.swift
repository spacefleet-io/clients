import AVFoundation
import MediaProxy
import React
import UIKit

#if os(iOS)
/// The orientations the app allows right now, read by the app delegate's `supportedInterfaceOrientationsFor`: the app is
/// portrait-only and the player landscape-only (UX-ORIENT-01). Info.plist lists landscape too, only so the player can get it.
/// Only touched on the main queue. iOS only: tvOS has no interface orientations (always landscape).
public enum AppOrientation {
  public fileprivate(set) static var mask: UIInterfaceOrientationMask = .portrait
  /// Player screens holding the landscape mask (a next-episode swap mounts the new player before the old one unmounts).
  fileprivate static var playerScreens = 0
}
#endif

/// JS `MpvControl` on the embedded libmpv core (`MpvEngine.current`). Mirrors the Android `MpvControlModule` method for
/// method: same mpv commands and properties, same defaults, same "reject `mpv_error`" on a failed call or no live core.
/// mpv calls run on this module's own serial queue (a sync `sub-add` may fetch a whole PGS file); UIKit calls hop to main.
@objc(MpvControl)
final class MpvControl: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { true }
  @objc let methodQueue = DispatchQueue(label: "com.spacefleet.mpv.control", qos: .userInitiated)

  typealias Resolve = RCTPromiseResolveBlock
  typealias Reject = RCTPromiseRejectBlock

  /// Runs `body` against the live core; a throw (failed mpv call, no player mounted) rejects like Android's `mpv_error`.
  private func run(_ resolve: Resolve, _ reject: Reject, _ body: (MpvEngine) throws -> Any) {
    do {
      guard let engine = MpvEngine.current else { throw MpvError(description: "mpv core is not live") }
      resolve(try body(engine))
    } catch {
      PlaybackLog.warn("control.failed error=\(error)")
      reject("mpv_error", "\(error)", nil)
    }
  }

  /// `-1` disables the track (`no`), any other value is the mpv track id.
  private func setTrack(_ name: String, _ id: Int, _ resolve: Resolve, _ reject: Reject) {
    run(resolve, reject) { engine in
      engine.mark(name)
      if id < 0 { try engine.setString(name, "no") } else { try engine.setInt(name, Int64(id)) }
      PlaybackLog.info("track.select \(name)=\(id)")
      return true
    }
  }

  // MARK: transport

  @objc(togglePause:reject:)
  func togglePause(_ resolve: @escaping Resolve, reject: @escaping Reject) {
    run(resolve, reject) { try $0.command(["cycle", "pause"]); return true }
  }

  @objc(setPaused:resolve:reject:)
  func setPaused(_ paused: Bool, resolve: @escaping Resolve, reject: @escaping Reject) {
    run(resolve, reject) { try $0.setFlag("pause", paused); return true }
  }

  @objc(seek:mode:resolve:reject:)
  func seek(_ seconds: Double, mode: String?, resolve: @escaping Resolve, reject: @escaping Reject) {
    let resolved = (mode?.isEmpty == false ? mode : nil) ?? "absolute+exact"
    run(resolve, reject) { engine in
      engine.mark("seek")
      try engine.command(["seek", String(seconds), resolved])
      return true
    }
  }

  @objc(seekRelative:mode:resolve:reject:)
  func seekRelative(_ seconds: Double, mode: String?, resolve: @escaping Resolve, reject: @escaping Reject) {
    let resolved = (mode?.isEmpty == false ? mode : nil) ?? "relative+exact"
    run(resolve, reject) { engine in
      engine.mark("seek")
      try engine.command(["seek", String(seconds), resolved])
      return true
    }
  }

  @objc(seekToTime:seconds:resolve:reject:)
  func seekToTime(_ url: String, seconds: Double, resolve: @escaping Resolve, reject: @escaping Reject) {
    run(resolve, reject) { try $0.load(url: url, options: "start=\(seconds)"); return true }
  }

  @objc(loadFromUrl:resolve:reject:)
  func loadFromUrl(_ url: String, resolve: @escaping Resolve, reject: @escaping Reject) {
    run(resolve, reject) { try $0.load(url: url, options: nil); return true }
  }

  @objc(loadAt:startSeconds:options:resolve:reject:)
  func loadAt(_ url: String, startSeconds: Double, options: String?, resolve: @escaping Resolve, reject: @escaping Reject) {
    let opts = ["start=\(startSeconds)", options ?? ""].filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    run(resolve, reject) { try $0.load(url: url, options: opts.joined(separator: ",")); return true }
  }

  // MARK: state

  @objc(getPlaybackState:reject:)
  func getPlaybackState(_ resolve: @escaping Resolve, reject: @escaping Reject) {
    let e = MpvEngine.current
    resolve([
      "position": e?.double("time-pos") ?? 0,
      "duration": e?.double("duration") ?? 0,
      "paused": e?.flag("pause") ?? false,
      "cacheEnd": e?.double("demuxer-cache-time") ?? 0,
    ])
  }

  @objc(getPlaybackSnapshot:reject:)
  func getPlaybackSnapshot(_ resolve: @escaping Resolve, reject: @escaping Reject) {
    let e = MpvEngine.current
    let d = { (name: String) in e?.double(name) ?? 0 }
    let b = { (name: String) in e?.flag(name) ?? false }
    let i = { (name: String) in Int(e?.int(name) ?? 0) }
    let s = { (name: String) in e?.string(name) ?? "" }
    let id = { (name: String) in Int(e?.int(name) ?? -1) }
    resolve([
      "sampledAtMs": ProcessInfo.processInfo.systemUptime * 1000,
      "position": d("time-pos"),
      "duration": d("duration"),
      "paused": b("pause"),
      "cacheEnd": d("demuxer-cache-time"),
      "cacheDuration": d("demuxer-cache-duration"),
      "cacheSpeed": d("cache-speed"),
      "eof": b("eof-reached"),
      "pausedForCache": b("paused-for-cache"),
      "seeking": b("seeking"),
      "idle": b("idle-active"),
      "coreIdle": b("core-idle"),
      "voConfigured": b("vo-configured"),
      "hwdec": s("hwdec-current"),
      "videoCodec": s("video-format"),
      "frameDrops": Double(i("frame-drop-count")),
      "decoderFrameDrops": Double(i("decoder-frame-drop-count")),
      "vid": id("vid"),
      "aid": id("aid"),
      "sid": id("sid"),
      "videoWidth": i("video-params/w"),
      "videoHeight": i("video-params/h"),
      "avsync": d("avsync"),
      "currentVo": s("current-vo"),
      "netBps": NetworkMeter.shared.bitsPerSecond(),
      "cacheSecs": d("cache-secs"),
      "demuxerMaxBytes": d("demuxer-max-bytes"),
    ])
  }

  @objc(getTimePos:reject:)
  func getTimePos(_ resolve: @escaping Resolve, reject: @escaping Reject) {
    resolve(MpvEngine.current?.double("time-pos") ?? -1)
  }

  /// mpv `sub-pos` (where the bottom subtitle line ends, % of the picture height; 100 when mpv isn't live).
  @objc(getSubPos:reject:)
  func getSubPos(_ resolve: @escaping Resolve, reject: @escaping Reject) {
    resolve(MpvEngine.current?.double("sub-pos") ?? 100)
  }

  /// Sets mpv `sub-pos`: subtitles move up above the TV controls while they show (MPV-OSC-02).
  @objc(setSubPos:resolve:reject:)
  func setSubPos(_ value: Double, resolve: @escaping Resolve, reject: @escaping Reject) {
    run(resolve, reject) { try $0.setDouble("sub-pos", value); return true }
  }

  // MARK: tracks

  /// `track-list` in the Android shape (`demux-w` → `demuxW`, …). Image subtitles (PGS `hdmv_pgs_subtitle`, VobSub
  /// `dvd_subtitle`) and ASS are ordinary `sub` tracks: libmpv renders all of them.
  @objc(getTrackList:reject:)
  func getTrackList(_ resolve: @escaping Resolve, reject: @escaping Reject) {
    run(resolve, reject) { engine in
      let tracks = (engine.node("track-list") as? [[String: Any]]) ?? []
      return tracks.map { t -> [String: Any] in
        [
          "id": (t["id"] as? Int64).map(Int.init) ?? -1,
          "type": t["type"] as? String ?? "",
          "selected": t["selected"] as? Bool ?? false,
          "lang": t["lang"] as? String ?? NSNull(),
          "title": t["title"] as? String ?? NSNull(),
          "codec": t["codec"] as? String ?? NSNull(),
          "demuxW": (t["demux-w"] as? Int64).map(Int.init) ?? 0,
          "demuxH": (t["demux-h"] as? Int64).map(Int.init) ?? 0,
          "hlsBitrate": (t["hls-bitrate"] as? Int64).map(Double.init) ?? (t["hls-bitrate"] as? Double) ?? 0,
          "external": t["external"] as? Bool ?? false,
        ]
      }
    }
  }

  @objc(setAudioTrack:resolve:reject:)
  func setAudioTrack(_ id: Int, resolve: @escaping Resolve, reject: @escaping Reject) { setTrack("aid", id, resolve, reject) }

  @objc(setSubtitleTrack:resolve:reject:)
  func setSubtitleTrack(_ id: Int, resolve: @escaping Resolve, reject: @escaping Reject) { setTrack("sid", id, resolve, reject) }

  @objc(setSecondarySubtitleTrack:resolve:reject:)
  func setSecondarySubtitleTrack(_ id: Int, resolve: @escaping Resolve, reject: @escaping Reject) {
    setTrack("secondary-sid", id, resolve, reject)
  }

  @objc(setVideoTrack:resolve:reject:)
  func setVideoTrack(_ id: Int, resolve: @escaping Resolve, reject: @escaping Reject) { setTrack("vid", id, resolve, reject) }

  @objc(setSubDelay:resolve:reject:)
  func setSubDelay(_ seconds: Double, resolve: @escaping Resolve, reject: @escaping Reject) {
    run(resolve, reject) { try $0.setDouble("sub-delay", seconds); return true }
  }

  /// `sub-add <url> select [title [lang]]`, synchronous: resolves once mpv has loaded the file (a PGS `.sup`, a VobSub
  /// `.mkv`, WebVTT, ASS — whatever libavcodec decodes). A load that fails (mpv returns an error, or the track list does
  /// not grow) rejects `subtitle_load_failed`, like Android, so JS can say so and put the previous subtitle back
  /// (PLAY-TRACK-06). No live core still rejects `mpv_error`.
  @objc(addSubtitle:language:title:resolve:reject:)
  func addSubtitle(_ url: String, language: String?, title: String?, resolve: @escaping Resolve, reject: @escaping Reject) {
    var args = ["sub-add", url, "select"]
    let lang = language?.trimmingCharacters(in: .whitespaces) ?? ""
    let label = [title?.trimmingCharacters(in: .whitespaces) ?? "", lang].first { !$0.isEmpty }
    if let label { args.append(label) }
    if !lang.isEmpty { args.append(lang) }
    guard let engine = MpvEngine.current else {
      PlaybackLog.warn("control.failed error=mpv core is not live")
      reject("mpv_error", "mpv core is not live", nil)
      return
    }
    let before = engine.int("track-list/count") ?? 0
    let started = CACurrentMediaTime()
    var failure: String? = nil
    do { try engine.command(args) } catch { failure = "\(error)" }
    let after = engine.int("track-list/count") ?? 0
    let ms = Int((CACurrentMediaTime() - started) * 1000)
    if failure == nil && after <= before { failure = "sub-add did not add a track" }
    if let failure {
      PlaybackLog.warn("subtitle.add_failed ms=\(ms) tracks=\(before)->\(after) lang=\(lang) url=\(url) error=\(failure)")
      reject("subtitle_load_failed", "\(failure): \(url)", nil)
      return
    }
    PlaybackLog.info("subtitle.add ms=\(ms) tracks=\(before)->\(after) lang=\(lang) url=\(url)")
    resolve(true)
  }

  @objc(removeAllSubtitles:reject:)
  func removeAllSubtitles(_ resolve: @escaping Resolve, reject: @escaping Reject) {
    run(resolve, reject) { engine in
      for _ in 0..<8 {
        guard let sid = engine.int("sid"), sid > 0 else { break }
        try engine.command(["sub-remove"])
      }
      try engine.setString("sid", "no")
      return true
    }
  }

  @objc(setHwdec:resolve:reject:)
  func setHwdec(_ value: String, resolve: @escaping Resolve, reject: @escaping Reject) {
    run(resolve, reject) { try $0.setString("hwdec", value); return true }
  }

  /// mpv's software gain (0..100+), as on Android; the device volume is `@space/mobile-media-volume`.
  @objc(setVolume:resolve:reject:)
  func setVolume(_ volume: Double, resolve: @escaping Resolve, reject: @escaping Reject) {
    run(resolve, reject) { try $0.setString("volume", String(Int(volume))); return true }
  }

  // MARK: device and host

  /// Raw decoder facts; `getDecoderCaps` is composed from them in JS (`src/iosDecoderCaps.ts`, PLAY-QUAL-06).
  @objc(getDeviceDecoderReport:reject:)
  func getDeviceDecoderReport(_ resolve: @escaping Resolve, reject: @escaping Reject) {
    resolve(DecoderCaps.report())
  }

  /// Audio route facts for the JS TV audio planner (`src/tvAudioOutput.ts`, MPV-TV-03).
  @objc(getAudioOutputReport:reject:)
  func getAudioOutputReport(_ resolve: @escaping Resolve, reject: @escaping Reject) {
    let session = AVAudioSession.sharedInstance()
    #if os(tvOS)
    let platform = "tvos"
    #else
    let platform = "ios"
    #endif
    resolve([
      "platform": platform,
      "maxOutputChannels": session.maximumOutputNumberOfChannels,
      "outputPorts": session.currentRoute.outputs.map { $0.portType.rawValue },
    ])
  }

  /// Applies the JS TV audio plan: asks the session for [preferredOutputChannels] (mpv's `audiounit` then opens up to
  /// that many) and sets `audio-spdif` / `audio-channels` on the live core when there is one, else the next core starts
  /// with them (`MpvEngine.audioPlan`). Logs the chosen path once.
  @objc(setAudioOutput:channels:preferredOutputChannels:reason:resolve:reject:)
  func setAudioOutput(
    _ spdif: String, channels: String, preferredOutputChannels: Int, reason: String,
    resolve: @escaping Resolve, reject: @escaping Reject
  ) {
    let session = AVAudioSession.sharedInstance()
    if preferredOutputChannels > 0 {
      do {
        try session.setPreferredOutputNumberOfChannels(preferredOutputChannels)
      } catch {
        PlaybackLog.warn("playback.audio preferred-channels=\(preferredOutputChannels) error=\(error.localizedDescription)")
      }
    }
    MpvEngine.audioPlan = (spdif, channels)
    var applied = false
    if let engine = MpvEngine.current {
      do {
        try engine.setString("audio-spdif", spdif)
        try engine.setString("audio-channels", channels)
        applied = true
      } catch {
        PlaybackLog.warn("playback.audio apply error=\(error)")
      }
    }
    PlaybackLog.info(
      "playback.audio ao=audiounit passthrough=\(spdif.isEmpty ? "none" : spdif) pcm-channels=\(channels) "
        + "session-channels=\(session.outputNumberOfChannels) applied=\(applied ? "live" : "next-core") \(reason)")
    resolve(true)
  }

  /// What the player last asked for. The idle timer is put back each time the app becomes active while a player still
  /// wants it, so a trip through the background never leaves the device free to sleep mid-film (PLAY-AWAKE-01).
  private static var keepScreenOnWanted = false
  private static var keepScreenOnObserver: NSObjectProtocol?

  @objc(setKeepScreenOn:resolve:reject:)
  func setKeepScreenOn(_ enabled: Bool, resolve: @escaping Resolve, reject: @escaping Reject) {
    DispatchQueue.main.async {
      let previous = UIApplication.shared.isIdleTimerDisabled
      Self.keepScreenOnWanted = enabled
      UIApplication.shared.isIdleTimerDisabled = enabled
      PlaybackLog.info("keepAwake.set enabled=\(enabled) previous=\(previous)")
      if Self.keepScreenOnObserver == nil {
        Self.keepScreenOnObserver = NotificationCenter.default.addObserver(
          forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { _ in
          let current = UIApplication.shared.isIdleTimerDisabled
          PlaybackLog.info("keepAwake.active wanted=\(Self.keepScreenOnWanted) current=\(current)")
          if Self.keepScreenOnWanted && !current { UIApplication.shared.isIdleTimerDisabled = true }
        }
      }
      resolve(true)
    }
  }

  #if os(iOS)
  private static var savedBrightness: CGFloat?
  #endif

  /// iOS: the screen brightness. tvOS: the TV owns its brightness (no `UIScreen.brightness`): rejects.
  @objc(getScreenBrightness:reject:)
  func getScreenBrightness(_ resolve: @escaping Resolve, reject: @escaping Reject) {
    #if os(iOS)
    DispatchQueue.main.async { resolve(Double(UIScreen.main.brightness)) }
    #else
    reject("brightness_unavailable", "tvOS has no screen brightness", nil)
    #endif
  }

  /// A negative level restores the brightness the user had before the first override. tvOS: rejects (see above).
  @objc(setScreenBrightness:resolve:reject:)
  func setScreenBrightness(_ level: Double, resolve: @escaping Resolve, reject: @escaping Reject) {
    #if os(iOS)
    DispatchQueue.main.async {
      if level < 0 {
        if let saved = Self.savedBrightness { UIScreen.main.brightness = saved }
        Self.savedBrightness = nil
      } else {
        if Self.savedBrightness == nil { Self.savedBrightness = UIScreen.main.brightness }
        UIScreen.main.brightness = CGFloat(min(1, max(0.02, level)))
      }
      resolve(true)
    }
    #else
    reject("brightness_unavailable", "tvOS has no screen brightness", nil)
    #endif
  }

  /// iOS: landscape + hidden status bar while a player is mounted. tvOS: always landscape, no status bar: nothing to do.
  @objc(setImmersiveLandscape:resolve:reject:)
  func setImmersiveLandscape(_ enabled: Bool, resolve: @escaping Resolve, reject: @escaping Reject) {
    #if os(iOS)
    DispatchQueue.main.async {
      AppOrientation.playerScreens = enabled ? AppOrientation.playerScreens + 1 : max(0, AppOrientation.playerScreens - 1)
      PlaybackLog.info("orientation.lock enabled=\(enabled) screens=\(AppOrientation.playerScreens)")
      // The surviving player of a next-episode swap keeps landscape and the hidden status bar.
      if !enabled && AppOrientation.playerScreens > 0 {
        resolve(true)
        return
      }
      let mask: UIInterfaceOrientationMask = enabled ? .landscape : .portrait
      // Set before asking for the rotation: UIKit checks the request against what the app delegate allows.
      AppOrientation.mask = mask
      UIApplication.shared.setStatusBarHidden(enabled, with: .fade)
      if #available(iOS 16.0, *) {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        scene?.windows.first?.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
        scene?.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { error in
          PlaybackLog.warn("immersive.geometry_update_failed \(error.localizedDescription)")
        }
      } else {
        let orientation: UIInterfaceOrientation = enabled ? .landscapeRight : .portrait
        UIDevice.current.setValue(orientation.rawValue, forKey: "orientation")
        UIViewController.attemptRotationToDeviceOrientation()
      }
      resolve(true)
    }
    #else
    resolve(true)
    #endif
  }
}
