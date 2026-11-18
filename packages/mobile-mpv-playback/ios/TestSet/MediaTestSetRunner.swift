#if DEBUG || SB_MEDIA_TEST_SET
import Foundation
import Libmpv
import MediaProxy
import Network
import QuartzCore
import UIKit

/// DEBUG / TEST-BUILD-ONLY runner of the media format test set (REL-DEPS-11, packages/media-deps/src/mediaTestSet.ts),
/// the iOS twin of Android's `MediaTestSetActivity`. Compiled only into Debug builds and builds made with
/// `SB_MEDIA_TEST_SET=YES` (podspec), never into a plain Release build; it runs only when the app is launched with the
/// environment variable `SB_MEDIA_TEST_SET=1` (`MediaTestSetLoader.m` installs it at load time).
///
/// Plays every fixture of `expectations.json` through the app's own `MpvEngine` (so the app's exact mpv options) and
/// checks what mpv reports against the expectation: demuxed codec + size, decoded video size and progress, VideoToolbox
/// where required, decoded audio parameters, subtitle text and on-screen pixels (snapshot with the subtitle minus
/// snapshot without it). HLS fixtures go through a loopback HTTP server on 127.0.0.1, like the app's playback proxy;
/// sidecar subtitles through `sub-add`, like the app.
///
/// Driven by packages/media-deps/scripts/run-media-test-set-ios.ts:
///   xcrun devicectl device process launch --console --terminate-existing \
///     -e '{"SB_MEDIA_TEST_SET":"1","SB_MEDIA_TEST_SET_ONLY":"id,id"}' com.spacebadger.mobile
/// Set dir: `Documents/media-test-set` of the app container (devicectl-writable), or `SB_MEDIA_TEST_SET_DIR`. Writes
/// `<dir>/report.json` (same shape as Android's) + `shots/<id>.png` for every fixture with a picture, prints one
/// `MediaTestSet` line per fixture and `MediaTestSet DONE {...}` at the end, then exits the process.
@objc(SBMediaTestSetRunner)
final class MediaTestSetRunner: NSObject {
  private static var shared: MediaTestSetRunner?

  /// Called from `+[SBMediaTestSetLoader load]`: starts the runner once the app has launched, when asked to.
  @objc static func installIfRequested() {
    let env = ProcessInfo.processInfo.environment
    guard env["SB_MEDIA_TEST_SET"] == "1" else { return }
    setvbuf(stdout, nil, _IOLBF, 0)  // `devicectl --console` relays stdout line by line
    var token: NSObjectProtocol?
    token = NotificationCenter.default.addObserver(forName: UIApplication.didFinishLaunchingNotification, object: nil, queue: .main) { _ in
      if let token { NotificationCenter.default.removeObserver(token) }
      let runner = MediaTestSetRunner(env: env)
      shared = runner
      runner.start()
    }
  }

  private let dir: URL
  private let only: Set<String>?
  private let worker = DispatchQueue(label: "MediaTestSet.worker", qos: .userInitiated)
  private let metalLayer = CAMetalLayer()
  private var window: UIWindow?
  private var playerView = UIView()
  private var engine: MpvEngine!
  private var device: [String: Any] = [:]

  // Event-queue counters ("the next FILE_LOADED after this point") and the warnings of the fixture being played.
  private let lock = NSLock()
  private var loadedCount = 0
  private var endedCount = 0
  private var logSink: [String]?

  private init(env: [String: String]) {
    let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    dir = env["SB_MEDIA_TEST_SET_DIR"].map { URL(fileURLWithPath: $0) } ?? documents.appendingPathComponent("media-test-set")
    let ids = env["SB_MEDIA_TEST_SET_ONLY"]?.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    only = ids.flatMap { $0.isEmpty ? nil : Set($0) }
    super.init()
  }

  private static func log(_ msg: String) {
    print("MediaTestSet \(msg)")
    PlaybackLog.info("MediaTestSet \(msg)")
  }

  /// Main thread: a window above the app with a 16:9 player box (largest that fits), then the fixtures on `worker`.
  private func start() {
    UIApplication.shared.isIdleTimerDisabled = true
    // iOS suspends a backgrounded app (MpvEngine also pauses): the fixture playing then stalls. Say so in the log.
    NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { _ in
      Self.log("BACKGROUNDED: the app left the foreground; the fixture in progress will stall until it returns")
    }
    let screen = UIScreen.main.bounds
    let width = min(screen.width, screen.height * 16 / 9).rounded()
    let height = (width * 9 / 16).rounded()
    let vc = UIViewController()
    vc.view.backgroundColor = .black
    playerView.frame = CGRect(x: ((screen.width - width) / 2).rounded(), y: ((screen.height - height) / 2).rounded(), width: width, height: height)
    playerView.backgroundColor = .black
    metalLayer.isOpaque = true
    metalLayer.backgroundColor = UIColor.black.cgColor
    metalLayer.contentsScale = UIScreen.main.nativeScale
    metalLayer.frame = playerView.bounds
    playerView.layer.addSublayer(metalLayer)
    vc.view.addSubview(playerView)
    let w = UIWindow(frame: screen)
    w.windowLevel = .alert + 1
    w.rootViewController = vc
    w.makeKeyAndVisible()
    window = w

    var info = utsname()
    uname(&info)
    let machine = withUnsafeBytes(of: &info.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    device = [
      "manufacturer": "Apple", "model": machine, "name": UIDevice.current.model,
      "os": "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)", "abi": "arm64",
      "surface": "\(Int(width * metalLayer.contentsScale))x\(Int(height * metalLayer.contentsScale))",
    ]

    // The app's own engine: identical options to the player the user sees (MpvEngine.init).
    engine = MpvEngine(layer: metalLayer)
    engine.eventTap = { [weak self] ev in self?.onEvent(ev) }
    worker.async { [self] in
      var report: [String: Any]
      do {
        report = try run()
      } catch {
        Self.log("runner crashed: \(error)")
        report = ["crash": "\(error)"]
      }
      let url = dir.appendingPathComponent("report.json")
      do {
        guard JSONSerialization.isValidJSONObject(report) else { throw MpvError(description: "report is not valid JSON: \(report)") }
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: url, options: .atomic)
      } catch {
        Self.log("report write failed: \(error)")
        try? Data("{\"crash\": \"report write failed: \(error)\"}".utf8).write(to: url, options: .atomic)
      }
      let summary = report["summary"].flatMap { try? JSONSerialization.data(withJSONObject: $0) }.map { String(decoding: $0, as: UTF8.self) }
      Self.log("DONE \(summary ?? (report["crash"] as? String ?? "?")) report=\(url.path)")
      // Like the Android activity finishing: the host waits for the process to end (`devicectl --console`).
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { exit(0) }
    }
  }

  private func onEvent(_ ev: mpv_event) {
    switch ev.event_id {
    case MPV_EVENT_FILE_LOADED:
      lock.lock(); loadedCount += 1; lock.unlock()
    case MPV_EVENT_END_FILE:
      lock.lock(); endedCount += 1; lock.unlock()
    case MPV_EVENT_LOG_MESSAGE:
      guard let m = ev.data?.assumingMemoryBound(to: mpv_event_log_message.self).pointee,
            m.log_level.rawValue <= MPV_LOG_LEVEL_WARN.rawValue else { return }
      let line = "[\(String(cString: m.prefix))] \(String(cString: m.text).trimmingCharacters(in: .whitespacesAndNewlines))"
      lock.lock()
      if logSink != nil, logSink!.count < 40 { logSink!.append(line) }
      lock.unlock()
    default:
      break
    }
  }

  private var loaded: Int { lock.lock(); defer { lock.unlock() }; return loadedCount }
  private var ended: Int { lock.lock(); defer { lock.unlock() }; return endedCount }

  // MARK: fixtures (worker queue)

  private func run() throws -> [String: Any] {
    let data = try Data(contentsOf: dir.appendingPathComponent("expectations.json"))
    guard let expectations = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let fixtures = expectations["fixtures"] as? [[String: Any]] else { throw MpvError(description: "expectations.json has no fixtures") }
    try FileManager.default.createDirectory(at: dir.appendingPathComponent("shots"), withIntermediateDirectories: true)
    let http = try LoopbackHttp(root: dir)
    defer { http.close() }
    var results: [[String: Any]] = []
    var passed = 0
    Self.log("START dir=\(dir.path) fixtures=\(fixtures.count) only=\(only.map { $0.sorted().joined(separator: ",") } ?? "all") device=\(device) http=\(http.port)")
    for fixture in fixtures {
      guard let id = fixture["id"] as? String else { continue }
      if let only, !only.contains(id) { continue }
      let result = runFixture(fixture, id: id, http: http)
      let pass = result["pass"] as? Bool ?? false
      if pass { passed += 1 }
      results.append(result)
      let line = (try? JSONSerialization.data(withJSONObject: result)).map { String(decoding: $0, as: UTF8.self) } ?? "\(result)"
      Self.log("\(pass ? "PASS" : "FAIL") \(id) \(line)")
    }
    return [
      "version": expectations["version"] ?? NSNull(),
      "generatedBy": expectations["generatedBy"] ?? NSNull(),
      "device": device,
      "mpvVersion": j(engine.string("mpv-version")),
      "ffmpegVersion": j(engine.string("ffmpeg-version")),
      "summary": ["total": results.count, "passed": passed, "failed": results.count - passed],
      "fixtures": results,
    ]
  }

  private func runFixture(_ fixture: [String: Any], id: String, http: LoopbackHttp) -> [String: Any] {
    let expect = fixture["expect"] as? [String: Any] ?? [:]
    let video = expect["video"] as? [String: Any]
    let audio = expect["audio"] as? [String: Any]
    let sub = expect["subtitle"] as? [String: Any]
    let image = expect["image"] as? Bool ?? false
    let file = fixture["file"] as? String ?? ""
    var failures: [String] = []
    var observed: [String: Any] = [:]
    var result: [String: Any] = ["id": id]
    lock.lock(); logSink = []; lock.unlock()
    play: do {
      let url = expect["transport"] as? String == "hls" ? "http://127.0.0.1:\(http.port)/\(file)" : dir.appendingPathComponent(file).path
      let loadedBefore = loaded
      let endedBefore = ended
      try engine.setFlag("pause", sub != nil)
      let t0 = CACurrentMediaTime()
      try engine.load(url: url, options: nil)
      // FILE_LOADED on success; END_FILE (without FILE_LOADED) when lavf/mpv cannot open it.
      _ = waitFor(10_000) { self.loaded > loadedBefore || self.ended > endedBefore }
      result["loadMs"] = Int((CACurrentMediaTime() - t0) * 1000)
      if loaded == loadedBefore {
        failures.append("file never loaded")
        break play
      }
      let tracks = trackList()
      observed["fileFormat"] = j(engine.string("file-format"))
      observed["tracks"] = tracks
      func track(_ type: String) -> [String: Any]? { tracks.first { $0["type"] as? String == type } }

      if let sub { checkSubtitle(id, sub, track("sub"), &observed, &failures) } else { checkPlayback(id, image, video != nil, &observed, &failures) }

      if let video {
        if let t = track("video") {
          let codec = t["codec"] as? String ?? ""
          let expected = video["codec"] as? String ?? ""
          if codec != expected { failures.append("video codec \(codec), expected \(expected)") }
          let w = engine.int("video-params/w").map(Int.init)
          let h = engine.int("video-params/h").map(Int.init)
          observed["videoParams"] = "\(str(w))x\(str(h)) \(str(engine.string("video-params/pixelformat"))) hw=\(str(engine.string("video-params/hw-pixelformat")))"
          let ew = video["width"] as? Int ?? -1
          let eh = video["height"] as? Int ?? -1
          if w != ew || h != eh { failures.append("decoded \(str(w))x\(str(h)), expected \(ew)x\(eh)") }
          let hwdec = engine.string("hwdec-current")
          observed["hwdec"] = j(hwdec)
          if video["platformHwdec"] as? Bool == true, hwdec?.hasPrefix("videotoolbox") != true { failures.append("hwdec-current=\(str(hwdec)), expected videotoolbox") }
        } else {
          failures.append("no video track")
        }
      }
      if let audio {
        if let t = track("audio") {
          let codec = t["codec"] as? String ?? ""
          let expected = audio["codec"] as? String ?? ""
          if codec != expected { failures.append("audio codec \(codec), expected \(expected)") }
          let channels = engine.int("audio-params/channel-count").map(Int.init)
          let rate = engine.int("audio-params/samplerate").map(Int.init)
          observed["audioParams"] = "\(str(engine.string("audio-codec-name"))) ch=\(str(channels)) rate=\(str(rate)) fmt=\(str(engine.string("audio-params/format"))) out=\(str(engine.string("audio-out-params/samplerate")))"
          let ec = audio["channels"] as? Int ?? -1
          let er = audio["sampleRate"] as? Int ?? -1
          if channels != ec { failures.append("decoded \(str(channels)) ch, expected \(ec)") }
          if rate != er { failures.append("decoded \(str(rate)) Hz, expected \(er)") }
        } else {
          failures.append("no audio track")
        }
      }
    } catch {
      failures.append("exception \(error)")
      Self.log("\(id) threw \(error)")
    }
    // Always: stop the file (END_FILE), then attach the verdict (Android's `finally`).
    let endedBefore = ended
    try? engine.command(["stop"])
    _ = waitFor(3_000) { self.ended > endedBefore }
    lock.lock(); let log = logSink ?? []; logSink = nil; lock.unlock()
    result["pass"] = failures.isEmpty
    result["failures"] = failures
    result["observed"] = observed
    result["mpvLog"] = log
    return result
  }

  /// Plays until 1.5 s (or 80% of shorter media) and checks the picture moved through the decoder onto the layer.
  private func checkPlayback(_ id: String, _ image: Bool, _ hasVideo: Bool, _ observed: inout [String: Any], _ failures: inout [String]) {
    let duration = engine.double("duration")
    let target = image || duration == nil ? 0.0 : min(1.5, duration! * 0.8)
    let t0 = CACurrentMediaTime()
    let reached = waitFor(15_000) {
      if image { return self.engine.int("video-params/w") != nil }
      return (self.engine.double("time-pos") ?? 0) >= target || self.engine.flag("eof-reached") == true
    }
    if image { usleep(400_000) }  // let the vo present the still
    observed["durationS"] = j(duration)
    observed["timePos"] = j(engine.double("time-pos"))
    observed["reachMs"] = Int((CACurrentMediaTime() - t0) * 1000)
    observed["frameDrops"] = j(engine.int("frame-drop-count"))
    observed["decoderFrameDrops"] = j(engine.int("decoder-frame-drop-count"))
    observed["estimatedVfFps"] = j(engine.double("estimated-vf-fps"))
    if !reached { failures.append("playback stalled at \(str(engine.double("time-pos"))) s (target \(target) s)") }
    guard hasVideo else { return }
    guard let shot = capture() else {
      failures.append("screenshot failed")
      return
    }
    let lit = litFraction(shot)
    observed["litFraction"] = lit
    save(shot, "\(id).png")
    if lit < 0.10 { failures.append("picture blank (lit fraction \(lit))") }
    checkFill(shot, &observed, &failures)
  }

  /// @bugfix @regression-proof: the picture must fill its display rect, the aspect-fit of the video's display size in
  /// the layer, on every file, though the layer is never resized or laid out again between files. Our mpv fork's
  /// moltenvk context (sf/0.41.0-mobile) left `vo->dwidth/dheight` at the video size that vo.c sets on each reconfig
  /// when the layer size was unchanged, so every file was drawn at its native pixel size in the layer's top-left
  /// corner until the app rotated (3gp-h263-aac: 176x144 in a 828x466 layer). Measured as the bounding box of the
  /// non-black pixels: it must span at least 90% of the expected rect on both axes, centred within 3% of the layer.
  private func checkFill(_ p: Pixels, _ observed: inout [String: Any], _ failures: inout [String]) {
    guard let dw = engine.int("video-params/dw"), let dh = engine.int("video-params/dh"), dw > 0, dh > 0 else {
      failures.append("no video-params/dw,dh to check the display rect")
      return
    }
    let scale = min(Double(p.width) / Double(dw), Double(p.height) / Double(dh))
    let ew = Double(dw) * scale
    let eh = Double(dh) * scale
    var minX = Int.max, minY = Int.max, maxX = -1, maxY = -1
    for y in stride(from: 0, to: p.height, by: 2) {
      for x in stride(from: 0, to: p.width, by: 2) {
        let (r, g, b) = p.rgb(x, y)
        guard r + g + b > 3 * 24 else { continue }
        minX = min(minX, x); maxX = max(maxX, x)
        minY = min(minY, y); maxY = max(maxY, y)
      }
    }
    let expected = "\(Int(ew))x\(Int(eh)) at \(Int((Double(p.width) - ew) / 2)),\(Int((Double(p.height) - eh) / 2))"
    observed["displayRect"] = expected
    guard maxX >= 0 else { return }  // all black: already reported as blank
    let bw = Double(maxX - minX + 2)
    let bh = Double(maxY - minY + 2)
    let cx = Double(minX + maxX) / 2
    let cy = Double(minY + maxY) / 2
    let box = "\(Int(bw))x\(Int(bh)) at \(minX),\(minY)"
    observed["litBox"] = box
    let centred = abs(cx - Double(p.width) / 2) <= 0.03 * Double(p.width) && abs(cy - Double(p.height) / 2) <= 0.03 * Double(p.height)
    if bw < 0.9 * ew || bh < 0.9 * eh || !centred {
      failures.append("picture does not fill its display rect (lit box \(box), expected \(expected))")
    }
  }

  /// Selects the track, plays from the start into the cue and pauses there, then snapshots with and without it: the
  /// subtitle must change pixels (text and bitmap alike) and, for text formats, `sub-text` must carry the cue.
  /// Plays rather than seeks: mpv 0.41 does not show a PGS cue (.sup: one packet per segment) that is already on screen
  /// at a seek target until the next display set (desktop mpv too); Android showed the same for DVB.
  private func checkSubtitle(_ id: String, _ sub: [String: Any], _ embedded: [String: Any]?, _ observed: inout [String: Any], _ failures: inout [String]) {
    var track = embedded
    if let sidecar = sub["sidecar"] as? String, !sidecar.isEmpty {
      let before = trackList().count
      do {
        try engine.command(["sub-add", dir.appendingPathComponent(sidecar).path, "select"])
      } catch {
        failures.append("sub-add failed: \(error)")
      }
      _ = waitFor(3_000) { self.trackList().count > before }
      let tracks = trackList()
      observed["tracks"] = tracks
      track = tracks.last { $0["type"] as? String == "sub" }
    }
    guard let track, let trackId = track["id"] as? Int64 else {
      failures.append("no subtitle track")
      return
    }
    let codec = track["codec"] as? String ?? ""
    let expectedCodec = sub["codec"] as? String ?? ""
    if codec != expectedCodec { failures.append("subtitle codec \(codec), expected \(expectedCodec)") }
    do {
      try engine.setInt("sid", trackId)
      try engine.setFlag("pause", false)
    } catch {
      failures.append("select/play failed: \(error)")
    }
    let atS = sub["atS"] as? Double ?? 0
    if !waitFor(10_000, { (self.engine.double("time-pos") ?? 0) >= atS }) { failures.append("playback never reached the cue at \(atS) s") }
    try? engine.setFlag("pause", true)
    usleep(700_000)  // vo presents the paused frame with the cue
    let text = engine.string("sub-text")
    observed["sid"] = j(engine.string("sid"))
    observed["timePos"] = j(engine.double("time-pos"))
    observed["subText"] = j(text)
    let withSub = capture()
    try? engine.setString("sid", "no")
    usleep(500_000)
    let without = capture()
    guard let withSub, let without else {
      failures.append("screenshot failed")
      return
    }
    let changed = changedFraction(withSub, without)
    observed["subPixelsChanged"] = changed
    save(withSub, "\(id).png")
    if changed < 0.002 { failures.append("subtitle not drawn (changed fraction \(changed))") }
    if let expected = sub["text"] as? String, !expected.isEmpty, text?.contains(expected) != true {
      failures.append("sub-text '\(str(text))', expected '\(expected)'")
    }
  }

  private func trackList() -> [[String: Any]] { engine.node("track-list") as? [[String: Any]] ?? [] }

  // MARK: pixels

  private struct Pixels {
    let width: Int
    let height: Int
    let rgba: [UInt8]
    let image: CGImage
    func rgb(_ x: Int, _ y: Int) -> (Int, Int, Int) {
      let i = (y * width + x) * 4
      return (Int(rgba[i]), Int(rgba[i + 1]), Int(rgba[i + 2]))
    }
  }

  /// The composited player box as the screen shows it (Metal layer included), at native scale.
  private func capture() -> Pixels? {
    DispatchQueue.main.sync {
      let format = UIGraphicsImageRendererFormat()
      format.scale = metalLayer.contentsScale
      format.opaque = true
      var drawn = false
      let image = UIGraphicsImageRenderer(bounds: playerView.bounds, format: format).image { _ in
        drawn = playerView.drawHierarchy(in: playerView.bounds, afterScreenUpdates: false)
      }
      guard drawn, let cg = image.cgImage else { return nil }
      let width = cg.width
      let height = cg.height
      var rgba = [UInt8](repeating: 0, count: width * height * 4)
      let ok = rgba.withUnsafeMutableBytes { buf -> Bool in
        guard let ctx = CGContext(data: buf.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
        return true
      }
      return ok ? Pixels(width: width, height: height, rgba: rgba, image: cg) : nil
    }
  }

  private func save(_ p: Pixels, _ name: String) {
    guard let png = UIImage(cgImage: p.image).pngData() else { return }
    try? png.write(to: dir.appendingPathComponent("shots").appendingPathComponent(name))
  }

  /// Share of sampled pixels brighter than near-black (letterbox bars stay black).
  private func litFraction(_ p: Pixels) -> Double {
    var lit = 0
    var total = 0
    for y in stride(from: 0, to: p.height, by: 8) {
      for x in stride(from: 0, to: p.width, by: 8) {
        let (r, g, b) = p.rgb(x, y)
        if r + g + b > 3 * 24 { lit += 1 }
        total += 1
      }
    }
    return Double(lit) / Double(max(total, 1))
  }

  private func changedFraction(_ a: Pixels, _ b: Pixels) -> Double {
    guard a.width == b.width, a.height == b.height else { return 0 }
    var changed = 0
    var total = 0
    for y in stride(from: 0, to: a.height, by: 4) {
      for x in stride(from: 0, to: a.width, by: 4) {
        let (r1, g1, b1) = a.rgb(x, y)
        let (r2, g2, b2) = b.rgb(x, y)
        if abs(r1 - r2) + abs(g1 - g2) + abs(b1 - b2) > 60 { changed += 1 }
        total += 1
      }
    }
    return Double(changed) / Double(max(total, 1))
  }

  // MARK: helpers

  private func waitFor(_ timeoutMs: Int, _ condition: () -> Bool) -> Bool {
    let deadline = CACurrentMediaTime() + Double(timeoutMs) / 1000
    while CACurrentMediaTime() < deadline {
      if condition() { return true }
      usleep(20_000)
    }
    return condition()
  }

  private func j(_ v: Any?) -> Any { v ?? NSNull() }
  private func str<T>(_ v: T?) -> String { v.map { "\($0)" } ?? "nil" }
}

/// Minimal static GET server on 127.0.0.1 for the HLS fixtures (the app's proxy, `PlaybackHttpServer`, serves HLS the
/// same way). One request per connection, `Connection: close`.
private final class LoopbackHttp {
  private let root: URL
  private var listener: NWListener?
  private(set) var port: UInt16 = 0
  private let queue = DispatchQueue(label: "MediaTestSet.http", qos: .userInitiated, attributes: .concurrent)

  init(root: URL) throws {
    self.root = root.standardizedFileURL
    let attempts: [() -> NWParameters] = [
      {
        let p = NWParameters.tcp
        p.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: .any)
        return p
      },
      {
        let p = NWParameters.tcp
        p.requiredInterfaceType = .loopback
        return p
      },
    ]
    var lastError: Error = MpvError(description: "loopback listener never started")
    for make in attempts {
      do {
        let l = try NWListener(using: make())
        let ready = DispatchSemaphore(value: 0)
        var failure: Error?
        l.stateUpdateHandler = { state in
          switch state {
          case .ready: ready.signal()
          case .failed(let e): failure = e; ready.signal()
          default: break
          }
        }
        l.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
        l.start(queue: queue)
        if ready.wait(timeout: .now() + 5) == .timedOut { l.cancel(); throw MpvError(description: "loopback listener start timed out") }
        if let failure { l.cancel(); throw failure }
        listener = l
        port = l.port?.rawValue ?? 0
        return
      } catch {
        lastError = error
      }
    }
    throw lastError
  }

  func close() {
    listener?.cancel()
    listener = nil
  }

  private func accept(_ conn: NWConnection) {
    conn.start(queue: queue)
    read(conn, Data())
  }

  private func read(_ conn: NWConnection, _ buffer: Data) {
    conn.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, isComplete, error in
      guard let self else { conn.cancel(); return }
      var buf = buffer
      if let data { buf.append(data) }
      if buf.range(of: Data([0x0d, 0x0a, 0x0d, 0x0a])) != nil {
        self.respond(conn, head: buf)
      } else if error != nil || isComplete || buf.count > 16 * 1024 {
        conn.cancel()
      } else {
        self.read(conn, buf)
      }
    }
  }

  private func respond(_ conn: NWConnection, head: Data) {
    let requestLine = String(decoding: head.prefix { $0 != 0x0d }, as: UTF8.self)
    let rawPath = requestLine.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
    let path = (rawPath.split(separator: "?").first.map(String.init) ?? "/").removingPercentEncoding ?? ""
    let file = root.appendingPathComponent(String(path.drop { $0 == "/" })).standardizedFileURL
    var isDir: ObjCBool = false
    guard file.path.hasPrefix(root.path + "/"), FileManager.default.fileExists(atPath: file.path, isDirectory: &isDir), !isDir.boolValue,
          let body = try? Data(contentsOf: file) else {
      print("MediaTestSet http 404 \(rawPath)")
      send(conn, Data("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8))
      return
    }
    let type: String
    switch file.pathExtension {
    case "m3u8": type = "application/vnd.apple.mpegurl"
    case "ts": type = "video/mp2t"
    case "m4s", "mp4": type = "video/mp4"
    default: type = "application/octet-stream"
    }
    var response = Data("HTTP/1.1 200 OK\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".utf8)
    response.append(body)
    send(conn, response)
  }

  private func send(_ conn: NWConnection, _ data: Data) {
    conn.send(content: data, completion: .contentProcessed { _ in conn.cancel() })
  }
}
#endif
