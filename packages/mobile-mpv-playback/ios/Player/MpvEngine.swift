import AVFoundation
import Foundation
import Libmpv
import MediaProxy
import QuartzCore
import UIKit

/// Reader/writer lock (pthread): mpv calls from the JS queue and the main thread run concurrently (reads), core teardown
/// waits for them and blocks new ones (write). A blocking call (a sync `sub-add` fetching a PGS file) never stalls another.
private final class RWLock {
  private let lock = UnsafeMutablePointer<pthread_rwlock_t>.allocate(capacity: 1)
  init() { pthread_rwlock_init(lock, nil) }
  deinit {
    pthread_rwlock_destroy(lock)
    lock.deallocate()
  }
  func read<T>(_ body: () throws -> T) rethrows -> T {
    pthread_rwlock_rdlock(lock)
    defer { pthread_rwlock_unlock(lock) }
    return try body()
  }
  func write<T>(_ body: () throws -> T) rethrows -> T {
    pthread_rwlock_wrlock(lock)
    defer { pthread_rwlock_unlock(lock) }
    return try body()
  }
}

struct MpvError: Error, CustomStringConvertible {
  let description: String
}

/// One embedded libmpv core drawing into the `CAMetalLayer` of an `MpvPlayerView` (iOS twin of the Android `MpvEngine` +
/// `MpvSurfaceView.initOptions` + `MpvGuard` + `MpvPlaybackReport` + `MpvLogBridge`).
///
/// Video: `vo=gpu-next`, Vulkan through MoltenVK (`gpu-context=moltenvk`, our mpv fork): the layer pointer is the `wid`
/// option and mpv resizes its swapchain from the layer's bounds × contentsScale. The engine keeps the layer alive until
/// the core is destroyed. Decode: VideoToolbox with frames kept on the GPU (`videotoolbox-pl`), software fallback.
///
/// Threads: the client API is thread-safe. JS calls (`MpvControl`, own serial queue) and the view (main) go through
/// `withHandle` (read lock); events are drained on `eventQueue` from mpv's wakeup callback; `destroy` runs on
/// `eventQueue` too, under the write lock, so no call or drain can touch a freed core.
final class MpvEngine {
  private static let registryLock = NSLock()
  private static weak var currentEngine: MpvEngine?

  /// The engine `MpvControl` drives: the most recently created live one (a next-episode swap overlaps two views).
  static var current: MpvEngine? {
    registryLock.lock()
    defer { registryLock.unlock() }
    return currentEngine
  }

  private static var storedAudioPlan: (spdif: String, channels: String)?

  /// The TV audio plan from JS (`MpvControl.setAudioOutput`, MPV-TV-03): a core created after the call starts with it.
  static var audioPlan: (spdif: String, channels: String)? {
    get {
      registryLock.lock()
      defer { registryLock.unlock() }
      return storedAudioPlan
    }
    set {
      registryLock.lock()
      defer { registryLock.unlock() }
      storedAudioPlan = newValue
    }
  }

  private let guardLock = RWLock()
  private var handle: OpaquePointer?
  private let layer: CAMetalLayer
  private let eventQueue = DispatchQueue(label: "com.spacefleet.mpv.events", qos: .userInitiated)
  private var notificationTokens: [NSObjectProtocol] = []

  // Event-queue state (diagnostics: first frame, seek / track-switch latency, decoder report).
  private var loadStartedAt: CFTimeInterval = 0
  private var firstFrameLogged = false
  private var pendingAction: (kind: String, at: CFTimeInterval)?
  private let actionLock = NSLock()
  private var lastGpuReport: String?
  /// Set when an audio session interruption (a call, Siri, an alarm) paused playing video; its end resumes only then,
  /// and any later `pause=false` (the user pressing play) clears it (PLAY-FOCUS-01).
  private var pausedByInterruption = false
  private let interruptionLock = NSLock()
  /// Every core event, on the event queue, before the engine's own handling. Set once right after `init`, before any
  /// load (the media format test set runner counts FILE_LOADED / END_FILE and collects warnings through it).
  var eventTap: ((mpv_event) -> Void)?

  /// SF_SILENT (REL-ENV-36): a test launch (the Apple TV UI tests' launch environment, `apple-host.ts`) sets it, on a device
  /// too, where the Apple TV's sound goes to a real TV. Any value but "0"/"false"/"no" is silent, as in packages/mpv/src/external.ts.
  static func isSilent(_ env: [String: String]) -> Bool {
    guard let raw = env["SF_SILENT"]?.trimmingCharacters(in: .whitespaces).lowercased(), !raw.isEmpty else { return false }
    return !["0", "false", "no"].contains(raw)
  }

  private static let silent: Bool = {
    let silent = isSilent(ProcessInfo.processInfo.environment)
    if silent { PlaybackLog.warn("mpv.silent ao=null mute=yes (SF_SILENT)") }
    return silent
  }()

  /// AudioUnit on a device unless SF_SILENT (then `null`). Simulator builds only: `SB_MPV_AO` (e.g. `null`) replaces it,
  /// because the iOS 15/16 simulator runtimes on macOS 26 abort inside Apple's `AudioUnitInitialize` (REL-MOB-02 runs);
  /// compiled out on device.
  private static let audioOutput: String = {
    if silent { return "null" }
    #if targetEnvironment(simulator)
    if let ao = ProcessInfo.processInfo.environment["SB_MPV_AO"], !ao.isEmpty {
      PlaybackLog.warn("mpv.ao_override ao=\(ao) (simulator only)")
      return ao
    }
    #endif
    return "audiounit"
  }()

  init(layer: CAMetalLayer) {
    self.layer = layer
    _ = MpvProxyHooks.installed
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playback, mode: .moviePlayback)
      try session.setActive(true)
    } catch {
      PlaybackLog.warn("mpv.audio_session error=\(error.localizedDescription)")
    }

    guard let h = mpv_create() else {
      PlaybackLog.error("mpv.create failed")
      return
    }
    let wid = Int64(Int(bitPattern: Unmanaged.passUnretained(layer).toOpaque()))
    let options: [(String, String)] = [
      // Video / audio output (iOS): Vulkan on MoltenVK into the view's CAMetalLayer, AudioUnit.
      ("vo", "gpu-next"),
      ("gpu-api", "vulkan"),
      ("gpu-context", "moltenvk"),
      ("wid", String(wid)),
      ("ao", Self.audioOutput),
      ("mute", Self.silent ? "yes" : "no"),
      // Hardware decoding with software fallback (Android: mediacodec,mediacodec-copy,no). All codecs.
      ("hwdec", "videotoolbox,videotoolbox-copy,no"),
      ("hwdec-codecs", "all"),
      // OSD off: React Native owns the UI (no OSC / ytdl options: the mobile build has no Lua).
      ("osd-bar", "no"),
      ("osd-level", "0"),
      ("keep-open", "yes"),
      ("input-default-bindings", "yes"),
      // Demuxer / network tuning for HLS over the loopback proxy (same values and reasons as Android).
      ("demuxer-max-bytes", "32MiB"),
      ("demuxer-max-back-bytes", "32MiB"),
      ("demuxer-readahead-secs", "10"),
      ("network-timeout", "30"),
      ("demuxer-lavf-o", "seg_max_retry=2"),
      ("cache-secs", "30"),
      ("hr-seek", "yes"),
      ("hr-seek-framedrop", "yes"),
      ("cache-pause", "yes"),
      ("cache-pause-initial", "no"),
      // No automatic track selection: the JS player controls drive aid / sid.
      ("alang", ""),
      ("slang", ""),
      ("sub-auto", "no"),
      ("sub-file-paths", ""),
      ("subs-fallback", "no"),
    ] + (Self.audioPlan.map { [("audio-spdif", $0.spdif), ("audio-channels", $0.channels)] } ?? [])
    for (name, value) in options {
      let rc = mpv_set_option_string(h, name, value)
      if rc < 0 { PlaybackLog.warn("mpv.option_failed \(name)=\(value) error=\(String(cString: mpv_error_string(rc)))") }
    }
    mpv_request_log_messages(h, "info")
    let rc = mpv_initialize(h)
    guard rc >= 0 else {
      PlaybackLog.error("mpv.initialize failed error=\(String(cString: mpv_error_string(rc)))")
      mpv_terminate_destroy(h)
      return
    }
    for (name, format) in [("paused-for-cache", MPV_FORMAT_FLAG), ("eof-reached", MPV_FORMAT_FLAG), ("hwdec-current", MPV_FORMAT_STRING), ("pause", MPV_FORMAT_FLAG)] {
      mpv_observe_property(h, 0, name, format)
    }
    handle = h
    // Retained until `destroy` has cleared the callback, so the callback's context never dangles.
    let context = Unmanaged.passRetained(self).toOpaque()
    mpv_set_wakeup_callback(h, { ctx in
      guard let ctx else { return }
      let engine = Unmanaged<MpvEngine>.fromOpaque(ctx).takeUnretainedValue()
      engine.eventQueue.async { engine.drainEvents() }
    }, context)

    let nc = NotificationCenter.default
    // No background audio mode: iOS suspends the app, so pause (and no GPU work is queued while backgrounded, which
    // Metal refuses). The user resumes from the controls.
    notificationTokens.append(
      nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { [weak self] _ in
        guard let self else { return }
        let r = try? self.withHandle { mpv_set_property_string($0, "pause", "yes") }
        PlaybackLog.info("mpv.background pause rc=\(r.map(String.init) ?? "no-core")")
      })
    notificationTokens.append(
      nc.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil) { _ in
        PlaybackLog.info("mpv.foreground")
      })
    // Audio session interruptions and headphones going away (PLAY-FOCUS-01), the iPhone twin of Android's audio focus.
    notificationTokens.append(
      nc.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: nil) { [weak self] note in
        self?.onInterruption(note)
      })
    notificationTokens.append(
      nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: nil) { [weak self] note in
        self?.onRouteChange(note)
      })

    Self.registryLock.lock()
    Self.currentEngine = self
    Self.registryLock.unlock()
    PlaybackLog.info("mpv.created api=\(mpv_client_api_version()) wid=0x\(String(wid, radix: 16)) scale=\(layer.contentsScale)")
  }

  /// Frees the core (asynchronously, on the event queue). Safe to call twice; calls racing it fail with `MpvError`.
  func destroy() {
    for t in notificationTokens { NotificationCenter.default.removeObserver(t) }
    notificationTokens.removeAll()
    Self.registryLock.lock()
    if Self.currentEngine === self { Self.currentEngine = nil }
    Self.registryLock.unlock()
    let layer = layer  // mpv draws into it until the VO is gone
    eventQueue.async { [self] in
      let h: OpaquePointer? = guardLock.write {
        let h = handle
        handle = nil
        return h
      }
      guard let h else { return }
      mpv_set_wakeup_callback(h, nil, nil)
      Unmanaged.passUnretained(self).release()
      let started = CACurrentMediaTime()
      mpv_terminate_destroy(h)
      PlaybackLog.info("mpv.destroyed ms=\(Int((CACurrentMediaTime() - started) * 1000)) layer=\(Unmanaged.passUnretained(layer).toOpaque())")
    }
  }

  // MARK: guarded client calls

  func withHandle<T>(_ body: (OpaquePointer) throws -> T) throws -> T {
    try guardLock.read {
      guard let h = handle else { throw MpvError(description: "mpv core is not live") }
      return try body(h)
    }
  }

  private static func check(_ rc: Int32, _ what: @autoclosure () -> String) throws {
    if rc < 0 { throw MpvError(description: "\(what()): \(String(cString: mpv_error_string(rc)))") }
  }

  /// `mpv_command` (synchronous, like the Android bridge's `MPVLib.command`).
  func command(_ args: [String]) throws {
    try withHandle { h in
      var cargs: [UnsafePointer<CChar>?] = args.map { UnsafePointer(strdup($0)) } + [nil]
      defer { for p in cargs { free(UnsafeMutablePointer(mutating: p)) } }
      try Self.check(mpv_command(h, &cargs), args.joined(separator: " "))
    }
  }

  func setString(_ name: String, _ value: String) throws {
    try withHandle { try Self.check(mpv_set_property_string($0, name, value), "set \(name)=\(value)") }
  }

  func setFlag(_ name: String, _ value: Bool) throws {
    try withHandle { h in
      var v: Int32 = value ? 1 : 0
      try Self.check(mpv_set_property(h, name, MPV_FORMAT_FLAG, &v), "set \(name)")
    }
  }

  func setInt(_ name: String, _ value: Int64) throws {
    try withHandle { h in
      var v = value
      try Self.check(mpv_set_property(h, name, MPV_FORMAT_INT64, &v), "set \(name)")
    }
  }

  func setDouble(_ name: String, _ value: Double) throws {
    try withHandle { h in
      var v = value
      try Self.check(mpv_set_property(h, name, MPV_FORMAT_DOUBLE, &v), "set \(name)")
    }
  }

  func double(_ name: String) -> Double? {
    try? withHandle { h in
      var v = 0.0
      return mpv_get_property(h, name, MPV_FORMAT_DOUBLE, &v) >= 0 ? v : nil
    }
  }

  func int(_ name: String) -> Int64? {
    try? withHandle { h in
      var v: Int64 = 0
      return mpv_get_property(h, name, MPV_FORMAT_INT64, &v) >= 0 ? v : nil
    }
  }

  func flag(_ name: String) -> Bool? {
    try? withHandle { h in
      var v: Int32 = 0
      return mpv_get_property(h, name, MPV_FORMAT_FLAG, &v) >= 0 ? v != 0 : nil
    }
  }

  func string(_ name: String) -> String? {
    try? withHandle { h in
      guard let p = mpv_get_property_string(h, name) else { return nil }
      defer { mpv_free(p) }
      return String(cString: p)
    }
  }

  /// A NODE property (`track-list`, `chapter-list`) as Foundation values.
  func node(_ name: String) -> Any? {
    try? withHandle { h in
      var n = mpv_node()
      guard mpv_get_property(h, name, MPV_FORMAT_NODE, &n) >= 0 else { return nil }
      defer { mpv_free_node_contents(&n) }
      return Self.value(of: n)
    }
  }

  private static func value(of n: mpv_node) -> Any {
    switch n.format {
    case MPV_FORMAT_STRING, MPV_FORMAT_OSD_STRING: return n.u.string.map { String(cString: $0) } ?? ""
    case MPV_FORMAT_FLAG: return n.u.flag != 0
    case MPV_FORMAT_INT64: return n.u.int64
    case MPV_FORMAT_DOUBLE: return n.u.double_
    case MPV_FORMAT_NODE_ARRAY:
      guard let list = n.u.list?.pointee else { return [Any]() }
      return (0..<Int(list.num)).map { value(of: list.values[$0]) }
    case MPV_FORMAT_NODE_MAP:
      guard let list = n.u.list?.pointee else { return [String: Any]() }
      var map: [String: Any] = [:]
      for i in 0..<Int(list.num) {
        if let key = list.keys[i] { map[String(cString: key)] = value(of: list.values[i]) }
      }
      return map
    default: return NSNull()
    }
  }

  // MARK: playback API (shared by MpvControl and MpvPlayerView)

  /// `loadfile <url> replace 0 <options>`: per-file options such as `start=12.5,aid=2,sid=no` apply to this load only.
  func load(url: String, options: String?) throws {
    let opts = options?.trimmingCharacters(in: .whitespaces) ?? ""
    PlaybackLog.info("mpv.load url=\(url) options=\(opts)")
    mark("load")
    try command(opts.isEmpty ? ["loadfile", url, "replace"] : ["loadfile", url, "replace", "0", opts])
  }

  /// Starts the latency clock read when the matching core event arrives (`playback.restart` / `audio.reconfig` logs).
  func mark(_ kind: String) {
    actionLock.lock()
    pendingAction = (kind, CACurrentMediaTime())
    actionLock.unlock()
  }

  private func takeAction() -> (kind: String, ms: Int)? {
    actionLock.lock()
    defer { actionLock.unlock() }
    guard let a = pendingAction else { return nil }
    pendingAction = nil
    return (a.kind, Int((CACurrentMediaTime() - a.at) * 1000))
  }

  // MARK: audio session (PLAY-FOCUS-01)

  /// A call, Siri or an alarm takes the audio session: pause what plays; when it ends with `shouldResume`, play again
  /// only if this pause was ours and the user has not pressed play or pause since. Sets `pause` like the player's own
  /// pause button, so the JS snapshot and the Now Playing card show it.
  private func onInterruption(_ note: Notification) {
    guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
    switch type {
    case .began:
      let playing = flag("pause") == false
      interruptionLock.lock()
      pausedByInterruption = playing
      interruptionLock.unlock()
      if playing { _ = try? setFlag("pause", true) }
      PlaybackLog.info("focus.interruption began playing=\(playing)")
    case .ended:
      let options = AVAudioSession.InterruptionOptions(rawValue: note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
      interruptionLock.lock()
      let ours = pausedByInterruption
      pausedByInterruption = false
      interruptionLock.unlock()
      let resume = ours && options.contains(.shouldResume) && flag("pause") == true
      PlaybackLog.info("focus.interruption ended ours=\(ours) shouldResume=\(options.contains(.shouldResume)) resume=\(resume)")
      guard resume else { return }
      do {
        try AVAudioSession.sharedInstance().setActive(true)
      } catch {
        PlaybackLog.warn("focus.reactivate error=\(error.localizedDescription)")
      }
      _ = try? setFlag("pause", false)
    @unknown default:
      break
    }
  }

  /// Headphones unplugged or a Bluetooth headset gone (`oldDeviceUnavailable`): pause rather than play on the speaker.
  private func onRouteChange(_ note: Notification) {
    guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
          AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable else { return }
    interruptionLock.lock()
    pausedByInterruption = false
    interruptionLock.unlock()
    let playing = flag("pause") == false
    if playing { _ = try? setFlag("pause", true) }
    PlaybackLog.info("focus.route_lost playing=\(playing)")
  }

  // MARK: events (event queue only)

  private func drainEvents() {
    // `destroy` runs on this queue, so the handle cannot be freed while this drains.
    guard let h = guardLock.read({ handle }) else { return }
    while true {
      guard let ev = mpv_wait_event(h, 0)?.pointee, ev.event_id != MPV_EVENT_NONE else { return }
      onEvent(ev, h)
    }
  }

  private func onEvent(_ ev: mpv_event, _ h: OpaquePointer) {
    eventTap?(ev)
    switch ev.event_id {
    case MPV_EVENT_LOG_MESSAGE:
      guard let m = ev.data?.assumingMemoryBound(to: mpv_event_log_message.self).pointee else { return }
      let text = String(cString: m.text).trimmingCharacters(in: .whitespacesAndNewlines)
      PlaybackLog.mpv(level: m.log_level, "[\(String(cString: m.prefix))] \(text)")
    case MPV_EVENT_START_FILE:
      loadStartedAt = CACurrentMediaTime()
      firstFrameLogged = false
      lastGpuReport = nil
      PlaybackLog.info("mpv.start_file")
    case MPV_EVENT_FILE_LOADED:
      PlaybackLog.info("mpv.file_loaded ms=\(Int((CACurrentMediaTime() - loadStartedAt) * 1000))")
    case MPV_EVENT_PLAYBACK_RESTART:
      let action = takeAction()
      if !firstFrameLogged {
        firstFrameLogged = true
        PlaybackLog.info("first_frame ms=\(Int((CACurrentMediaTime() - loadStartedAt) * 1000))")
      } else if let action {
        PlaybackLog.info("playback.restart cause=\(action.kind) ms=\(action.ms)")
      }
      reportGpu(h)
    case MPV_EVENT_AUDIO_RECONFIG:
      if let action = takeAction() { PlaybackLog.info("audio.reconfig cause=\(action.kind) ms=\(action.ms)") }
    case MPV_EVENT_VIDEO_RECONFIG:
      reportGpu(h)
    case MPV_EVENT_END_FILE:
      guard let e = ev.data?.assumingMemoryBound(to: mpv_event_end_file.self).pointee else { return }
      let reason: String
      switch e.reason {
      case MPV_END_FILE_REASON_EOF: reason = "eof"
      case MPV_END_FILE_REASON_STOP: reason = "stop"
      case MPV_END_FILE_REASON_QUIT: reason = "quit"
      case MPV_END_FILE_REASON_ERROR: reason = "error"
      case MPV_END_FILE_REASON_REDIRECT: reason = "redirect"
      default: reason = "\(e.reason.rawValue)"
      }
      let line = "mpv.end_file reason=\(reason) error=\(String(cString: mpv_error_string(e.error)))"
      if e.reason == MPV_END_FILE_REASON_ERROR { PlaybackLog.error(line) } else { PlaybackLog.info(line) }
    case MPV_EVENT_PROPERTY_CHANGE:
      guard let p = ev.data?.assumingMemoryBound(to: mpv_event_property.self).pointee, p.data != nil else { return }
      let name = String(cString: p.name)
      switch p.format {
      case MPV_FORMAT_FLAG:
        let on = p.data.assumingMemoryBound(to: Int32.self).pointee != 0
        PlaybackLog.info("mpv.\(name)=\(on)")
        // A play (the user's, or the interruption's own resume) settles any pending interruption resume.
        if name == "pause" && !on {
          interruptionLock.lock()
          pausedByInterruption = false
          interruptionLock.unlock()
        }
      case MPV_FORMAT_STRING:
        if let s = p.data.assumingMemoryBound(to: UnsafePointer<CChar>?.self).pointee { PlaybackLog.info("mpv.\(name)=\(String(cString: s))") }
      default: break
      }
    case MPV_EVENT_SHUTDOWN:
      PlaybackLog.info("mpv.shutdown")
    default:
      break
    }
  }

  /// `hwdec` / `vo` are requests; this logs what mpv actually uses, once per file and on every change (Android
  /// `MpvPlaybackReport`, tag `playback.gpu`).
  private func reportGpu(_ h: OpaquePointer) {
    func str(_ name: String) -> String {
      guard let p = mpv_get_property_string(h, name) else { return "" }
      defer { mpv_free(p) }
      return String(cString: p)
    }
    let hw = str("hwdec-current")
    let vo = str("current-vo")
    let line = "playback.gpu hwdec-current=\(hw.isEmpty ? "none" : hw) current-vo=\(vo.isEmpty ? "none" : vo) codec=\(str("video-format")) \(str("video-params/w"))x\(str("video-params/h")) pixfmt=\(str("video-params/hw-pixelformat"))/\(str("video-params/pixelformat"))"
    guard line != lastGpuReport else { return }
    lastGpuReport = line
    PlaybackLog.info(line)
  }
}
