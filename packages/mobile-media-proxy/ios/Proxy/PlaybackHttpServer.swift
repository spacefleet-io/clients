import Foundation
import Network

/// 127.0.0.1 HTTP/1.1 server fronting the encrypted storage backend as a plain HLS source for libmpv, and as plain files
/// for an audio player (Parrot). Routes (same as the Android `PlaybackHttpServer`):
///   GET /playback/hls/{sessionId}/master.m3u8
///   GET /playback/hls/{sessionId}/master-{id}.m3u8   (one video variant + every audio/subs rendition)
///   GET /playback/hls/{sessionId}/video-{id}.m3u8, audio-{id}.m3u8, subs-{id}.m3u8
///   GET /playback/object/{key}                        (decrypted segment / init / VTT; Range supported)
///   GET /playback/chunked/{fileId}                    (a `ChunkedFile` registered by JS: ranges over 1 MiB chunks)
/// HEAD is answered on every route with the GET's status and headers and no body.
///
/// Built on Network.framework (`NWListener`), no third-party code. `Connection: close` on every response keeps the
/// connection lifetime trivial; fetch + decrypt run on a bounded worker queue so the listener never blocks.
final class PlaybackHttpServer {
  private static let workerThreads = 8
  private static let prefetchThreads = 4
  private static let maxHeaderBytes = 16 * 1024
  /// Largest stored object `readText` accepts: a text subtitle is a few hundred KB; anything bigger is not text.
  private static let maxTextBytes = 8 * 1024 * 1024

  private let fetcher: ChunkFetcher
  private var listener: NWListener?
  private(set) var port: UInt16 = 0
  private let netQueue = DispatchQueue(label: "PlaybackHttp.net")
  private let workers = OperationQueue()
  private let prefetchQueue = OperationQueue()
  private var prefetcher: SegmentPrefetcher!
  private let sessionsLock = NSLock()
  private var sessions: [String: HlsSession] = [:]
  /// Cast server only: the object keys of the sessions it was given (see `HlsSession.objectKeys`); unused on loopback.
  private var lanKeys = Set<String>()
  private let chunkedFiles = ChunkedFileRegistry()
  /// Loads the openings of the songs around the playing one while the player reads nothing (PAR-PLAY-07).
  private var preloader: NeighbourPreloader!
  /// Connection number for the logs (`connId=`); only touched on `netQueue`.
  private var connCounter = 0

  /// The cast server's way in (UX-TV-03): bound to the phone's Wi-Fi address, every path behind a one-time token.
  struct LanBinding {
    let address: String
    let token: String
  }

  private let lan: LanBinding?

  init(fetcher: ChunkFetcher, lan: LanBinding? = nil) {
    self.fetcher = fetcher
    self.lan = lan
    workers.name = "PlaybackHttp.workers"
    workers.maxConcurrentOperationCount = Self.workerThreads
    workers.qualityOfService = .userInitiated
    prefetchQueue.name = "PlaybackHttp.prefetch"
    prefetchQueue.maxConcurrentOperationCount = Self.prefetchThreads
    prefetchQueue.qualityOfService = .utility
    prefetcher = SegmentPrefetcher(fetcher: fetcher, queue: prefetchQueue)
    let files = chunkedFiles
    preloader = NeighbourPreloader(fetcher: fetcher, peek: { files.peek($0) })
  }

  /// Binds loopback on an ephemeral port (the cast server: its Wi-Fi IPv4 address); returns once the listener is ready.
  /// Loopback: the 127.0.0.1 endpoint is tried first, the loopback interface second (whichever Network.framework accepts on this OS).
  func start() throws {
    var attempts: [(String, () -> NWParameters)] = [
      ("endpoint", {
        let p = NWParameters.tcp
        p.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: .any)
        return p
      }),
      ("interface", {
        let p = NWParameters.tcp
        p.requiredInterfaceType = .loopback
        return p
      }),
    ]
    if let lan {
      // LAN: only the Wi-Fi IPv4 address itself. An address that does not parse is an error: falling back to "any
      // listener on the Wi-Fi interface" would also bind IPv6 and every address of the interface.
      guard let ip = IPv4Address(lan.address) else {
        throw TunnelError(message: "cast_lan_address_invalid")
      }
      attempts = [
        ("wifi-endpoint", {
          let p = NWParameters.tcp
          p.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(ip), port: .any)
          return p
        })
      ]
    }
    var lastError: Error = TunnelError(message: "playback_server_start_failed")
    for (name, makeParams) in attempts {
      do {
        try startListener(makeParams())
        PlaybackLog.info("started port=\(port) bind=\(name)")
        return
      } catch {
        lastError = error
        PlaybackLog.warn("start.failed bind=\(name) err=\(error.localizedDescription)")
      }
    }
    throw lastError
  }

  private func startListener(_ params: NWParameters) throws {
    let l = try NWListener(using: params)
    let ready = DispatchSemaphore(value: 0)
    var failure: Error?
    l.stateUpdateHandler = { [weak self] state in
      switch state {
      case .ready:
        self?.port = l.port?.rawValue ?? 0
        ready.signal()
      case .failed(let e):
        failure = e
        ready.signal()
      default:
        break
      }
    }
    l.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
    l.start(queue: netQueue)
    if ready.wait(timeout: .now() + 5) == .timedOut { l.cancel(); throw TunnelError(message: "playback_server_start_timeout") }
    if let failure { l.cancel(); throw failure }
    listener = l
  }

  func stop() {
    listener?.cancel()
    listener = nil
    workers.cancelAllOperations()
    preloader.stop()
    prefetchQueue.cancelAllOperations()
    sessionsLock.lock()
    sessions.removeAll()
    lanKeys.removeAll()
    sessionsLock.unlock()
    chunkedFiles.clear()
    fetcher.shutdown()
  }

  var baseUrl: String {
    if let lan { return "http://\(lan.address):\(port)/cast/\(lan.token)" }
    return "http://127.0.0.1:\(port)"
  }

  /// Text served instead of the stored bytes for an object key (a subtitle converted to WebVTT by the cast flow).
  private var textOverrides: [String: Data] = [:]

  func putText(key: String, body: String) {
    sessionsLock.lock()
    textOverrides[key] = Data(body.utf8)
    sessionsLock.unlock()
  }

  /// The decrypted bytes of a stored object as UTF-8 text (a subtitle file; never a media segment).
  func readText(key: String) throws -> String {
    let data = try fetcher.getObject(key)
    if data.count > Self.maxTextBytes { throw TunnelError(message: "text_object_too_large: \(data.count)") }
    return String(decoding: data, as: UTF8.self)
  }

  /// `/cast/<token>/rest` -> `/rest`, or nil when the token does not match (constant-time compare).
  private func stripToken(_ path: String) -> String? {
    guard let lan, path.hasPrefix("/cast/") else { return nil }
    let rest = path.dropFirst("/cast/".count)
    guard let slash = rest.firstIndex(of: "/") else { return nil }
    let given = Array(rest[..<slash].utf8)
    let expected = Array(lan.token.utf8)
    var diff = given.count ^ expected.count
    for i in 0..<expected.count { diff |= Int(expected[i] ^ (i < given.count ? given[i] : 0)) }
    return diff == 0 ? String(rest[slash...]) : nil
  }

  /// High-traffic playback buffer (STOR-BW-01): the look-ahead the proxy keeps; `TrafficBuffer.noCap` restores the normal one.
  func setBufferCap(_ seconds: Double) {
    prefetcher.setBufferCap(seconds)
    preloader.setBufferCap(seconds)
  }

  /// The silo's high-traffic state (STOR-BW-01) as the tunnel heard it: no next-song opening loads while it holds.
  func setTrafficHigh(_ high: Bool) {
    preloader.setTrafficHigh(high)
  }

  /// The registered ids of the song playing and the songs Next and Previous go to (PAR-PLAY-07).
  func setNeighbours(current: String?, next: String?, previous: String?) {
    preloader.setNeighbours(current: current, next: next, previous: previous)
  }

  func createSession(_ session: HlsSession) -> String {
    sessionsLock.lock()
    sessions[session.id] = session
    if lan != nil { lanKeys.formUnion(session.objectKeys) }
    sessionsLock.unlock()
    prefetcher.register(session)
    return "\(baseUrl)/playback/hls/\(session.id)/master.m3u8"
  }

  /// Serves `file` at the returned `/playback/chunked/{id}` URL; registering the same id again replaces it.
  func registerChunkedFile(_ file: ChunkedFile) -> String {
    chunkedFiles.register(file)
    return "\(baseUrl)/playback/chunked/\(file.id.addingPercentEncoding(withAllowedCharacters: Self.idUnreserved) ?? file.id)"
  }

  /// Serves `file` at its already registered id until the player first asks for it (PAR-PLAY-04); true when swapped.
  func swapChunkedFile(_ file: ChunkedFile) -> Bool { chunkedFiles.swap(file) }

  func unregisterChunkedFile(_ id: String) -> Bool { chunkedFiles.unregister(id) }

  /// What `URLEncoder.encode` leaves as is on Android (space aside, sent as `%20` on both).
  private static let idUnreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._*")

  // MARK: connection handling

  private struct Request {
    let method: String
    let path: String
    let range: String?
    let connId: Int
  }

  private func accept(_ conn: NWConnection) {
    connCounter += 1
    let connId = connCounter
    // A connection the player resets while a body piece is queued (a seek, a track or quality switch) goes to `.failed`
    // and never completes that piece, so `sendBody` never reaches its `cancel()`. Until it is cancelled, Network.framework
    // keeps the failed connection, the queued piece and the closure holding the whole segment: one segment leaked per
    // reset, and the Apple TV ran out of memory and froze (PERF-PLAY-03).
    conn.stateUpdateHandler = { [weak conn] state in
      if case .failed = state { conn?.cancel() }
    }
    conn.start(queue: netQueue)
    readRequest(conn, buffer: Data(), connId: connId)
  }

  private func readRequest(_ conn: NWConnection, buffer: Data, connId: Int) {
    conn.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, isComplete, error in
      guard let self else { conn.cancel(); return }
      var buf = buffer
      if let data { buf.append(data) }
      if let end = buf.range(of: Data([0x0d, 0x0a, 0x0d, 0x0a])) {
        let head = buf[buf.startIndex..<end.lowerBound]
        self.workers.addOperation { self.handle(conn, head: head, connId: connId) }
        return
      }
      if error != nil || isComplete || buf.count > Self.maxHeaderBytes {
        self.respond(conn, status: 400, contentType: "text/plain", body: Data())
        return
      }
      self.readRequest(conn, buffer: buf, connId: connId)
    }
  }

  private func parse(_ head: Data, connId: Int) -> Request? {
    let text = String(decoding: head, as: UTF8.self)
    var lines = text.components(separatedBy: "\r\n")
    guard !lines.isEmpty else { return nil }
    let parts = lines.removeFirst().split(separator: " ")
    guard parts.count >= 3 else { return nil }
    let target = String(parts[1])
    let path = target.firstIndex(of: "?").map { String(target[..<$0]) } ?? target
    var range: String?
    for line in lines {
      guard let sep = line.firstIndex(of: ":") else { continue }
      if line[..<sep].trimmingCharacters(in: .whitespaces).lowercased() == "range" {
        range = line[line.index(after: sep)...].trimmingCharacters(in: .whitespaces)
      }
    }
    return Request(method: String(parts[0]), path: path, range: range, connId: connId)
  }

  private func handle(_ conn: NWConnection, head: Data, connId: Int) {
    guard var req = parse(head, connId: connId) else {
      respond(conn, status: 400, contentType: "text/plain", body: Data())
      return
    }
    // On the LAN every path must start with the one-time token; anything else is a 404 that does not say why.
    if lan != nil {
      guard let stripped = stripToken(req.path) else {
        PlaybackLog.warn("request.rejected reason=bad_token")
        respond(conn, status: 404, contentType: "text/plain", body: Data())
        return
      }
      req = Request(method: req.method, path: stripped, range: req.range, connId: req.connId)
    }
    if req.method == "OPTIONS" && lan != nil {
      // CORS preflight (Cast receivers fetch playlists, segments and subtitles cross-origin).
      respond(conn, status: 204, contentType: "text/plain", body: Data())
      return
    }
    PlaybackLog.debug("request connId=\(req.connId) method=\(req.method) path=\(req.path) range=\(req.range ?? "-")")
    guard req.method == "GET" || req.method == "HEAD" else {
      respond(conn, status: 405, contentType: "text/plain", body: Data())
      return
    }
    let headOnly = req.method == "HEAD"
    if req.path.hasPrefix("/playback/hls/") {
      handlePlaylist(conn, path: req.path, headOnly: headOnly)
    } else if req.path.hasPrefix("/playback/object/") {
      handleObject(conn, path: req.path, rangeHeader: req.range, headOnly: headOnly)
    } else if req.path.hasPrefix("/playback/chunked/") {
      handleChunked(conn, path: req.path, rangeHeader: req.range, headOnly: headOnly, connId: req.connId)
    } else {
      respond(conn, status: 404, contentType: "text/plain", body: Data())
    }
  }

  private func handlePlaylist(_ conn: NWConnection, path: String, headOnly: Bool) {
    let parts = String(path.dropFirst("/playback/hls/".count)).split(separator: "/").map(String.init)
    guard parts.count >= 2 else { return respond(conn, status: 404, contentType: "text/plain", body: Data()) }
    sessionsLock.lock()
    let session = sessions[parts[0]]
    sessionsLock.unlock()
    guard let session else { return respond(conn, status: 404, contentType: "text/plain", body: Data()) }
    let playlist = parts[1]
    let base = baseUrl

    func strip(_ prefix: String) -> String {
      String(playlist.dropFirst(prefix.count)).replacingOccurrences(of: ".m3u8", with: "")
    }

    let body: String
    if playlist == "master.m3u8" {
      body = PlaylistBuilder.buildMasterPlaylist(session: session, baseUrl: base)
    } else if playlist.hasPrefix("master-") {
      let id = strip("master-")
      guard session.videos.contains(where: { $0.id == id }) else {
        return respond(conn, status: 404, contentType: "text/plain", body: Data())
      }
      body = PlaylistBuilder.buildMasterPlaylist(session: session, baseUrl: base, onlyVideoId: id)
    } else if playlist.hasPrefix("video-") {
      let id = strip("video-")
      guard let v = session.videos.first(where: { $0.id == id }) else {
        return respond(conn, status: 404, contentType: "text/plain", body: Data())
      }
      body = PlaylistBuilder.buildTrackPlaylist(track: v.track, baseUrl: base, mode: session.mode)
    } else if playlist.hasPrefix("audio-") {
      let id = strip("audio-")
      guard let a = session.audio.first(where: { $0.id == id }) else {
        return respond(conn, status: 404, contentType: "text/plain", body: Data())
      }
      body = PlaylistBuilder.buildTrackPlaylist(track: a.track, baseUrl: base, mode: session.mode)
    } else if playlist.hasPrefix("subs-") {
      let id = strip("subs-")
      guard let s = session.subtitles.first(where: { $0.id == id }), s.format == "vtt" else {
        return respond(conn, status: 404, contentType: "text/plain", body: Data())
      }
      body = PlaylistBuilder.buildSubtitlePlaylist(sub: s, baseUrl: base, mode: session.mode)
    } else {
      return respond(conn, status: 404, contentType: "text/plain", body: Data())
    }
    respond(conn, status: 200, contentType: "application/vnd.apple.mpegurl", body: Data(body.utf8), headOnly: headOnly)
  }

  private func handleObject(_ conn: NWConnection, path: String, rangeHeader: String?, headOnly: Bool) {
    let rawKey = String(path.dropFirst("/playback/object/".count))
    let key = rawKey.removingPercentEncoding ?? rawKey
    let t0 = Date()
    let payload: Data
    sessionsLock.lock()
    let overridden = textOverrides[key]
    let allowed = lan == nil || overridden != nil || lanKeys.contains(key)
    sessionsLock.unlock()
    // The cast address carries the user's tunnel credentials: it serves the objects of its own session only.
    guard allowed else {
      PlaybackLog.warn("object.rejected reason=key_not_in_session")
      return respond(conn, status: 404, contentType: "text/plain", body: Data())
    }
    do {
      if let overridden {
        payload = overridden
      } else {
        prefetcher.onRequest(key)
        payload = try fetcher.getObject(key)
      }
    } catch {
      PlaybackLog.error("object.fetch.error key=\(key) err=\(error.localizedDescription)")
      return respond(conn, status: 502, contentType: "text/plain", body: Data())
    }
    PlaybackLog.debug("object.fetch.done key=\(key) bytes=\(payload.count) elapsedMs=\(Int(Date().timeIntervalSince(t0) * 1000))")

    let contentType = Self.contentType(for: key)
    switch Self.parseRange(rangeHeader, total: payload.count) {
    case .none:
      respond(conn, status: 200, contentType: contentType, body: payload, headOnly: headOnly)
    case .invalid:
      respond(
        conn, status: 416, contentType: "text/plain", body: Data(),
        extraHeaders: ["Content-Range": "bytes */\(payload.count)"])
    case .slice(let start, let end):
      // A view, not a copy: for a spooled sidecar this stays on the mapped file.
      let slice = payload[(payload.startIndex + start)...(payload.startIndex + end)]
      respond(
        conn, status: 206, contentType: contentType, body: slice, headOnly: headOnly,
        extraHeaders: ["Content-Range": "bytes \(start)-\(end)/\(payload.count)"])
    }
    prefetcher.onServed(key)
  }

  /// `/playback/chunked/{id}`: the byte range the player asked for, assembled from the decrypted chunks it covers
  /// (PAR-FMT-01). Runs on a worker thread and writes synchronously, one chunk at a time, so at most one decrypted
  /// chunk is held per connection. The first chunk is opened before the status line, so a fetch failure is still a
  /// clean 502; each chunk's successor is warmed on the prefetch queue while it is written, so a steady player never
  /// waits on the network between chunks. A failure after the headers drops the connection (the player retries from
  /// where it got to). Port of the Kotlin `handleChunked`: change them together.
  private func handleChunked(_ conn: NWConnection, path: String, rangeHeader: String?, headOnly: Bool, connId: Int) {
    let rawId = String(path.dropFirst("/playback/chunked/".count))
    let id = rawId.removingPercentEncoding ?? rawId
    guard let file = chunkedFiles.serve(id) else {
      PlaybackLog.warn("chunked.unknown connId=\(connId) id=\(id)")
      return respond(conn, status: 404, contentType: "text/plain", body: Data())
    }
    let total = file.sizeBytes
    let range = HttpRange.parse(rangeHeader, total: total)
    if range.invalid {
      PlaybackLog.warn("chunked.range_invalid connId=\(connId) id=\(id) range=\(rangeHeader ?? "-") size=\(total)")
      return respond(
        conn, status: 416, contentType: "text/plain", body: Data(), extraHeaders: ["Content-Range": "bytes */\(total)"])
    }
    let slices: [ChunkSlice]
    do {
      slices = try file.slices(start: range.start, endInclusive: range.end)
    } catch {
      PlaybackLog.error("chunked.slices.error connId=\(connId) id=\(id) err=\(error.localizedDescription)")
      return respond(conn, status: 416, contentType: "text/plain", body: Data(), extraHeaders: ["Content-Range": "bytes */\(total)"])
    }
    guard let first = slices.first, let lastSlice = slices.last else {
      return respond(conn, status: 416, contentType: "text/plain", body: Data(), extraHeaders: ["Content-Range": "bytes */\(total)"])
    }
    PlaybackLog.debug(
      "chunked.request connId=\(connId) id=\(id) range=\(range.start)-\(range.end)/\(total) chunks=\(first.index)..\(lastSlice.index) head=\(headOnly)")
    let t0 = Date()
    var body = Data()
    if !headOnly {
      do {
        body = try openChunk(file, first.index)
      } catch {
        PlaybackLog.error("chunked.fetch.error connId=\(connId) id=\(id) chunk=\(first.index) err=\(error.localizedDescription)")
        return respond(conn, status: 502, contentType: "text/plain", body: Data())
      }
    }
    let sliceLen = range.end - range.start + 1
    var head = range.isRange
      ? "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes \(range.start)-\(range.end)/\(total)\r\n"
      : "HTTP/1.1 200 OK\r\n"
    head += "Content-Type: \(file.mime)\r\nContent-Length: \(sliceLen)\r\nAccept-Ranges: bytes\r\nConnection: close\r\n"
    if lan != nil {
      head += "Access-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range\r\n"
    }
    head += "\r\n"
    if headOnly {
      conn.send(content: Data(head.utf8), contentContext: .defaultMessage, isComplete: true, completion: .contentProcessed { _ in conn.cancel() })
      return
    }
    // Same message context for head and every body piece (see `respond`); isComplete only on the very last piece.
    guard Self.sendSync(conn, Data(head.utf8), isComplete: false) else {
      PlaybackLog.warn("chunked.send.failed connId=\(connId) id=\(id) phase=head")
      conn.cancel()
      return
    }
    for (n, slice) in slices.enumerated() {
      do {
        if n > 0 { body = try openChunk(file, slice.index) }
      } catch {
        PlaybackLog.error("chunked.fetch.error connId=\(connId) id=\(id) chunk=\(slice.index) afterHeaders=true err=\(error.localizedDescription)")
        conn.cancel()
        return
      }
      prefetchChunk(file, slice.index + 1)
      let from = body.startIndex + slice.offsetInChunk
      let to = from + slice.length
      var pos = from
      while pos < to {
        let end = min(pos + Self.sendPieceBytes, to)
        let isLast = end == to && n == slices.count - 1
        guard Self.sendSync(conn, body[pos..<end], isComplete: isLast) else {
          PlaybackLog.warn("chunked.send.failed connId=\(connId) id=\(id) chunk=\(slice.index) phase=body")
          conn.cancel()
          return
        }
        pos = end
      }
    }
    conn.cancel()
    PlaybackLog.debug(
      "chunked.served connId=\(connId) id=\(id) bytes=\(sliceLen) chunks=\(slices.count) elapsedMs=\(Int(Date().timeIntervalSince(t0) * 1000))")
  }

  /// Decrypted chunk `index` of `file`, checked against the size the library recorded for it.
  private func openChunk(_ file: ChunkedFile, _ index: Int) throws -> Data {
    let chunk = file.chunks[index]
    let data = try preloader.playerRead(chunk.objectKey) { try fetcher.getObject(chunk.objectKey) }
    if data.count != chunk.plainSize {
      throw TunnelError(
        message: "chunk_size_mismatch id=\(file.id) chunk=\(index) key=\(chunk.objectKey) got=\(data.count) want=\(chunk.plainSize)")
    }
    return data
  }

  private func prefetchChunk(_ file: ChunkedFile, _ index: Int) {
    guard index >= 0, index < file.chunks.count else { return }
    let key = file.chunks[index].objectKey
    let fetcher = self.fetcher
    let preloader = self.preloader!
    prefetchQueue.addOperation {
      do {
        try preloader.playerRead(key) { try fetcher.prefetch(key) }
      } catch {
        PlaybackLog.debug("chunked.prefetch.failed id=\(file.id) chunk=\(index) msg=\(error.localizedDescription)")
      }
    }
  }

  /// Queues `data` on `conn` and blocks this worker thread until it is processed; false on a send error. Only for
  /// worker threads: the completion runs on `netQueue`.
  private static func sendSync(_ conn: NWConnection, _ data: Data, isComplete: Bool) -> Bool {
    let done = DispatchSemaphore(value: 0)
    var failed = false
    conn.send(
      content: data, contentContext: .defaultMessage, isComplete: isComplete,
      completion: .contentProcessed { error in
        failed = error != nil
        done.signal()
      })
    done.wait()
    return !failed
  }

  // MARK: helpers

  private static func contentType(for key: String) -> String {
    let lower = key.lowercased()
    if lower.hasSuffix(".vtt") { return "text/vtt; charset=utf-8" }
    if lower.hasSuffix(".m3u8") { return "application/vnd.apple.mpegurl" }
    if lower.hasSuffix(".mkv") { return "video/x-matroska" }
    return "video/mp4"  // init + media segments (fMP4); AVFoundation is strict about HLS segment types
  }

  private enum RangeSpec {
    case none
    case invalid
    case slice(Int, Int)
  }

  private static func parseRange(_ header: String?, total: Int) -> RangeSpec {
    guard let header, !header.isEmpty,
      let m = header.range(of: "bytes=(\\d+)-(\\d*)", options: .regularExpression)
    else { return .none }
    let spec = header[m].dropFirst("bytes=".count).split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
    guard spec.count == 2, let start = Int(spec[0]) else { return .invalid }
    var end = Int(spec[1]) ?? total - 1
    if start > end || start >= total { return .invalid }
    if end >= total { end = total - 1 }
    return .slice(start, end)
  }

  private func respond(
    _ conn: NWConnection, status: Int, contentType: String, body: Data, headOnly: Bool = false,
    extraHeaders: [String: String] = [:]
  ) {
    let text: String
    switch status {
    case 200: text = "OK"
    case 204: text = "No Content"
    case 206: text = "Partial Content"
    case 400: text = "Bad Request"
    case 404: text = "Not Found"
    case 405: text = "Method Not Allowed"
    case 416: text = "Range Not Satisfiable"
    case 502: text = "Bad Gateway"
    default: text = "Internal Server Error"
    }
    let cors =
      lan == nil ? "" :
      "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Range, Content-Type\r\nAccess-Control-Allow-Methods: GET, OPTIONS\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range\r\n"
    var head = "HTTP/1.1 \(status) \(text)\r\nContent-Type: \(contentType)\r\nContent-Length: \(body.count)\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\(cors)"
    for (k, v) in extraHeaders { head += "\(k): \(v)\r\n" }
    head += "\r\n"
    // Head and body MUST share one message context: a partial `.defaultMessage` (isComplete: false) blocks any
    // later send on a different context (`.finalMessage`), so the body was never flushed and the player timed out.
    // `Connection: close` + cancel() after the last chunk is processed ends the stream.
    if headOnly || body.isEmpty {
      conn.send(content: Data(head.utf8), contentContext: .defaultMessage, isComplete: true, completion: .contentProcessed { _ in conn.cancel() })
    } else {
      conn.send(content: Data(head.utf8), contentContext: .defaultMessage, isComplete: false, completion: .contentProcessed { _ in })
      Self.sendBody(conn, body, from: body.startIndex)
    }
  }

  /// Sends `body` in `sendPieceBytes` pieces, each queued once the previous one is processed, so a spooled sidecar
  /// (a mapped file) is never copied whole into the connection's buffers.
  private static func sendBody(_ conn: NWConnection, _ body: Data, from: Data.Index) {
    let end = min(from + sendPieceBytes, body.endIndex)
    let last = end == body.endIndex
    conn.send(
      content: body[from..<end], contentContext: .defaultMessage, isComplete: last,
      completion: .contentProcessed { error in
        if last || error != nil {
          conn.cancel()
        } else {
          sendBody(conn, body, from: end)
        }
      })
  }

  private static let sendPieceBytes = 1024 * 1024
}
