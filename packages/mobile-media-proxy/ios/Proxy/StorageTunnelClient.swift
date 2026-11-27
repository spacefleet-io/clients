import CryptoKit
import Foundation

struct TunnelError: Error, LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

/// What the gateway said about traffic, forwarded to JS as it came (`PlaybackBridge` device event `SpacePlaybackTraffic`).
typealias TrafficSink = ([String: Any]) -> Void

/// The gateway refused a new free playback session while its silo is saturated (503 `free_playback_refused`, STOR-BW-07).
struct TunnelRefusedError: Error, LocalizedError {
  let status: Int
  let error: String
  var errorDescription: String? { "tunnel_session_refused: \(status) \(error)" }
}

/// Storage gateway client (HTTP request/response tunnel, bearer auth) + local SFV1 decrypt. Mirror of the Android
/// `StorageTunnelClient.kt`:
///   1. POST {gw}/storage/tunnel/session { purpose: "playback", profileId } -> { sessionId }   (profileId: STOR-BW-11)
///   2. POST {gw}/storage/tunnel/frame {session.start} -> { frame: { kind: "session.ack" } }
///   3. POST {winner}/storage/tunnel/download {sessionId, objectKey} -> raw SFV1 bytes
/// Gateway candidates are walked sequentially with a 3 s per-attempt timeout; the winner is sticky. An LRU cache and an
/// in-flight map make concurrent requests for one key pay network + decrypt once.
final class StorageTunnelClient: ChunkFetcher {
  /// Upper bound of the decrypted-segment LRU, also capped at 1/32 of device RAM: at a flat 128 MB the cache sat full
  /// after ~15 min and a sidecar subtitle load on top ran the Android twin out of memory (HTTP 502, subtitle off).
  private static let maxCacheBytes = 128 * 1024 * 1024
  private static let cacheBudgetBytes = min(maxCacheBytes, Int(ProcessInfo.processInfo.physicalMemory / 32))
  private static let spaceAppHeader = "x-space-app"
  private static let ackRefreshSeconds: TimeInterval = 5
  private static let freePlaybackRefused = "free_playback_refused"

  private let gatewayCandidates: [String]
  private let authToken: String
  private let appId: String
  private let masterKey: SymmetricKey
  /// API id of the profile this playback is for (STOR-BW-11), sent in every session body; the main profile's too.
  private let profileId: String
  private let spool: PlaintextSpool
  private let clientType: String
  private let clientVersion: String
  private let attemptTimeout: TimeInterval
  /// Receives `{ source, status, code, traffic }` for every traffic answer of the gateway (STOR-BW-07, STOR-BW-08); JS decides.
  private let onTraffic: TrafficSink?
  /// Told every object the player's fetches download: its encrypted size and how long the download took, request
  /// included (`PlaybackBridge` device event `SpacePlaybackDownload`). Parrot picks each song's copy from these (PAR-PLAY-02).
  private let onDownloaded: ((_ bytes: Int, _ ms: Int) -> Void)?

  private let sessionHttp: URLSession
  private let http: URLSession

  private let sessionLock = NSLock()
  private var sessionId: String?
  private var winnerBaseUrl: String?
  /// When the gateway last answered a `session.start`; guarded by `sessionLock`.
  private var lastAckAt: TimeInterval = 0

  private let cacheLock = NSLock()
  private var cache: [String: Data] = [:]
  private var cacheOrder: [String] = []  // least recently used first
  private var cacheSize = 0
  private var pending: [String: FetchDeferred] = [:]
  /// Objects the LRU keeps whatever else is fetched (`pin`, PAR-PLAY-07); guarded by `cacheLock`.
  private var pinned = Set<String>()
  /// The download task of each key on the wire now, so `cancelInFlight` can abort it; guarded by `cacheLock`.
  private var tasks: [String: URLSessionDataTask] = [:]

  init(
    gatewayCandidates: [String], authToken: String, appId: String, profileId: String, masterKey: SymmetricKey,
    spool: PlaintextSpool, clientType: String = "client-mobile-playback", clientVersion: String = "spacebadger-mobile",
    attemptTimeout: TimeInterval = 3, onTraffic: TrafficSink? = nil, onDownloaded: ((Int, Int) -> Void)? = nil
  ) {
    self.gatewayCandidates = gatewayCandidates
    self.authToken = authToken
    self.profileId = profileId
    self.appId = appId
    self.masterKey = masterKey
    self.spool = spool
    self.clientType = clientType
    self.clientVersion = clientVersion
    self.attemptTimeout = attemptTimeout
    self.onTraffic = onTraffic
    self.onDownloaded = onDownloaded
    PlaybackLog.info("cache.budget bytes=\(Self.cacheBudgetBytes) physicalMemory=\(ProcessInfo.processInfo.physicalMemory)")

    let steady = URLSessionConfiguration.ephemeral
    steady.timeoutIntervalForRequest = 30
    steady.httpMaximumConnectionsPerHost = 8
    steady.urlCache = nil
    steady.waitsForConnectivity = false
    http = URLSession(configuration: steady)

    let control = URLSessionConfiguration.ephemeral
    control.timeoutIntervalForRequest = attemptTimeout
    control.timeoutIntervalForResource = attemptTimeout
    control.urlCache = nil
    sessionHttp = URLSession(configuration: control)
  }

  // MARK: ChunkFetcher

  func getObject(_ key: String) throws -> Data { try open(key, player: true) }

  /// Loads `key` ahead of the player (PAR-PLAY-07 preloads, the proxy's read-ahead): unlike `getObject` the fetch stays
  /// cancellable until the player itself asks for the object.
  func prefetch(_ key: String) throws { _ = try open(key, player: false) }

  private func open(_ key: String, player: Bool) throws -> Data {
    cacheLock.lock()
    if let cached = cache[key] {
      touchLocked(key)
      cacheLock.unlock()
      return cached
    }
    if let existing = pending[key] {
      if player { existing.playerWanted = true }
      cacheLock.unlock()
      PlaybackLog.debug("fetch.dedup.wait key=\(key) player=\(player)")
      do {
        return try existing.waitValue()
      } catch {
        // The fetch this read joined was cancelled before the player joined it (a preload yielding, PAR-PLAY-07; a rung
        // switch): the player still wants the object, so it fetches it itself. A load ahead stays cancelled.
        cacheLock.lock()
        let cancelled = existing.cancelled
        cacheLock.unlock()
        if cancelled && player {
          PlaybackLog.info("fetch.refetch_after_cancel key=\(key)")
          return try open(key, player: true)
        }
        throw error
      }
    }
    if let spooled = spool.open(key) {
      cacheLock.unlock()
      return spooled
    }
    let deferred = FetchDeferred()
    deferred.playerWanted = player
    pending[key] = deferred
    cacheLock.unlock()

    do {
      try ensureSession()
      let (plaintext, spooled) = try fetchAndDecrypt(key)
      cacheLock.lock()
      if !spooled {
        cache[key] = plaintext
        cacheOrder.append(key)
        cacheSize += plaintext.count
        evictLocked()
      }
      pending[key] = nil
      cacheLock.unlock()
      deferred.resolve(plaintext)
      return plaintext
    } catch {
      cacheLock.lock()
      pending[key] = nil
      cacheLock.unlock()
      deferred.reject(error)
      throw error
    }
  }

  /// Aborts the fetches loading `matches` keys ahead of the player. A fetch the player itself is waiting on is skipped
  /// (PAR-PLAY-12, Chris 2026-11-27): aborting it made the proxy answer the player's request with a 502, which the player
  /// shows as a bad HTTP status and stops on.
  func cancelInFlight(_ matches: (String) -> Bool) -> Int {
    cacheLock.lock()
    let candidates = Set(pending.keys).union(tasks.keys).filter(matches)
    let skipped = candidates.filter { pending[$0]?.playerWanted == true }
    let keys = candidates.subtracting(skipped)
    // Marked under the lock `fetchRaw` registers its task under: a fetch still opening the session has no task yet and
    // is aborted the moment it makes one, so a cancel never misses a fetch that has not reached the wire. A player
    // joining it after this mark fetches the object again (see `open`).
    for key in keys { pending[key]?.cancelled = true }
    let hits = keys.compactMap { tasks[$0] }
    cacheLock.unlock()
    for task in hits { task.cancel() }
    for key in skipped { PlaybackLog.info("fetch.cancel_skipped_player_read key=\(key)") }
    for key in keys { PlaybackLog.info("fetch.cancelled key=\(key)") }
    return keys.count
  }

  func pin(_ keys: Set<String>) {
    cacheLock.lock()
    pinned = keys
    cacheLock.unlock()
    PlaybackLog.info("cache.pin keys=\(keys.count) \(keys.sorted().joined(separator: ","))")
  }

  func shutdown() {
    endSessionBestEffort()
    cacheLock.lock()
    cache.removeAll()
    cacheOrder.removeAll()
    cacheSize = 0
    pending.removeAll()
    cacheLock.unlock()
    spool.clear()
    // Let the queued session.end frame (endSessionBestEffort) go out; new work is refused after invalidation.
    http.finishTasksAndInvalidate()
    sessionHttp.invalidateAndCancel()
  }

  /// Raw tunnel download (still-encrypted SFV1 envelope, no cache, no decrypt) for the offline downloader.
  func fetchEncrypted(_ key: String) throws -> Data {
    try ensureSession()
    return try fetchRaw(key)
  }

  // MARK: cache (caller holds cacheLock)

  private func touchLocked(_ key: String) {
    if let i = cacheOrder.firstIndex(of: key) { cacheOrder.remove(at: i) }
    cacheOrder.append(key)
  }

  /// Oldest first, skipping `pinned` objects; stops when only pinned ones are left.
  private func evictLocked() {
    guard cacheSize > Self.cacheBudgetBytes else { return }
    var kept: [String] = []
    var i = 0
    while cacheSize > Self.cacheBudgetBytes && i < cacheOrder.count {
      let oldest = cacheOrder[i]
      i += 1
      if pinned.contains(oldest) {
        kept.append(oldest)
        continue
      }
      if let v = cache.removeValue(forKey: oldest) { cacheSize -= v.count }
      PlaybackLog.debug("cache.evict key=\(oldest) cacheSize=\(cacheSize) budget=\(Self.cacheBudgetBytes)")
    }
    cacheOrder = kept + cacheOrder[i...]
  }

  // MARK: session

  private func ensureSession() throws {
    sessionLock.lock()
    defer { sessionLock.unlock() }
    if sessionId != nil { return }

    var ordered = gatewayCandidates
    if let winner = winnerBaseUrl, let i = ordered.firstIndex(of: winner) {
      ordered.remove(at: i)
      ordered.insert(winner, at: 0)
    }
    var attempts: [String] = []
    for (idx, baseUrl) in ordered.enumerated() {
      do {
        let sid = try createSession(baseUrl)
        try startSessionFrame(baseUrl, sid)
        sessionId = sid
        winnerBaseUrl = baseUrl
        PlaybackLog.info("session.waterfall.winner attempt=\(idx + 1)/\(ordered.count) baseUrl=\(baseUrl) sid=\(sid)")
        return
      } catch {
        // A refusal every address of the same gateway would repeat (STOR-BW-07): the waterfall stops here.
        if error is TunnelRefusedError { throw error }
        attempts.append("\(baseUrl) -> \(error.localizedDescription)")
        PlaybackLog.warn("session.waterfall.attempt_failed attempt=\(idx + 1) baseUrl=\(baseUrl) err=\(error.localizedDescription)")
      }
    }
    winnerBaseUrl = nil
    throw TunnelError(message: "tunnel_session_all_candidates_failed: \(attempts.joined(separator: "; "))")
  }

  private func request(_ url: String, json: [String: Any]) throws -> URLRequest {
    guard let u = URL(string: url) else { throw TunnelError(message: "tunnel_bad_url: \(url)") }
    var req = URLRequest(url: u)
    req.httpMethod = "POST"
    req.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
    req.setValue(appId, forHTTPHeaderField: Self.spaceAppHeader)
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try JSONSerialization.data(withJSONObject: json)
    return req
  }

  private func createSession(_ baseUrl: String) throws -> String {
    // The gateway refuses a playback session without a profile (STOR-BW-11): never send one without.
    guard !profileId.isEmpty else {
      PlaybackLog.error("session.profile_required")
      throw TunnelError(message: "profile_required")
    }
    PlaybackLog.info("session.profile_attached profileId=\(profileId)")
    let req = try request("\(baseUrl)/storage/tunnel/session", json: ["purpose": "playback", "profileId": profileId])
    let (data, status) = try Self.send(req, on: sessionHttp)
    let error = emitTraffic("session", status, data)
    guard (200..<300).contains(status) else {
      if status == 503 && error == Self.freePlaybackRefused { throw TunnelRefusedError(status: status, error: error) }
      throw TunnelError(message: "tunnel_session_failed: \(status) \(Self.snippet(data))")
    }
    let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    guard let sid = payload?["sessionId"] as? String, !sid.isEmpty else {
      throw TunnelError(message: "tunnel_session_missing_id")
    }
    return sid
  }

  private func sessionStartRequest(_ baseUrl: String, _ sid: String) throws -> URLRequest {
    let frame: [String: Any] = [
      "kind": "session.start", "sessionId": sid, "token": authToken,
      "clientType": clientType, "clientVersion": clientVersion,
    ]
    return try request("\(baseUrl)/storage/tunnel/frame", json: ["sessionId": sid, "frame": frame])
  }

  /// Called by `ensureSession`, which holds `sessionLock`.
  private func startSessionFrame(_ baseUrl: String, _ sid: String) throws {
    lastAckAt = Date().timeIntervalSince1970
    let (data, status) = try Self.send(try sessionStartRequest(baseUrl, sid), on: sessionHttp)
    emitTraffic("ack", status, data)
    guard (200..<300).contains(status) else {
      throw TunnelError(message: "tunnel_session_start_failed: \(status) \(Self.snippet(data))")
    }
    let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    let ack = (payload?["frame"] as? [String: Any])?["kind"] as? String ?? ""
    guard ack == "session.ack" else { throw TunnelError(message: "tunnel_session_start_unexpected_frame: \(ack)") }
  }

  /// The gateway's grace before it stops a free viewer over the 480p speed is 10 s, and a tunnel session sends its
  /// `session.ack` once, at its start. While objects are fetched the `session.start` frame is re-sent every
  /// `ackRefreshSeconds` (the gateway answers with a fresh `session.ack`, which also renews the session) so the cap and a
  /// stop reach JS in time to step down. Fire and forget: the answer only feeds `emitTraffic`.
  private func refreshTraffic(_ baseUrl: String, _ sid: String) {
    guard let req = try? sessionStartRequest(baseUrl, sid) else { return }
    sessionHttp.dataTask(with: req) { [weak self] data, response, _ in
      guard let self, let status = (response as? HTTPURLResponse)?.statusCode else { return }
      self.emitTraffic("ack", status, data ?? Data())
    }.resume()
  }

  /// Forwards what the gateway said about traffic to `onTraffic` and returns the body's `error` ("" = none). Nothing is
  /// decided here: the status, the error code and the `traffic` object (of a session response, an error body or a
  /// `session.ack` frame) go to JS as they came.
  @discardableResult
  private func emitTraffic(_ source: String, _ status: Int, _ data: Data) -> String {
    guard let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return "" }
    let code = body["error"] as? String ?? ""
    guard let sink = onTraffic else { return code }
    let traffic = body["traffic"] as? [String: Any] ?? (body["frame"] as? [String: Any])?["traffic"] as? [String: Any]
    if code.isEmpty && traffic == nil { return code }
    let event: [String: Any] = [
      "source": source, "status": status, "code": code.isEmpty ? NSNull() : code, "traffic": traffic ?? NSNull(),
    ]
    PlaybackLog.info("traffic.event source=\(source) status=\(status) code=\(code)")
    sink(event)
    return code
  }

  private func endSessionBestEffort() {
    sessionLock.lock()
    let sid = sessionId
    let base = winnerBaseUrl
    sessionId = nil
    sessionLock.unlock()
    guard let sid, let base,
      let req = try? request(
        "\(base)/storage/tunnel/frame", json: ["sessionId": sid, "frame": ["kind": "session.end", "sessionId": sid]])
    else { return }
    // Fire and forget: the session is torn down with the proxy.
    http.dataTask(with: req).resume()
  }

  /// Forgets `sid` unless another fetch already replaced it, so concurrent fetches that all saw it gone open one session.
  private func dropSession(_ sid: String) {
    sessionLock.lock()
    if sessionId == sid { sessionId = nil }
    sessionLock.unlock()
  }

  // MARK: download

  /// A 404 `invalid_session` means the gateway forgot the session (it expired while the app slept or stayed paused past
  /// the session TTL, or the gateway restarted): the session is dropped, a new one opened and the download tried once
  /// more (STOR-GATEWAY-02, "the client opens a new one"). The same holds for every refusal a new session can fix — a
  /// 401, 403 or 410 and a 400 `session_not_started` — so a player read never fails on a stale session (PAR-PLAY-12,
  /// Chris 2026-11-27); any other status (a 404 `object_not_found`) fails at once.
  private func fetchRaw(_ key: String, renewed: Bool = false) throws -> Data {
    sessionLock.lock()
    let sid = sessionId
    let base = winnerBaseUrl
    let refreshDue = sid != nil && onTraffic != nil && Date().timeIntervalSince1970 - lastAckAt >= Self.ackRefreshSeconds
    if refreshDue { lastAckAt = Date().timeIntervalSince1970 }
    sessionLock.unlock()
    guard let sid else { throw TunnelError(message: "tunnel_session_not_active") }
    guard let base else { throw TunnelError(message: "tunnel_session_no_winner") }
    if refreshDue { refreshTraffic(base, sid) }
    let req = try request("\(base)/storage/tunnel/download", json: ["sessionId": sid, "objectKey": key])
    let start = Date().timeIntervalSince1970
    let (data, status) = try Self.send(req, on: http) { task in
      self.cacheLock.lock()
      self.tasks[key] = task
      if task != nil, self.pending[key]?.cancelled == true { task?.cancel() }
      self.cacheLock.unlock()
    }
    guard (200..<300).contains(status) else {
      let code = emitTraffic("download", status, data)
      if !renewed && Self.sessionRenewable(status, code) {
        dropSession(sid)
        PlaybackLog.warn("session.renew reason=\(status)/\(code.isEmpty ? "-" : code) sid=\(sid) key=\(key)")
        try ensureSession()
        return try fetchRaw(key, renewed: true)
      }
      throw TunnelError(message: "tunnel_download_failed: \(status) key=\(key) code=\(code.isEmpty ? "-" : code)")
    }
    NetworkMeter.shared.record(bytes: data.count, start: start, end: Date().timeIntervalSince1970)
    return data
  }

  /// Whether a download refused with `status` / `code` is worth one retry on a new session (see `fetchRaw`).
  static func sessionRenewable(_ status: Int, _ code: String) -> Bool {
    status == 401 || status == 403 || status == 410 || (status == 404 && code == "invalid_session")
      || (status == 400 && code == "session_not_started")
  }

  /// Fetches and decrypts `key`. Up to `spoolThresholdBytes` (an HLS segment) the plaintext is decrypted in memory for
  /// the LRU; a larger object (a subtitle sidecar) is decrypted piece by piece into `spool` and returned mapped,
  /// `spooled: true`, so it never sits in the heap next to the segment cache.
  private func fetchAndDecrypt(_ key: String) throws -> (data: Data, spooled: Bool) {
    let t0 = Date()
    let encrypted = try fetchRaw(key)
    let tunnelMs = Int(Date().timeIntervalSince(t0) * 1000)
    let t1 = Date()
    if encrypted.count > spoolThresholdBytes {
      let plaintext = try spool.spool(key, masterKey: masterKey, input: InputStream(data: encrypted))
      PlaybackLog.info(
        "object.tunnel_and_spool key=\(key) encryptedBytes=\(encrypted.count) plaintextBytes=\(plaintext.count) tunnelMs=\(tunnelMs) spoolMs=\(Int(Date().timeIntervalSince(t1) * 1000))"
      )
      return (plaintext, true)
    }
    onDownloaded?(encrypted.count, tunnelMs)
    let plaintext = try MediaCrypto.decryptSegment(masterKey: masterKey, encrypted: encrypted)
    let decryptMs = Int(Date().timeIntervalSince(t1) * 1000)
    PlaybackLog.debug(
      "object.tunnel_and_decrypt key=\(key) encryptedBytes=\(encrypted.count) plaintextBytes=\(plaintext.count) tunnelMs=\(tunnelMs) decryptMs=\(decryptMs)"
    )
    return (plaintext, false)
  }

  // MARK: sync HTTP

  /// Blocking request; only ever called from worker threads, never the main or the RN module queue. `track` is handed the
  /// task once it runs and nil once it ended, so a caller can cancel it midway.
  static func send(_ req: URLRequest, on session: URLSession, track: ((URLSessionDataTask?) -> Void)? = nil) throws -> (Data, Int) {
    let sem = DispatchSemaphore(value: 0)
    var out: (Data?, URLResponse?, Error?) = (nil, nil, nil)
    let task = session.dataTask(with: req) { d, r, e in
      out = (d, r, e)
      sem.signal()
    }
    track?(task)
    task.resume()
    sem.wait()
    track?(nil)
    if let e = out.2 { throw e }
    guard let http = out.1 as? HTTPURLResponse else { throw TunnelError(message: "tunnel_no_response") }
    return (out.0 ?? Data(), http.statusCode)
  }

  private static func snippet(_ data: Data) -> String {
    String(decoding: data.prefix(512), as: UTF8.self)
  }
}
