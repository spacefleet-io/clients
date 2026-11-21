package com.spacefleet.mediaproxy

import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONObject

/**
 * React Native module that owns the entire native playback proxy. JS calls
 * exactly one method — [startProxy] — which:
 *  1. Parses metadata.json (passed as a string to keep this module narrow).
 *  2. Derives the media master key from the library key (HKDF-SHA256).
 *  3. Builds the [HlsSession] from the videos[] + audioTracks[] + subtitleTracks[] fields.
 *  4. Constructs the [ChunkFetcher] (StorageTunnelClient — the only
 *     backend; it fetches encrypted segments through the storage gateway).
 *  5. Starts the [PlaybackHttpServer] on 127.0.0.1 and creates a session.
 *  6. Returns the master.m3u8 URL string back to JS.
 *
 * After that, JS is out of the playback hot path entirely. mpv talks to the
 * native server, the server fetches encrypted segments via the
 * [ChunkFetcher], decrypts them with javax.crypto.Cipher (AES-256-GCM,
 * native), and serves plaintext segments back. Zero JS work per segment.
 *
 * Idempotent: if startProxy is called twice (e.g. the React component
 * remounts in dev), the existing server is reused — same port, same URL.
 *
 * Multi-track schema (multi-quality video + multi-audio + WebVTT/PGS subs):
 *   {
 *     "videos": [{ id, quality, codecString, initKey, durationSeconds, chunks[], bitrateKbps?, width?, height? }, ...],
 *     "audioTracks": [{ id, language, label, isDefault, codecString, initKey, durationSeconds, chunks[] }, ...],
 *     "subtitleTracks": [{ id, language, label, isDefault, format: "vtt"|"pgs"|"vobsub", encrypted, url }, ...],
 *     "chapters": [{ title, startSeconds, endSeconds }, ...],
 *     ...
 *   }
 */
class PlaybackBridge(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "PlaybackBridge"

  @Volatile private var server: PlaybackHttpServer? = null
  @Volatile private var serverFingerprint: String? = null
  /** Last high-traffic playback buffer JS set ([setBufferCap]); a rebuilt server starts with it. */
  @Volatile private var bufferCapSeconds: Double = TrafficBuffer.NO_CAP

  override fun initialize() {
    super.initialize()
    trafficOwner = this
  }

  override fun invalidate() {
    // A JS reload creates the next module before or after this one is torn down: only clear our own hook.
    if (trafficOwner === this) trafficOwner = null
    super.invalidate()
  }

  private fun emitTraffic(json: String) {
    if (!reactApplicationContext.hasActiveReactInstance()) return
    reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(TRAFFIC_EVENT, json)
  }

  private fun emitDownloaded(bytes: Long, ms: Long) {
    if (!reactApplicationContext.hasActiveReactInstance()) return
    val event = Arguments.createMap().apply {
      putDouble("bytes", bytes.toDouble())
      putDouble("ms", ms.toDouble())
    }
    reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(DOWNLOAD_EVENT, event)
  }

  /**
   * Starts (or reuses) the native HLS proxy.
   *
   * @param metadataJson      the entire metadata.json (string) — see the
   *                          apps/badger/mobile ingest pipeline for the schema.
   * @param libraryKeyBase64  32-byte library key, base64 (NO_WRAP).
   * @param config            a ReadableMap for the storage-tunnel backend:
   *
   *     {
   *       "clientKind": "storage-tunnel",                // optional, the only kind
   *       "gatewayBaseUrl": "https://gateway.example.com",
   *       "authToken": "<bearer>",
   *       "appId": "badger" | "parrot",
   *       "profileId": "<api profile uuid>",          // required (STOR-BW-11), the main profile's too
   *       "clientType": "client-mobile-playback",      // optional
   *       "clientVersion": "spacebadger-mobile@x.y.z"  // optional
   *     }
   *
   * @param promise           resolves with the master.m3u8 URL string.
   */
  @ReactMethod
  fun startProxy(
    metadataJson: String,
    libraryKeyBase64: String,
    config: ReadableMap,
    promise: Promise,
  ) {
    try {
      val session = PlaybackSetup.parseSession(metadataJson)
      val s = ensureServer(libraryKeyBase64, config, promise) ?: return
      val url = s.createSession(session)
      Log.i(TAG, "startProxy.session url=$url videos=${session.videos.size} audio=${session.audio.size} subs=${session.subtitles.size}")
      promise.resolve(url)
    } catch (e: Throwable) {
      Log.e(TAG, "startProxy.error", e)
      promise.reject("playback_bridge_error", e.message ?: "unknown", e)
    }
  }

  /**
   * Starts (or reuses) the proxy without an HLS session and resolves with its base URL (`http://127.0.0.1:<port>`), which
   * serves `/playback/object/{key}` and the files registered with [registerChunkedFile]. Same arguments, same reuse rule
   * and same STOR-BW-11 profile check as [startProxy]. The server is process-wide, not tied to an Activity: it runs until
   * [stopProxy] or process death (Parrot's background playback relies on it).
   */
  @ReactMethod
  fun start(libraryKeyBase64: String, config: ReadableMap, promise: Promise) {
    try {
      val s = ensureServer(libraryKeyBase64, config, promise) ?: return
      Log.i(TAG, "start.ready base=${s.baseUrl()}")
      promise.resolve(s.baseUrl())
    } catch (e: Throwable) {
      Log.e(TAG, "start.error", e)
      promise.reject("playback_bridge_error", e.message ?: "unknown", e)
    }
  }

  /**
   * Registers one chunked file (a Parrot track file, PAR-FMT-01: the original file cut into 1 MiB plaintext pieces, each its
   * own SFV1 object) on the running proxy and resolves with its URL `<base>/playback/chunked/<id>`, which answers `Range:`
   * requests by fetching and decrypting only the chunks they cover. [fileJson]:
   * `{ id, mime, sizeBytes, chunks: [{ objectKey, plainOffset, plainSize }] }`. Rejects `proxy_not_started` before [start].
   */
  @ReactMethod
  fun registerChunkedFile(fileJson: String, promise: Promise) {
    try {
      val s = server
      if (s == null) {
        promise.reject("proxy_not_started", "proxy_not_started")
        return
      }
      val file = ChunkedFile.fromJson(JSONObject(fileJson))
      val url = s.registerChunkedFile(file)
      Log.i(TAG, "chunked.registered id=${file.id} mime=${file.mime} size=${file.sizeBytes} chunks=${file.chunks.size} url=$url")
      promise.resolve(url)
    } catch (e: Throwable) {
      Log.e(TAG, "chunked.register.error", e)
      promise.reject("playback_bridge_error", e.message ?: "unknown", e)
    }
  }

  /** Forgets a file registered with [registerChunkedFile]; resolves false when it was not registered. */
  @ReactMethod
  fun unregisterChunkedFile(id: String, promise: Promise) {
    promise.resolve(server?.unregisterChunkedFile(id) ?: false)
  }

  /**
   * Changes the file served at a registered id until the player first asks for it: resolves true when the id now serves
   * [fileJson]'s chunks (a new id is registered), false when the player already started reading the id, which then keeps
   * its file, so a song never changes copy midway (PAR-PLAY-04). Rejects `proxy_not_started` before [start].
   */
  @ReactMethod
  fun swapChunkedFile(fileJson: String, promise: Promise) {
    try {
      val s = server
      if (s == null) {
        promise.reject("proxy_not_started", "proxy_not_started")
        return
      }
      val file = ChunkedFile.fromJson(JSONObject(fileJson))
      val swapped = s.swapChunkedFile(file)
      Log.i(TAG, "chunked.swap id=${file.id} mime=${file.mime} size=${file.sizeBytes} swapped=$swapped")
      promise.resolve(swapped)
    } catch (e: Throwable) {
      Log.e(TAG, "chunked.swap.error", e)
      promise.reject("playback_bridge_error", e.message ?: "unknown", e)
    }
  }

  /**
   * The playing, next and previous queue entries (registered ids, null where none): the proxy keeps their openings
   * cached and loads the missing ones while the player is idle, so Next and Previous start at once (PAR-PLAY-07). Resolves
   * false before [start].
   */
  @ReactMethod
  fun setNeighbours(current: String?, next: String?, previous: String?, promise: Promise) {
    val s = server ?: return promise.resolve(false)
    s.setNeighbours(current, next, previous)
    promise.resolve(true)
  }

  /**
   * The running server for this key and backend config, built when there is none or the config changed. Rejects [promise]
   * and returns null on a refused config (no profile, bad key); throws on any other failure.
   */
  private fun ensureServer(libraryKeyBase64: String, config: ReadableMap, promise: Promise): PlaybackHttpServer? {
    // STOR-BW-11: a streaming session must name its profile; refuse here rather than open a session without one.
    if (configKind(config) == "storage-tunnel" && streamingProfileId(config).isNullOrBlank()) {
      Log.e(TAG, "startProxy.profile_required kind=storage-tunnel")
      promise.reject("playback_profile_required", "profile_required")
      return null
    }
    val libraryKey = Base64.decode(libraryKeyBase64, Base64.NO_WRAP)
    if (libraryKey.size != 32) {
      promise.reject("playback_bridge_error", "library_key_size_invalid: ${libraryKey.size}")
      return null
    }
    // Reuse the running server only for the SAME backend + keys (React remount
    // in fast-refresh, etc). A leaked server of another kind (offline vs
    // streaming), key, token or gateway set must never serve this session.
    val fingerprint = "$libraryKeyBase64|${config.toHashMap()}"
    val existing = server
    if (existing != null && fingerprint == serverFingerprint) {
      Log.i(TAG, "startProxy.reuse base=${existing.baseUrl()}")
      return existing
    }
    if (existing != null) {
      Log.i(TAG, "startProxy.rebuild kind=${configKind(config)} reason=config_changed")
      existing.stop()
      server = null
      serverFingerprint = null
    }
    val masterKey = MediaCrypto.deriveMasterKey(libraryKey)
    var built: PlaybackHttpServer? = null
    val fetcher = PlaybackSetup.buildChunkFetcher(
      reactApplicationContext,
      config,
      masterKey,
      profileId = streamingProfileId(config),
      onTraffic = { json -> trafficOwner?.emitTraffic(json) },
      onTrafficReport = { report -> built?.setTrafficHigh(report.high) },
      onDownloaded = { bytes, ms -> trafficOwner?.emitDownloaded(bytes, ms) },
    )
    val s = PlaybackHttpServer(fetcher)
    s.start()
    built = s
    s.setBufferCap(bufferCapSeconds)
    server = s
    serverFingerprint = fingerprint
    Log.i(TAG, "startProxy.fresh kind=${configKind(config)} base=${s.baseUrl()}")
    return s
  }

  private fun configKind(config: ReadableMap): String =
    (if (config.hasKey("clientKind")) config.getString("clientKind") else null) ?: "storage-tunnel"

  private fun streamingProfileId(config: ReadableMap): String? =
    if (config.hasKey("profileId")) config.getString("profileId") else null

  /** Tear the server down explicitly. */
  @ReactMethod
  fun stopProxy(promise: Promise) {
    try {
      server?.stop()
      server = null
      serverFingerprint = null
      promise.resolve(true)
    } catch (e: Throwable) {
      promise.reject("playback_bridge_error", e.message ?: "unknown", e)
    }
  }

  /**
   * High-traffic playback buffer (STOR-BW-01), called by JS with the silo's `playbackBufferSeconds` while it is high and
   * 0 when traffic is normal again: the proxy's look-ahead and mpv's `cache-secs` / `demuxer-readahead-secs` shrink to it.
   * The mpv properties are best effort (no live core = nothing to change; the next player starts with the normal ones).
   */
  @ReactMethod
  fun setBufferCap(seconds: Double, promise: Promise) {
    try {
      bufferCapSeconds = seconds
      server?.setBufferCap(seconds)
      try {
        MediaProxyHooks.onBufferCap?.invoke(seconds)
      } catch (e: Throwable) {
        Log.d(TAG, "bufferCap.player_skipped: ${e.message}")
      }
      Log.i(TAG, "bufferCap seconds=$seconds cacheSecs=${TrafficBuffer.cacheSecs(seconds)} readaheadSecs=${TrafficBuffer.readaheadSecs(seconds)}")
      promise.resolve(true)
    } catch (e: Throwable) {
      promise.reject("playback_bridge_error", e.message ?: "unknown", e)
    }
  }

  /**
   * Make-before-break rung switch (PLAY-ABR-04): fetches the rung [variantId]'s segment at [atSeconds] (with its init and
   * the audio there) while the player plays on, and resolves once it is all here, so the reload onto that rung shows its
   * first frame without waiting on the network. Rejects on a fetch failure or a rung the session does not have; JS then
   * reloads anyway. See [SegmentPrefetcher.beginSwitch].
   */
  @ReactMethod
  fun warmRung(variantId: String, atSeconds: Double, promise: Promise) {
    val s = server ?: return promise.reject("playback_bridge_error", "no_proxy")
    try {
      val begun = s.beginRungSwitch(variantId, atSeconds) { error ->
        if (error == null) promise.resolve(true) else promise.reject("warm_failed", error.message ?: "unknown", error)
      }
      if (!begun) promise.reject("warm_unknown_variant", variantId)
    } catch (e: Throwable) {
      promise.reject("playback_bridge_error", e.message ?: "unknown", e)
    }
  }

  companion object {
    private const val TAG = "PlaybackBridge"

    /** Device event JS (`PlaybackBridge.onTraffic`) listens to: the gateway's traffic answers, see [StorageTunnelClient]. */
    private const val TRAFFIC_EVENT = "SpacePlaybackTraffic"

    /** Device event JS (`MediaProxy.onDownload`) listens to: `{ bytes, ms }` of each object the player's fetches downloaded. */
    private const val DOWNLOAD_EVENT = "SpacePlaybackDownload"

    /**
     * The live module's emitter. The proxy outlives a JS reload (it is reused for the same backend), so its tunnel client
     * reaches the current module through here, never through the one that created it.
     */
    @Volatile private var trafficOwner: PlaybackBridge? = null
  }
}
