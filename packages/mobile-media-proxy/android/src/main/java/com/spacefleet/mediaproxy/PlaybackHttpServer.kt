package com.spacefleet.mediaproxy

import android.util.Log
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStream
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ExecutorService
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Where and behind what a [PlaybackHttpServer] listens when it feeds a cast target instead of the local player: the phone's
 * Wi-Fi [address] and the one-time [token] every request path must start with (`/cast/<token>/...`). The token is minted
 * by the JS side (castToken.ts) and is the only thing standing between the local network and the decrypted film.
 */
class LanBinding(val address: InetAddress, val token: String)

/**
 * 127.0.0.1 HTTP server that fronts the encrypted storage backend as a plain
 * HLS source for libmpv. Routes:
 *   GET /playback/hls/{sessionId}/master.m3u8
 *   GET /playback/hls/{sessionId}/master-{id}.m3u8   (one video variant + all audio/subs: the app-picked rung)
 *   GET /playback/hls/{sessionId}/video-{id}.m3u8
 *   GET /playback/hls/{sessionId}/audio-{id}.m3u8
 *   GET /playback/hls/{sessionId}/subs-{id}.m3u8     (WebVTT subtitle playlist)
 *   GET /playback/object/{key}
 *   GET /playback/chunked/{fileId}                   (a [ChunkedFile] registered by JS: ranges over 1 MiB chunks)
 *
 * The crucial bit is native: chunk fetch + AES-GCM decrypt + TCP socket
 * writes all run on the server's thread pool, so the JS thread is genuinely
 * free during the playback hot path.
 *
 * Object Content-Type is sniffed from the key suffix: `.vtt` → `text/vtt`,
 * everything else → `application/octet-stream`. The SFV1 magic check inside
 * MediaCrypto.decryptSegment is pass-through for non-encrypted bodies, so
 * plaintext VTT files round-trip unchanged.
 *
 * Implementation note: we hand-roll a tiny HTTP/1.1 server on top of
 * java.net.ServerSocket rather than pulling in NanoHTTPD or
 * com.sun.net.httpserver (the latter isn't on the Android SDK). Scope is
 * narrow — we only serve the routes above, only handle GET, only support
 * `Range: bytes=N-M` — so the HTTP parser is kept intentionally minimal.
 * Connection: close on every response keeps lifetime trivial.
 *
 * Range support: parses `Range: bytes=N-M` and returns 206 with a proper
 * `Content-Range`. mpv's lavf HLS demuxer doesn't usually issue range
 * requests against fmp4 segments, but it does for byte-served playlists
 * and Android's MediaCodec stack sometimes range-fetches the init segment.
 *
 * The chunk-fetch backend is abstracted via [ChunkFetcher]; the only
 * implementation is StorageTunnelClient.
 */
class PlaybackHttpServer(
  private val chunkFetcher: ChunkFetcher,
  /** Non-null: a cast server on the phone's Wi-Fi address behind a one-time token. Null: the loopback player proxy. */
  private val lan: LanBinding? = null,
) {
  private var server: ServerSocket? = null
  private var port: Int = 0
  private val sessions = ConcurrentHashMap<String, HlsSession>()
  private val chunkedFiles = ChunkedFileRegistry()
  private val connCounter = AtomicInteger(0)
  private val running = AtomicBoolean(false)
  private var acceptThread: Thread? = null
  private lateinit var pool: ExecutorService
  private lateinit var prefetchPool: ExecutorService
  private lateinit var prefetcher: SegmentPrefetcher
  private lateinit var preloader: NeighbourPreloader

  fun start(): Int {
    val s = ServerSocket(0, 64, lan?.address ?: InetAddress.getByName("127.0.0.1"))
    server = s
    port = s.localPort
    // Generous thread pool so concurrent video+audio segment fetches don't
    // queue. Decrypt is native + parallel (cheap on this side).
    pool = Executors.newFixedThreadPool(8)
    // Read-ahead gets its own small pool so it can never starve the threads serving mpv's own requests.
    prefetchPool = Executors.newFixedThreadPool(PREFETCH_THREADS) { r ->
      Thread(r, "PlaybackHttp-prefetch").apply { isDaemon = true }
    }
    prefetcher = SegmentPrefetcher(chunkFetcher, prefetchPool)
    preloader = NeighbourPreloader(chunkFetcher, chunkedFiles::peek)
    running.set(true)
    acceptThread = Thread({ acceptLoop(s) }, "PlaybackHttp-accept").apply {
      isDaemon = true
      start()
    }
    Log.i(TAG, "started port=$port")
    return port
  }

  fun stop() {
    running.set(false)
    try { server?.close() } catch (_: Throwable) {}
    try { pool.shutdownNow() } catch (_: Throwable) {}
    try { prefetchPool.shutdownNow() } catch (_: Throwable) {}
    try { preloader.stop() } catch (_: Throwable) {}
    sessions.clear()
    lanKeys.clear()
    chunkedFiles.clear()
    decoderOptions.keys.removeAll { it.startsWith(baseUrl()) }
    chunkFetcher.shutdown()
    server = null
  }

  /** High-traffic playback buffer (STOR-BW-01): the look-ahead the proxy keeps; [TrafficBuffer.NO_CAP] restores the normal one. */
  fun setBufferCap(seconds: Double) {
    prefetcher.bufferCapSeconds = seconds
    preloader.setBufferCap(seconds)
  }

  /** The silo's high-traffic state as the tunnel hears it (STOR-BW-01): no next-song opening is loaded ahead while high. */
  fun setTrafficHigh(high: Boolean) {
    preloader.setTrafficHigh(high)
  }

  /**
   * The playing, next and previous queue entries (registered chunked-file ids, null where none): their openings stay
   * cached and the missing ones load while the player is idle (PAR-PLAY-07, [NeighbourPreloader]).
   */
  fun setNeighbours(current: String?, next: String?, previous: String?) {
    preloader.setNeighbours(current, next, previous)
  }

  /** Make-before-break rung switch: see [SegmentPrefetcher.beginSwitch]. */
  fun beginRungSwitch(variantId: String, atSeconds: Double, onDone: (Throwable?) -> Unit): Boolean =
    prefetcher.beginSwitch(variantId, atSeconds, onDone)

  fun baseUrl(): String = if (lan != null) "http://${lan.address.hostAddress}:$port/cast/${lan.token}" else "http://127.0.0.1:$port"

  /** Text served instead of the stored bytes for an object key (a subtitle converted to WebVTT by the cast flow). */
  private val textOverrides = ConcurrentHashMap<String, ByteArray>()

  fun putText(key: String, body: String) {
    textOverrides[key] = body.toByteArray(Charsets.UTF_8)
  }

  /** The decrypted bytes of a stored object as UTF-8 text (a subtitle file; never a media segment). */
  fun readText(key: String): String {
    val body = chunkFetcher.openObject(key)
    try {
      if (body.length > MAX_TEXT_BYTES) throw IOException("text_object_too_large: ${body.length}")
      val out = java.io.ByteArrayOutputStream(body.length.toInt())
      body.writeTo(out, 0, body.length)
      return out.toString(Charsets.UTF_8.name())
    } finally {
      body.release()
    }
  }

  /** `/cast/<token>/rest` -> `/rest`, or null when the token does not match (constant-time compare). */
  private fun stripToken(path: String): String? {
    val rest = path.removePrefix("/cast/").takeIf { it.length != path.length } ?: return null
    val slash = rest.indexOf('/')
    if (slash < 0) return null
    val given = rest.substring(0, slash).toByteArray(Charsets.ISO_8859_1)
    val expected = lan!!.token.toByteArray(Charsets.ISO_8859_1)
    if (!java.security.MessageDigest.isEqual(given, expected)) return null
    return rest.substring(slash)
  }

  private fun corsHeaders(): String =
    if (lan == null) ""
    else "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Range, Content-Type\r\nAccess-Control-Allow-Methods: GET, OPTIONS\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range\r\n"

  /** Cast server only: the object keys of the sessions it was given (see [LanAllowList]); empty and unused on loopback. */
  private val lanKeys = ConcurrentHashMap.newKeySet<String>()

  /** [warmFromSeconds]: where the player will start (a cast's resume point), so the warmed segments are the ones it asks for first. */
  fun createSession(session: HlsSession, warmFromSeconds: Double = 0.0): String {
    sessions[session.id] = session
    if (lan != null) lanKeys.addAll(LanAllowList.keysOf(session))
    prefetcher.register(session, warmFromSeconds)
    if (lan == null) registerDecoderOptions(session)
    return "${baseUrl()}/playback/hls/${session.id}/master.m3u8"
  }

  /** Serves [file] at the returned `/playback/chunked/{id}` URL; registering the same id again replaces it. */
  fun registerChunkedFile(file: ChunkedFile): String {
    chunkedFiles.register(file)
    return "${baseUrl()}/playback/chunked/${URLEncoder.encode(file.id, "UTF-8").replace("+", "%20")}"
  }

  /**
   * Serves [file] at its already registered id instead of the file registered there, unless the player already asked for
   * that id: a song's copy is chosen until it starts loading, never during it (PAR-PLAY-04). True when swapped.
   */
  fun swapChunkedFile(file: ChunkedFile): Boolean = chunkedFiles.swap(file)

  fun unregisterChunkedFile(id: String): Boolean = chunkedFiles.unregister(id)

  /**
   * Per-file mpv options for the decoder of each playlist mpv may load (see [perFileDecoderOptions]):
   * `master-{id}.m3u8` gets the MediaCodec operating rate of that variant; `master.m3u8` (mpv picks the variant) the lowest
   * rate of all variants, and none unless every variant has one.
   *
   * The library does not store a version's pixel size yet, so a variant without width/height counts at its quality label's
   * nominal 16:9 size (`1080p` -> 1920x1080), as the JS decoder probe does (`decoderCaps.ts` `variantProbe`). That is never
   * smaller than the real (letterboxed) frame, so the rate is one the decoder accepts.
   */
  private fun registerDecoderOptions(session: HlsSession) {
    val base = "${baseUrl()}/playback/hls/${session.id}"
    val rates = session.videos.map { video ->
      val height = video.height ?: QUALITY_HEIGHT.find(video.quality)?.groupValues?.get(1)?.toInt() ?: 1080
      val width = video.width ?: (Math.round(height * 16.0 / 9.0 / 2.0) * 2).toInt()
      val rate = MediaProxyHooks.operatingRate?.invoke(video.track.codecString, width, height)
      Log.i(TAG, "decoder.rate session=${session.id} video=${video.id} quality=${video.quality} codec=${video.track.codecString} size=${width}x$height rate=${rate ?: "none"}")
      if (rate != null) decoderOptions["$base/master-${video.id}.m3u8"] = "vd-lavc-o=operating_rate=$rate"
      rate
    }
    if (rates.isNotEmpty() && rates.all { it != null }) {
      decoderOptions["$base/master.m3u8"] = "vd-lavc-o=operating_rate=${rates.filterNotNull().min()}"
    }
    Log.i(TAG, "decoder.options session=${session.id} ${decoderOptions.filterKeys { it.startsWith(base) }.entries.joinToString(" ") { "${it.key.substringAfterLast('/')}:${it.value}" }}")
  }

  private fun acceptLoop(serverSocket: ServerSocket) {
    while (running.get()) {
      try {
        val client = serverSocket.accept()
        client.tcpNoDelay = true
        pool.submit { handleClient(client) }
      } catch (e: IOException) {
        if (running.get()) Log.w(TAG, "accept.error", e)
      }
    }
  }

  private fun handleClient(socket: Socket) {
    val connId = connCounter.incrementAndGet()
    try {
      socket.use { sock ->
        val input = sock.getInputStream()
        val output = sock.getOutputStream()
        val parsed = parseRequest(input)
        if (parsed == null) {
          writeStatusLineAndClose(output, 400, "text/plain", ByteArray(0))
          return
        }
        // On the LAN every path must start with the one-time token; anything else is a 404 that does not say why.
        val req = if (lan == null) parsed else {
          val stripped = stripToken(parsed.path)
          if (stripped == null) {
            Log.w(TAG, "request.rejected connId=$connId reason=bad_token")
            writeStatusLineAndClose(output, 404, "text/plain", ByteArray(0))
            return
          }
          parsed.copy(path = stripped)
        }
        Log.d(
          TAG,
          "request.received connId=$connId method=${req.method} path=${req.path} range=${req.range}"
        )

        if (req.method == "OPTIONS" && lan != null) {
          // CORS preflight (Cast receivers fetch playlists, segments and subtitles cross-origin).
          writeStatusLineAndClose(output, 204, "text/plain", ByteArray(0))
          return
        }
        if (req.method != "GET") {
          writeStatusLineAndClose(output, 405, "text/plain", ByteArray(0))
          return
        }

        try {
          when {
            req.path.startsWith("/playback/hls/") ->
              handlePlaylist(output, req.path)
            req.path.startsWith("/playback/object/") ->
              handleObject(output, req.path, req.range, connId)
            req.path.startsWith("/playback/chunked/") ->
              handleChunked(output, req.path, req.range, connId)
            else ->
              writeStatusLineAndClose(output, 404, "text/plain", ByteArray(0))
          }
        } catch (e: Throwable) {
          Log.e(TAG, "request.error connId=$connId path=${req.path}", e)
          try {
            writeStatusLineAndClose(output, 500, "text/plain", ByteArray(0))
          } catch (_: Throwable) {
          }
        }
      }
    } catch (e: Throwable) {
      // Likely client closed mid-request (mpv aborts on seek). Logged at
      // debug — these are normal lifecycle events.
      Log.d(TAG, "client.io connId=$connId msg=${e.message}")
    }
  }

  private data class ParsedRequest(
    val method: String,
    val path: String,
    val query: String,
    val range: String?,
  )

  private fun parseRequest(input: InputStream): ParsedRequest? {
    val reader = BufferedReader(InputStreamReader(input, Charsets.ISO_8859_1))
    val statusLine = reader.readLine() ?: return null
    val parts = statusLine.split(" ")
    if (parts.size < 3) return null
    val method = parts[0]
    val target = parts[1]
    val (path, query) = if (target.contains('?')) {
      val q = target.indexOf('?')
      target.substring(0, q) to target.substring(q + 1)
    } else {
      target to ""
    }
    var range: String? = null
    while (true) {
      val line = reader.readLine() ?: break
      if (line.isEmpty()) break
      val sep = line.indexOf(':')
      if (sep < 0) continue
      val name = line.substring(0, sep).trim().lowercase(Locale.ROOT)
      val value = line.substring(sep + 1).trim()
      if (name == "range") range = value
    }
    return ParsedRequest(method, path, query, range)
  }

  private fun handlePlaylist(
    output: OutputStream,
    path: String,
  ) {
    val parts = path.removePrefix("/playback/hls/").split("/")
    if (parts.size < 2) {
      writeStatusLineAndClose(output, 404, "text/plain", ByteArray(0))
      return
    }
    val sessionId = parts[0]
    val playlist = parts[1]
    val session = sessions[sessionId]
    if (session == null) {
      writeStatusLineAndClose(output, 404, "text/plain", ByteArray(0))
      return
    }

    val body: String = when {
      playlist == "master.m3u8" ->
        PlaylistBuilder.buildMasterPlaylist(session, baseUrl())

      playlist.startsWith("master-") -> {
        val id = playlist.removePrefix("master-").removeSuffix(".m3u8")
        if (session.videos.none { it.id == id }) {
          writeStatusLineAndClose(output, 404, "text/plain", ByteArray(0))
          return
        }
        PlaylistBuilder.buildMasterPlaylist(session, baseUrl(), onlyVideoId = id)
      }

      playlist.startsWith("video-") -> {
        val id = playlist.removePrefix("video-").removeSuffix(".m3u8")
        val track = session.videos.firstOrNull { it.id == id }
        if (track == null) {
          writeStatusLineAndClose(output, 404, "text/plain", ByteArray(0))
          return
        }
        PlaylistBuilder.buildTrackPlaylist(track.track, baseUrl(), session.mode)
      }

      playlist.startsWith("audio-") -> {
        val id = playlist.removePrefix("audio-").removeSuffix(".m3u8")
        val track = session.audio.firstOrNull { it.id == id }
        if (track == null) {
          writeStatusLineAndClose(output, 404, "text/plain", ByteArray(0))
          return
        }
        PlaylistBuilder.buildTrackPlaylist(track.track, baseUrl(), session.mode)
      }

      playlist.startsWith("subs-") -> {
        // VTT subtitle playlist — single-segment, no init, points at the
        // plaintext VTT under /playback/object/. Only emitted for vtt; PGS
        // subs are loaded sidecar from JS and never reach this route.
        val id = playlist.removePrefix("subs-").removeSuffix(".m3u8")
        val sub = session.subtitles.firstOrNull { it.id == id }
        if (sub == null || sub.format != "vtt") {
          writeStatusLineAndClose(output, 404, "text/plain", ByteArray(0))
          return
        }
        PlaylistBuilder.buildSubtitlePlaylist(sub, baseUrl(), session.mode)
      }

      else -> {
        writeStatusLineAndClose(output, 404, "text/plain", ByteArray(0))
        return
      }
    }
    writeStatusLineAndClose(output, 200, "application/vnd.apple.mpegurl", body.toByteArray(Charsets.UTF_8))
  }

  private fun handleObject(
    output: OutputStream,
    path: String,
    rangeHeader: String?,
    connId: Int,
  ) {
    val rawKey = path.removePrefix("/playback/object/")
    val key = URLDecoder.decode(rawKey, "UTF-8")
    val fetchStart = System.currentTimeMillis()
    val override = textOverrides[key]
    if (lan != null && override == null && key !in lanKeys) {
      Log.w(TAG, "request.rejected connId=$connId reason=key_not_in_session")
      writeStatusLineAndClose(output, 404, "text/plain", ByteArray(0))
      return
    }
    // The old player's read-ahead during a rung switch waits for the switch, and once it landed is never fetched.
    if (override == null && prefetcher.holdLeftBehind(key)) {
      Log.d(TAG, "request.dropped connId=$connId reason=left_behind slot=${prefetcher.describe(key)}")
      writeStatusLineAndClose(output, 503, "text/plain", ByteArray(0))
      return
    }
    val payload: ObjectBody = try {
      if (override != null) {
        ObjectBody.InMemory(MediaCrypto.Plaintext(override, 0, override.size))
      } else {
        prefetcher.onRequest(key)
        chunkFetcher.openObject(key)
      }
    } catch (e: Throwable) {
      Log.e(TAG, "object.fetch.error connId=$connId key=$key", e)
      writeStatusLineAndClose(output, 502, "text/plain", ByteArray(0))
      return
    }
    Log.d(
      TAG,
      "object.fetch.done connId=$connId slot=${prefetcher.describe(key)} key=$key bytes=${payload.length} spooled=${payload is ObjectBody.Spooled} elapsedMs=${System.currentTimeMillis() - fetchStart}"
    )

    try {
      val total = payload.length
      val contentType = sniffContentType(key)
      val range = HttpRange.parse(rangeHeader, total)
      if (range.invalid) {
        writeStatusLineAndClose(output, 416, "text/plain", ByteArray(0))
        return
      }
      val sliceLen = range.end - range.start + 1
      val headers = StringBuilder()
      if (range.isRange) {
        headers
          .append("HTTP/1.1 206 Partial Content\r\n")
          .append("Content-Type: $contentType\r\n")
          .append("Content-Length: $sliceLen\r\n")
          .append("Content-Range: bytes ${range.start}-${range.end}/$total\r\n")
      } else {
        headers
          .append("HTTP/1.1 200 OK\r\n")
          .append("Content-Type: $contentType\r\n")
          .append("Content-Length: $total\r\n")
      }
      headers
        .append("Accept-Ranges: bytes\r\n")
        .append(corsHeaders())
        .append("Connection: close\r\n")
        .append("\r\n")
      output.write(headers.toString().toByteArray(Charsets.ISO_8859_1))
      if (sliceLen > 0) payload.writeTo(output, range.start, sliceLen)
      output.flush()
    } finally {
      payload.release()
    }
    prefetcher.onServed(key)
  }

  /**
   * A registered [ChunkedFile]: the range (or the whole file) is cut into [ChunkFetcher] objects with [ChunkedFile.slices].
   * The first chunk is opened before the status line, so a fetch failure is still a clean 502; each chunk's successor is
   * warmed on the prefetch pool while it is written, so a steady player never waits on the network between chunks.
   * A failure after the headers drops the connection (the player retries from where it got to).
   */
  private fun handleChunked(
    output: OutputStream,
    path: String,
    rangeHeader: String?,
    connId: Int,
  ) {
    val id = URLDecoder.decode(path.removePrefix("/playback/chunked/"), "UTF-8")
    val file = chunkedFiles.serve(id)
    if (file == null) {
      Log.w(TAG, "chunked.unknown connId=$connId id=$id")
      writeStatusLineAndClose(output, 404, "text/plain", ByteArray(0))
      return
    }
    val total = file.sizeBytes
    val range = HttpRange.parse(rangeHeader, total)
    if (range.invalid) {
      Log.w(TAG, "chunked.range_invalid connId=$connId id=$id range=$rangeHeader size=$total")
      writeRangeNotSatisfiable(output, total)
      return
    }
    val slices = file.slices(range.start, range.end)
    Log.d(TAG, "chunked.request connId=$connId id=$id range=${range.start}-${range.end}/$total chunks=${slices.first().index}..${slices.last().index}")
    val startMs = System.currentTimeMillis()
    var body: ObjectBody = try {
      openChunk(file, slices.first().index)
    } catch (e: Throwable) {
      Log.e(TAG, "chunked.fetch.error connId=$connId id=$id chunk=${slices.first().index}", e)
      writeStatusLineAndClose(output, 502, "text/plain", ByteArray(0))
      return
    }
    val sliceLen = range.end - range.start + 1
    val headers = StringBuilder()
    if (range.isRange) {
      headers.append("HTTP/1.1 206 Partial Content\r\n")
        .append("Content-Range: bytes ${range.start}-${range.end}/$total\r\n")
    } else {
      headers.append("HTTP/1.1 200 OK\r\n")
    }
    headers
      .append("Content-Type: ${file.mime}\r\n")
      .append("Content-Length: $sliceLen\r\n")
      .append("Accept-Ranges: bytes\r\n")
      .append("Connection: close\r\n")
      .append("\r\n")
    output.write(headers.toString().toByteArray(Charsets.ISO_8859_1))
    for ((n, slice) in slices.withIndex()) {
      if (n > 0) body = openChunk(file, slice.index)
      prefetchChunk(file, slice.index + 1)
      try {
        body.writeTo(output, slice.offsetInChunk, slice.length)
      } finally {
        body.release()
      }
    }
    output.flush()
    Log.d(TAG, "chunked.served connId=$connId id=$id bytes=$sliceLen chunks=${slices.size} elapsedMs=${System.currentTimeMillis() - startMs}")
  }

  /**
   * Decrypted chunk [index] of [file], checked against the size the library recorded for it. A player read: loading ahead
   * yields to it (PAR-PLAY-07).
   */
  private fun openChunk(file: ChunkedFile, index: Int): ObjectBody {
    val chunk = file.chunks[index]
    val body = preloader.playerRead(chunk.objectKey) { chunkFetcher.openObject(chunk.objectKey) }
    if (body.length != chunk.plainSize) {
      body.release()
      throw IOException("chunk_size_mismatch id=${file.id} chunk=$index key=${chunk.objectKey} got=${body.length} want=${chunk.plainSize}")
    }
    return body
  }

  private fun prefetchChunk(file: ChunkedFile, index: Int) {
    val chunk = file.chunks.getOrNull(index) ?: return
    try {
      prefetchPool.submit {
        try {
          preloader.playerRead(chunk.objectKey) { chunkFetcher.prefetch(chunk.objectKey) }
        } catch (e: Throwable) {
          Log.d(TAG, "chunked.prefetch.failed id=${file.id} chunk=$index msg=${e.message}")
        }
      }
    } catch (_: Throwable) {
      // Pool shut down (server stopping): nothing to warm.
    }
  }

  private fun writeRangeNotSatisfiable(output: OutputStream, total: Long) {
    output.write(
      ("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */$total\r\nContent-Length: 0\r\n" +
        "Accept-Ranges: bytes\r\nConnection: close\r\n\r\n").toByteArray(Charsets.ISO_8859_1)
    )
    output.flush()
  }

  private fun sniffContentType(key: String): String {
    val lower = key.lowercase(Locale.ROOT)
    return when {
      lower.endsWith(".vtt") -> "text/vtt; charset=utf-8"
      lower.endsWith(".m3u8") -> "application/vnd.apple.mpegurl"
      lower.endsWith(".mkv") -> "video/x-matroska"
      else -> "application/octet-stream"
    }
  }

  private fun writeStatusLineAndClose(
    output: OutputStream,
    status: Int,
    contentType: String,
    body: ByteArray,
  ) {
    val statusText = when (status) {
      200 -> "OK"
      204 -> "No Content"
      206 -> "Partial Content"
      400 -> "Bad Request"
      404 -> "Not Found"
      405 -> "Method Not Allowed"
      416 -> "Range Not Satisfiable"
      500 -> "Internal Server Error"
      502 -> "Bad Gateway"
      else -> "OK"
    }
    val headers = StringBuilder()
      .append("HTTP/1.1 $status $statusText\r\n")
      .append("Content-Type: $contentType\r\n")
      .append("Content-Length: ${body.size}\r\n")
      .append("Accept-Ranges: bytes\r\n")
      .append(corsHeaders())
      .append("Connection: close\r\n")
      .append("\r\n")
      .toString()
      .toByteArray(Charsets.ISO_8859_1)
    output.write(headers)
    if (body.isNotEmpty()) output.write(body)
    output.flush()
  }

  companion object {
    private const val TAG = "PlaybackHttp"
    private const val PREFETCH_THREADS = 4

    /** Largest stored object [readText] accepts: a text subtitle is a few hundred KB; anything bigger is not text. */
    private const val MAX_TEXT_BYTES = 8L * 1024L * 1024L

    /** Pixel height in a quality label (`1080p`, `2160p`). */
    private val QUALITY_HEIGHT = Regex("""^(\d{3,4})p""")

    /** Playlist URL -> per-file mpv decoder options, for every live session of every server in the process. */
    private val decoderOptions = ConcurrentHashMap<String, String>()

    /** Per-file mpv options to pass with `loadfile` of [url] (null when [url] is not one of our playlists or none apply). */
    fun perFileDecoderOptions(url: String): String? = decoderOptions[url]
  }
}
