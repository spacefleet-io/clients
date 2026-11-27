package com.spacefleet.mediaproxy

import android.util.Log
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Response
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.io.SequenceInputStream
import java.util.LinkedHashMap
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Phase 2A+2B storage tunnel client. Talks to the SpaceBadger storage gateway
 * over plain HTTP request/response and decrypts the SFV1 media envelope
 * locally via [MediaCrypto].
 *
 * Phase 2A (HTTP req/resp) wire flow (all bearer-authenticated, JSON):
 *
 *   1. POST {gatewayBaseUrl}/storage/tunnel/session
 *      body: { purpose, profileId (playback only, STOR-BW-11) } (shardId / qosTier / objectKeyPrefix all optional and
 *               taken from the user's account default if omitted)
 *      response: { sessionId, protocolVersion: 1, ... }
 *
 *   2. POST {gatewayBaseUrl}/storage/tunnel/frame
 *      body: { sessionId, frame: { kind: "session.start", sessionId,
 *              token, clientType, clientVersion } }
 *      response: { frame: { kind: "session.ack", sessionId, protocolVersion: 1 } }
 *
 *      Plain JSON. Despite the surrounding tunnel-frame protocol carrying
 *      end-to-end-encrypted payloads for upload/download streaming, the
 *      session.start handshake is intentionally unencrypted (gateway-side
 *      it just flips `session.started = true` — see
 *      the storage gateway's tunnel frame handler,
 *      session.start case). Phase 2C will add the encrypted-frame paths
 *      for streaming uploads + WebSocket downloads.
 *
 *   3. POST {winnerBaseUrl}/storage/tunnel/download
 *      body: { sessionId, objectKey, rangeStart?, rangeEnd? }
 *      response: raw `application/octet-stream` bytes (the SFV1 media
 *      envelope; gateway has already done its tunnel-layer transport
 *      decrypt, we still need [MediaCrypto.decryptSegment] to unwrap the
 *      media envelope).
 *
 * Phase 2B (waterfall multi-address fallback): the same physical gateway
 * server can be reachable through multiple addresses (LAN IPs, STUN public
 * IP, etc.). The client receives an ordered list of candidate URLs and walks
 * through them sequentially at session creation time, with a 3s per-attempt
 * timeout (matches `waterfallTimeoutMs` default in
 * packages/shared/src/storageTunnel.ts). The first candidate that successfully
 * creates a session AND acks the session.start frame becomes the
 * `winnerBaseUrl` for the rest of the session. The winner is remembered
 * across sessions so the second `startProxy` call retries the previous
 * winner first (60s TTL — matches the JS waterfallWinnerCache).
 *
 * Rate of HTTP round-trips: 2 control round-trips per session (start + end)
 * + 1 round-trip per chunk. WebSocket streaming (Phase 2C) will collapse
 * the per-chunk round-trip to a single multiplexed connection.
 *
 * Keeps an LRU cache + in-flight dedup so concurrent requests for the same
 * key from the HTTP server thread pool pay the network + decrypt cost once.
 */
class StorageTunnelClient(
  /**
   * Ordered list of gateway base URLs. The client walks them sequentially
   * at session creation time and uses the first one that responds within
   * [attemptTimeoutMs]. Pass a single-element list to disable waterfall.
   */
  private val gatewayCandidates: List<String>,
  private val authToken: String,
  private val appId: String,
  private val masterKey: ByteArray,
  private val clientType: String = "client-mobile-playback",
  private val clientVersion: String = "spacebadger-mobile",
  /**
   * Per-candidate timeout during the waterfall race. Matches the JS
   * `waterfallTimeoutMs` default of 3000ms.
   */
  private val attemptTimeoutMs: Long = 3000L,
  /**
   * Session purpose the gateway classifies the flow by (STOR-BW-07 to STOR-BW-09): playback is refused or stopped for a
   * free viewer at saturation; `export` (offline downloads) gets zero bytes while the silo is saturated and resumes by itself.
   */
  private val purpose: String = "playback",
  /**
   * API id of the profile a `playback` session is for (STOR-BW-11): sent in the session body and the traffic poll. The
   * gateway refuses a playback session without one, so an empty id fails here instead. Unused (null) for `export`.
   */
  private val profileId: String? = null,
  /**
   * Where objects above [ChunkFetcher.SPOOL_THRESHOLD_BYTES] are decrypted to (playback). Null for the downloader,
   * which only calls [fetchEncrypted]; opening such an object without a spool throws.
   */
  private val spool: PlaintextSpool?,
  /**
   * Receives what the gateway said about traffic as a JSON string `{ source, status, code, traffic }`: the traffic of every
   * session response and `session.ack`, and the 503 `free_playback_refused` / `playback_stopped` with the silo's report
   * (STOR-BW-07, STOR-BW-08). JS decides what it means; null for the downloader.
   */
  private val onTraffic: ((String) -> Unit)? = null,
  /**
   * Told every load report this client learns from its silo: the session response and the `session.ack` (STOR-BW-01,
   * STOR-BW-09). The offline downloader uses it to slow down while the silo is high and to hold while it is saturated.
   */
  private val onTrafficReport: ((TrafficReport) -> Unit)? = null,
  /**
   * Told every object the player's fetches download: its encrypted size and how long the download took, request
   * included. Parrot picks each song's copy from these (PAR-PLAY-02); null for the downloader.
   */
  private val onDownloaded: ((bytes: Long, ms: Long) -> Unit)? = null,
) : ChunkFetcher {
  init {
    require(gatewayCandidates.isNotEmpty()) { "gatewayCandidates must not be empty" }
    if (purpose == "playback" && profileId.isNullOrBlank()) {
      Log.e(TAG, "session.profile_required purpose=$purpose")
      throw IllegalStateException("profile_required")
    }
    Log.i(TAG, "cache.budget bytes=$cacheBudgetBytes maxHeap=${Runtime.getRuntime().maxMemory()}")
  }

  // Steady-state HTTP client for download traffic (used after the winner is
  // selected). Generous read timeout because some chunks are large.
  private val http = OkHttpClient.Builder()
    .connectTimeout(15, TimeUnit.SECONDS)
    .readTimeout(30, TimeUnit.SECONDS)
    .build()

  // Session-creation HTTP client with a tight call timeout so a single
  // unreachable candidate doesn't block the waterfall. callTimeout covers
  // DNS + connect + TLS + request + response (the whole call).
  private val sessionHttp = OkHttpClient.Builder()
    .callTimeout(attemptTimeoutMs, TimeUnit.MILLISECONDS)
    .connectTimeout(attemptTimeoutMs, TimeUnit.MILLISECONDS)
    .build()

  private val sessionLock = ReentrantLock()
  @Volatile private var sessionId: String? = null
  /** When the gateway last answered a `session.start` (the start, then the periodic refresh, [refreshTrafficIfDue]). */
  private val lastAckAtMs = AtomicLong(0L)
  /** Set after a successful session.start ack. All download requests use this URL. */
  @Volatile private var winnerBaseUrl: String? = null

  private val cacheLock = ReentrantLock()
  // Bodies are immutable slices of the decrypt output: one instance serves every hit. Sized by the backing array
  // (what the heap actually holds), not the slice.
  private val cache = LinkedHashMap<String, ObjectBody.InMemory>(64, 0.75f, false)
  private var cacheSize = 0L
  private val pending = ConcurrentHashMap<String, Deferred>()
  /** Objects the eviction skips (PAR-PLAY-07): see [pin]. Replaced whole, read under [cacheLock]. */
  @Volatile private var pinned: Set<String> = emptySet()
  /** The download call of each key on the wire now, so [cancelInFlight] can abort it. */
  private val calls = ConcurrentHashMap<String, Call>()

  /** In-flight fetch: resolves with the in-memory body, or null when the object went to [spool]. */
  private class Deferred {
    private val lock = ReentrantLock()
    private val ready = lock.newCondition()
    private var done = false
    private var value: ObjectBody.InMemory? = null
    private var error: Throwable? = null
    /** Set by [cancelInFlight]: the fetch is aborted, also when its download had not started yet (see [download]). */
    @Volatile var cancelled = false
    /**
     * Set when the player itself reads this object ([openObject]), as the fetch's owner or a reader joining it: the player
     * is waiting on it, so [cancelInFlight] leaves it alone (PAR-PLAY-12).
     */
    @Volatile var playerWanted = false

    fun resolve(v: ObjectBody.InMemory?) {
      lock.withLock { value = v; done = true; ready.signalAll() }
    }

    fun reject(e: Throwable) {
      lock.withLock { error = e; done = true; ready.signalAll() }
    }

    fun await(): ObjectBody.InMemory? {
      lock.withLock {
        while (!done) ready.await()
        error?.let { throw it }
        return value
      }
    }
  }

  override fun openObject(key: String): ObjectBody = open(key, player = true)

  /**
   * Loads [key] ahead of the player (PAR-PLAY-07 preloads, the proxy's read-ahead): unlike [openObject] the fetch stays
   * cancellable until the player itself asks for the object.
   */
  override fun prefetch(key: String) {
    open(key, player = false).release()
  }

  private fun open(key: String, player: Boolean): ObjectBody {
    cacheLock.withLock {
      val cached = cache.remove(key)
      if (cached != null) {
        cache[key] = cached
        return cached
      }
    }
    spool?.open(key)?.let { return it }

    val newDeferred = Deferred().also { it.playerWanted = player }
    val existing = pending.putIfAbsent(key, newDeferred)
    if (existing != null) {
      if (player) existing.playerWanted = true
      Log.d(TAG, "fetch.dedup.wait key=$key player=$player")
      val inMemory = try {
        existing.await()
      } catch (e: Throwable) {
        // The fetch this read joined was cancelled before the player joined it (a preload yielding, PAR-PLAY-07; a rung
        // switch): the player still wants the object, so it fetches it itself. A load ahead stays cancelled.
        if (existing.cancelled && player) {
          Log.i(TAG, "fetch.refetch_after_cancel key=$key")
          return open(key, player = true)
        }
        throw e
      }
      if (inMemory != null) return inMemory
      return spool?.open(key) ?: throw IllegalStateException("spool_entry_gone: $key")
    }

    try {
      ensureSession()
      val body = fetchAndDecrypt(key)
      val inMemory = body as? ObjectBody.InMemory
      if (inMemory != null) {
        cacheLock.withLock {
          cache[key] = inMemory
          cacheSize += inMemory.plaintext.bytes.size
          evictIfNeededLocked()
        }
      }
      newDeferred.resolve(inMemory)
      return body
    } catch (e: Throwable) {
      // Freed before the waiters wake: one whose fetch was cancelled fetches again and must find the slot empty.
      pending.remove(key, newDeferred)
      newDeferred.reject(e)
      throw e
    } finally {
      pending.remove(key, newDeferred)
    }
  }

  /**
   * Aborts the fetches loading [matches] keys ahead of the player. A fetch the player itself is waiting on is skipped
   * (PAR-PLAY-12, Chris 2026-11-27): aborting it made the proxy answer the player's request with a 502, which the player
   * shows as ERROR_CODE_IO_BAD_HTTP_STATUS and stops on.
   */
  override fun cancelInFlight(matches: (String) -> Boolean): Int {
    var aborted = 0
    for (key in (pending.keys + calls.keys).filter(matches)) {
      val deferred = pending[key]
      if (deferred?.playerWanted == true) {
        Log.i(TAG, "fetch.cancel_skipped_player_read key=$key")
        continue
      }
      // Marked before the call is looked up: a fetch still opening the session or refreshing traffic has no call yet and
      // is aborted by [download] the moment it makes one, so a cancel never misses a fetch that has not reached the wire.
      // A player joining it after this mark fetches the object again (see [open]).
      deferred?.cancelled = true
      calls[key]?.cancel()
      aborted += 1
      Log.i(TAG, "fetch.cancelled key=$key")
    }
    return aborted
  }

  override fun pin(keys: Set<String>) {
    pinned = keys
    Log.i(TAG, "cache.pin keys=${keys.size} ${keys.joinToString(",")}")
  }

  /** Caller must hold [cacheLock]. Oldest first, skipping [pinned] objects; stops when only pinned ones are left. */
  private fun evictIfNeededLocked() {
    if (cacheSize <= cacheBudgetBytes) return
    val keep = pinned
    val it = cache.entries.iterator()
    while (cacheSize > cacheBudgetBytes && it.hasNext()) {
      val (k, v) = it.next()
      if (k in keep) continue
      it.remove()
      cacheSize -= v.plaintext.bytes.size
      Log.d(TAG, "cache.evict key=$k freed=${v.plaintext.bytes.size} cacheSize=$cacheSize budget=$cacheBudgetBytes")
    }
  }

  private fun ensureSession() {
    if (sessionId != null) return
    sessionLock.withLock {
      if (sessionId != null) return

      // Sticky-winner-first ordering: if a previous session.start succeeded
      // against `winnerBaseUrl`, retry that one before falling back to the
      // rest of the candidate list. Mirrors the JS waterfallWinnerCache —
      // skip the cold-start probing cost when the same gateway is still up.
      val cachedWinner = winnerBaseUrl
      val orderedCandidates: List<String> = if (
        cachedWinner != null && gatewayCandidates.contains(cachedWinner)
      ) {
        buildList(gatewayCandidates.size) {
          add(cachedWinner)
          for (candidate in gatewayCandidates) if (candidate != cachedWinner) add(candidate)
        }
      } else {
        gatewayCandidates
      }

      val attempts = mutableListOf<Pair<String, String>>() // baseUrl -> error
      for ((idx, baseUrl) in orderedCandidates.withIndex()) {
        try {
          val sid = createSession(baseUrl)
          startSessionFrame(baseUrl, sid)
          sessionId = sid
          winnerBaseUrl = baseUrl
          Log.i(
            TAG,
            "session.waterfall.winner attempt=${idx + 1}/${orderedCandidates.size} baseUrl=$baseUrl sid=$sid"
          )
          return
        } catch (e: Throwable) {
          // A refusal every address of the same gateway would repeat (STOR-BW-07): the waterfall stops here.
          if (e is TunnelRefusedException) throw e
          val errKind = (e.message ?: e::class.java.simpleName)
          attempts.add(baseUrl to errKind)
          Log.w(TAG, "session.waterfall.attempt_failed attempt=${idx + 1} baseUrl=$baseUrl err=$errKind")
        }
      }
      // All candidates exhausted — invalidate the cached winner (if any)
      // and surface a single combined error.
      winnerBaseUrl = null
      val summary = attempts.joinToString("; ") { (url, err) -> "$url -> $err" }
      throw IllegalStateException("tunnel_session_all_candidates_failed: $summary")
    }
  }

  private fun createSession(baseUrl: String): String {
    val req = Request.Builder()
      .url("$baseUrl/storage/tunnel/session")
      .addHeader("Authorization", "Bearer $authToken")
      .addHeader(SPACE_APP_HEADER, appId)
      .post(sessionBody().toString().toRequestBody(JSON_TYPE))
      .build()
    sessionHttp.newCall(req).execute().use { res ->
      val text = res.body?.string() ?: ""
      val error = emitTraffic("session", res.code, text)
      if (!res.isSuccessful) {
        if (res.code == 503 && error == FREE_PLAYBACK_REFUSED) throw TunnelRefusedException(res.code, error)
        throw IllegalStateException("tunnel_session_failed: ${res.code} ${text.take(2048)}")
      }
      val payload = JSONObject(text.ifEmpty { "{}" })
      val sid = payload.optString("sessionId", "")
      if (sid.isEmpty()) throw IllegalStateException("tunnel_session_missing_id")
      reportTraffic(payload.optJSONObject("traffic"))
      return sid
    }
  }

  /** `POST /storage/tunnel/session` body: the purpose, and for playback the profile it is for (STOR-BW-11). */
  private fun sessionBody(): JSONObject {
    val body = JSONObject().put("purpose", purpose)
    if (purpose == "playback") {
      body.put("profileId", profileId)
      Log.i(TAG, "session.profile_attached profileId=$profileId")
    }
    return body
  }

  /** `GET /storage/traffic` on [baseUrl]; a playback poll names its profile (STOR-BW-11). */
  private fun trafficUrl(baseUrl: String): HttpUrl {
    val url = "$baseUrl/storage/traffic".toHttpUrl()
    return if (purpose == "playback") url.newBuilder().addQueryParameter("profileId", profileId).build() else url
  }

  private fun sessionStartRequest(baseUrl: String, sid: String): Request {
    val frame = JSONObject().apply {
      put("kind", "session.start")
      put("sessionId", sid)
      put("token", authToken)
      put("clientType", clientType)
      put("clientVersion", clientVersion)
    }
    val body = JSONObject().apply {
      put("sessionId", sid)
      put("frame", frame)
    }
    return Request.Builder()
      .url("$baseUrl/storage/tunnel/frame")
      .addHeader("Authorization", "Bearer $authToken")
      .addHeader(SPACE_APP_HEADER, appId)
      .post(body.toString().toRequestBody(JSON_TYPE))
      .build()
  }

  private fun startSessionFrame(baseUrl: String, sid: String) {
    lastAckAtMs.set(System.currentTimeMillis())
    sessionHttp.newCall(sessionStartRequest(baseUrl, sid)).execute().use { res ->
      val text = res.body?.string() ?: ""
      emitTraffic("ack", res.code, text)
      if (!res.isSuccessful) {
        throw IllegalStateException("tunnel_session_start_failed: ${res.code} ${text.take(2048)}")
      }
      val payload = JSONObject(text.ifEmpty { "{}" })
      val ackKind = payload.optJSONObject("frame")?.optString("kind") ?: ""
      if (ackKind != "session.ack") {
        throw IllegalStateException("tunnel_session_start_unexpected_frame: $ackKind")
      }
      reportTraffic(payload.optJSONObject("frame")?.optJSONObject("traffic"))
    }
  }

  /**
   * The gateway's grace before it stops a free viewer over the 480p speed is 10 s, and a tunnel session sends its `session.ack`
   * once, at its start. While objects are fetched the `session.start` frame is therefore re-sent every [ACK_REFRESH_MS] (the
   * gateway answers it with a fresh `session.ack`, which also renews the session) so the cap and a stop reach JS in time to
   * step down. Fire and forget: the answer only feeds [emitTraffic], a failure changes nothing.
   */
  private fun refreshTrafficIfDue() {
    if (onTraffic == null) return
    val sid = sessionId ?: return
    val baseUrl = winnerBaseUrl ?: return
    val now = System.currentTimeMillis()
    val last = lastAckAtMs.get()
    if (now - last < ACK_REFRESH_MS || !lastAckAtMs.compareAndSet(last, now)) return
    sessionHttp.newCall(sessionStartRequest(baseUrl, sid)).enqueue(object : Callback {
      override fun onFailure(call: Call, e: IOException) {
        Log.d(TAG, "traffic.refresh.failed: ${e.message}")
      }

      override fun onResponse(call: Call, response: Response) {
        response.use { emitTraffic("ack", it.code, it.body?.string() ?: "") }
      }
    })
  }

  /**
   * Forwards what the gateway said about traffic to [onTraffic] and returns the body's `error` ("" = none). Nothing is
   * decided here: the status, the error code and the `traffic` object (of a session response, an error body or a
   * `session.ack` frame) go to JS as they came.
   */
  private fun emitTraffic(source: String, status: Int, bodyText: String): String {
    val body = runCatching { JSONObject(bodyText) }.getOrNull() ?: return ""
    val code = body.optString("error", "")
    val sink = onTraffic ?: return code
    val traffic = body.optJSONObject("traffic") ?: body.optJSONObject("frame")?.optJSONObject("traffic")
    if (code.isEmpty() && traffic == null) return code
    val event = JSONObject()
      .put("source", source)
      .put("status", status)
      .put("code", if (code.isEmpty()) JSONObject.NULL else code)
      .put("traffic", traffic ?: JSONObject.NULL)
      .toString()
    Log.i(TAG, "traffic.event $event")
    runCatching { sink(event) }.onFailure { Log.w(TAG, "traffic.event.sink_failed: ${it.message}") }
    return code
  }

  /**
   * Raw tunnel download: the SFV1 envelope exactly as the gateway returns it
   * (still encrypted, no LRU cache, no decrypt). Used by the offline
   * downloader, which stores objects encrypted on disk. Opens the tunnel
   * session on demand.
   */
  fun fetchEncrypted(key: String): ByteArray {
    ensureSession()
    return download(key) { body, startMs, headers ->
      val input = MeteredInputStream(body.byteStream(), startMs)
      val declared = body.contentLength()
      val bytes = if (declared in 0..Int.MAX_VALUE.toLong()) readDeclared(input, declared.toInt()) else input.readBytes()
      input.finish()
      // Verified before it is stored (DECOM-02): a short or corrupted object throws, and the engine fetches it again.
      DownloadIntegrity.verify(key, bytes, declared, headers[SHA256_HEADER])?.let { throw java.io.IOException(it) }
      bytes
    }
  }

  /**
   * This silo's current load report (`GET /storage/traffic` on the session's gateway), or null when it cannot be read.
   * Opens the session on demand. Also feeds [onTrafficReport].
   */
  fun fetchTraffic(): TrafficReport? {
    return try {
      ensureSession()
      val baseUrl = winnerBaseUrl ?: return null
      val req = Request.Builder()
        .url(trafficUrl(baseUrl))
        .addHeader("Authorization", "Bearer $authToken")
        .addHeader(SPACE_APP_HEADER, appId)
        .get()
        .build()
      sessionHttp.newCall(req).execute().use { res ->
        if (!res.isSuccessful) return null
        val payload = JSONObject(res.body?.string() ?: "{}")
        reportTraffic(payload.optJSONObject("traffic"))
      }
    } catch (e: Throwable) {
      Log.d(TAG, "traffic.refresh_failed: ${e.message}")
      null
    }
  }

  /** Parses a wire `traffic` object and hands it to [onTrafficReport]; null when absent or of an unknown state. */
  private fun reportTraffic(json: JSONObject?): TrafficReport? {
    if (json == null) return null
    val report = TrafficReport.fromFields(
      state = json.optString("state", ""),
      playbackBufferSeconds = if (json.has("playbackBufferSeconds") && !json.isNull("playbackBufferSeconds")) json.optDouble("playbackBufferSeconds") else null,
      saturated = json.optBoolean("saturated", false),
    ) ?: return null
    onTrafficReport?.invoke(report)
    return report
  }

  /**
   * POSTs the tunnel download of [key] and hands the response body (the still-encrypted SFV1 envelope) and headers to [read].
   * A 404 `invalid_session` means the gateway forgot the session (it expired while the app slept or stayed paused past
   * the session TTL, or the gateway restarted): the session is dropped, a new one opened and the download tried once
   * more (STOR-GATEWAY-02, "the client opens a new one"). The same holds for every refusal a new session can fix — a 401,
   * 403 or 410 and a 400 `session_not_started` — so a player read never fails on a stale session (PAR-PLAY-12,
   * Chris 2026-11-27); any other status (a 404 `object_not_found`) fails at once.
   */
  private fun <T> download(
    key: String,
    renewed: Boolean = false,
    read: (okhttp3.ResponseBody, Long, okhttp3.Headers) -> T,
  ): T {
    refreshTrafficIfDue()
    val sid = sessionId ?: throw IllegalStateException("tunnel_session_not_active")
    val baseUrl = winnerBaseUrl ?: throw IllegalStateException("tunnel_session_no_winner")
    val body = JSONObject().apply {
      put("sessionId", sid)
      put("objectKey", key)
    }
    val req = Request.Builder()
      .url("$baseUrl/storage/tunnel/download")
      .addHeader("Authorization", "Bearer $authToken")
      .addHeader(SPACE_APP_HEADER, appId)
      .post(body.toString().toRequestBody(JSON_TYPE))
      .build()
    val startMs = System.currentTimeMillis()
    var refusal = ""
    val call = http.newCall(req)
    calls[key] = call
    if (pending[key]?.cancelled == true) call.cancel()
    try {
      call.execute().use { res ->
        if (!res.isSuccessful) {
          val code = emitTraffic("download", res.code, runCatching { res.body?.string() }.getOrNull() ?: "")
          if (renewed || !sessionRenewable(res.code, code)) {
            throw TunnelHttpException(res.code, "tunnel_download_failed: ${res.code} key=$key code=${code.ifEmpty { "-" }}")
          }
          refusal = "${res.code}/${code.ifEmpty { "-" }}"
        } else {
          val resBody = res.body ?: throw IllegalStateException("tunnel_download_empty: $key")
          return read(resBody, startMs, res.headers)
        }
      }
    } finally {
      calls.remove(key, call)
    }
    dropSession(sid)
    Log.w(TAG, "session.renew reason=$refusal sid=$sid key=$key")
    ensureSession()
    return download(key, renewed = true, read = read)
  }

  /** Whether a download refused with [status] / [code] is worth one retry on a new session (see [download]). */
  private fun sessionRenewable(status: Int, code: String): Boolean =
    status == 401 || status == 403 || status == 410 ||
      (status == 404 && code == "invalid_session") || (status == 400 && code == "session_not_started")

  /**
   * Reads at most [READ_PIECE_BYTES] per call while feeding [NetworkMeter] every [METER_SLICE_MS], so a segment that
   * takes longer than the meter window on a slow link still reports its (low) throughput instead of nothing until it
   * completes. With the test-only [NetworkThrottle] cap set (probe `NETTHROTTLE`) each piece also sleeps to hold the
   * shared byte-rate cap. [finish] records the last partial slice.
   */
  private class MeteredInputStream(private val source: InputStream, startMs: Long) : InputStream() {
    private var sliceStart = startMs
    private var sliceBytes = 0L

    override fun read(): Int {
      val one = ByteArray(1)
      return if (read(one, 0, 1) < 0) -1 else one[0].toInt() and 0xff
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
      val n = source.read(b, off, minOf(len, READ_PIECE_BYTES))
      if (n <= 0) return n
      sliceBytes += n
      val wait = NetworkThrottle.delayMsFor(n)
      if (wait > 0) Thread.sleep(wait)
      val now = System.currentTimeMillis()
      if (now - sliceStart >= METER_SLICE_MS) {
        NetworkMeter.record(sliceBytes, sliceStart, now)
        sliceStart = now
        sliceBytes = 0L
      }
      return n
    }

    fun finish() {
      NetworkMeter.record(sliceBytes, sliceStart, System.currentTimeMillis())
      sliceBytes = 0L
    }
  }

  /** Reads a body of [declared] bytes into one exactly-sized array (shorter if the stream ends early). */
  private fun readDeclared(input: InputStream, declared: Int): ByteArray {
    val fixed = ByteArray(declared)
    var total = 0
    while (total < declared) {
      val n = input.read(fixed, total, declared - total)
      if (n < 0) break
      total += n
    }
    return if (total < declared) fixed.copyOf(total) else fixed
  }

  /** The start of a body: all of it ([complete]) when it fits [ChunkFetcher.SPOOL_THRESHOLD_BYTES], else what was read. */
  private class BodyPrefix(val bytes: ByteArray, val complete: Boolean)

  private fun readPrefix(input: InputStream, declared: Long): BodyPrefix {
    if (declared > ChunkFetcher.SPOOL_THRESHOLD_BYTES) return BodyPrefix(ByteArray(0), false)
    if (declared >= 0) return BodyPrefix(readDeclared(input, declared.toInt()), true)
    // Chunked response, size unknown: buffer up to the threshold, then hand over to the spool.
    val grown = java.io.ByteArrayOutputStream()
    val piece = ByteArray(READ_PIECE_BYTES)
    while (grown.size() <= ChunkFetcher.SPOOL_THRESHOLD_BYTES) {
      val n = input.read(piece, 0, piece.size)
      if (n < 0) return BodyPrefix(grown.toByteArray(), true)
      grown.write(piece, 0, n)
    }
    return BodyPrefix(grown.toByteArray(), false)
  }

  /**
   * Fetches and decrypts [key]. A body up to [ChunkFetcher.SPOOL_THRESHOLD_BYTES] (an HLS segment) is decrypted in
   * memory and returned for the LRU; a larger one (a subtitle sidecar) is decrypted piece by piece into [spool] as it
   * arrives, so the heap never holds it whole.
   */
  private fun fetchAndDecrypt(key: String): ObjectBody {
    val fetchStart = System.currentTimeMillis()
    return download(key) { body, startMs, _ ->
      val input = MeteredInputStream(body.byteStream(), startMs)
      val declared = body.contentLength()
      val prefix = readPrefix(input, declared)
      if (prefix.complete) {
        input.finish()
        val encrypted = prefix.bytes
        val tunnelMs = System.currentTimeMillis() - fetchStart
        onDownloaded?.invoke(encrypted.size.toLong(), tunnelMs)
        val decryptStart = System.currentTimeMillis()
        val plaintext = MediaCrypto.decryptSegment(masterKey, encrypted)
        val decryptMs = System.currentTimeMillis() - decryptStart
        Log.i(
          TAG,
          "object.tunnel_and_decrypt key=$key encryptedBytes=${encrypted.size} plaintextBytes=${plaintext.length} tunnelMs=$tunnelMs decryptMs=$decryptMs"
        )
        ObjectBody.InMemory(plaintext)
      } else {
        val target = spool ?: throw IllegalStateException("tunnel_object_too_large_without_spool: $key")
        val spooled = target.spool(key, masterKey, SequenceInputStream(ByteArrayInputStream(prefix.bytes), input))
        input.finish()
        Log.i(
          TAG,
          "object.tunnel_and_spool key=$key declaredBytes=$declared plaintextBytes=${spooled.length} ms=${System.currentTimeMillis() - fetchStart}"
        )
        spooled
      }
    }
  }

  /**
   * Forgets [sid] unless another fetch already replaced it, so concurrent fetches that all saw it gone open one session.
   */
  private fun dropSession(sid: String) {
    sessionLock.withLock { if (sessionId == sid) sessionId = null }
  }

  private fun endSessionBestEffort() {
    val sid = sessionId ?: return
    val baseUrl = winnerBaseUrl ?: return
    sessionId = null
    val frame = JSONObject().apply {
      put("kind", "session.end")
      put("sessionId", sid)
    }
    val body = JSONObject().apply {
      put("sessionId", sid)
      put("frame", frame)
    }
    runCatching {
      val req = Request.Builder()
        .url("$baseUrl/storage/tunnel/frame")
        .addHeader("Authorization", "Bearer $authToken")
        .addHeader(SPACE_APP_HEADER, appId)
        .post(body.toString().toRequestBody(JSON_TYPE))
        .build()
      http.newCall(req).execute().close()
    }.onFailure {
      Log.d(TAG, "session.end best-effort failed: ${it.message}")
    }
  }

  override fun shutdown() {
    endSessionBestEffort()
    cacheLock.withLock {
      cache.clear()
      cacheSize = 0L
    }
    pending.clear()
    spool?.clear()
    http.dispatcher.executorService.shutdown()
    http.connectionPool.evictAll()
  }

  companion object {
    private const val TAG = "StorageTunnelClient"

    /**
     * Upper bound of the decrypted-segment LRU. The effective budget is also capped at a quarter of the heap
     * ([cacheBudgetBytes]): at the full 128 MB on a 256 MB heap the cache alone filled half of it after ~15 min of
     * playback, and a sidecar subtitle load on top ran the proxy out of memory (HTTP 502, subtitle silently off).
     */
    private const val MAX_CACHE_BYTES = 128L * 1024L * 1024L // 128 MB
    private val cacheBudgetBytes: Long = minOf(MAX_CACHE_BYTES, Runtime.getRuntime().maxMemory() / 4)
    private const val SPACE_APP_HEADER = "x-space-app"
    private const val METER_SLICE_MS = 250L
    private const val ACK_REFRESH_MS = 5_000L
    private const val FREE_PLAYBACK_REFUSED = "free_playback_refused"
    private const val READ_PIECE_BYTES = 16 * 1024
    private const val SHA256_HEADER = "x-storage-tunnel-sha256"
    private val JSON_TYPE = "application/json".toMediaType()
  }
}

/** Non-2xx answer from the storage tunnel; [code] is the HTTP status. */
open class TunnelHttpException(val code: Int, message: String) : IllegalStateException(message)

/** The gateway refused a new free playback session while its silo is saturated (503 `free_playback_refused`, STOR-BW-07). */
class TunnelRefusedException(code: Int, val error: String) : TunnelHttpException(code, "tunnel_session_refused: $code $error")
