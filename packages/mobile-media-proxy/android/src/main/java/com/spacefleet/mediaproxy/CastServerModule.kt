package com.spacefleet.mediaproxy

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.PowerManager
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.net.Inet4Address

/**
 * `NativeModules.CastServer`: the LAN half of casting (UX-TV-03). A second [PlaybackHttpServer] fed by the same ingest
 * metadata parser and chunk fetcher as the player proxy ([PlaybackSetup]), but listening on the phone's Wi-Fi IPv4 address
 * instead of loopback, answering only under the one-time `/cast/<token>/` path (see [LanBinding]) and sending CORS headers
 * (the Cast receiver fetches playlists, segments and subtitles cross-origin).
 *
 * The JS side (apps/badger/mobile/src/lib/cast) decides WHAT is served (one playable video version, the playable audio,
 * the chosen text subtitle) by trimming the metadata, mints the token, and converts the chosen subtitle to WebVTT
 * ([readText] -> toWebVtt -> [putText]). This module only serves: it decrypts and repackages nothing it is not told to.
 *
 * One cast at a time: [start] stops a running cast server first, [stop] is idempotent. A bridge teardown stops it too, so
 * the address never outlives the app.
 *
 * While the server runs it holds a partial wake lock and a Wi-Fi lock ([KeepAwake]): the receiver pulls every segment
 * from the phone, so a phone whose screen goes off must keep its CPU and Wi-Fi up for the whole film. Without them the
 * screen-off cast on the 9 Pro stopped being served 5 s in (UX-TV-03 notes, 2026-11-09).
 */
class CastServerModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "CastServer"

  @Volatile private var server: PlaybackHttpServer? = null
  private val keepAwake = KeepAwake(reactContext)

  @ReactMethod
  fun start(metadataJson: String, libraryKeyBase64: String, config: ReadableMap, token: String, promise: Promise) {
    val startedAt = System.currentTimeMillis()
    try {
      if (!TOKEN.matches(token)) {
        promise.reject("cast_server_error", "cast_token_malformed")
        return
      }
      // STOR-BW-11: a streaming cast opens a tunnel session too, so it must name its profile like the player proxy.
      val kind = (if (config.hasKey("clientKind")) config.getString("clientKind") else null) ?: "storage-tunnel"
      val profileId = if (config.hasKey("profileId")) config.getString("profileId") else null
      if (kind == "storage-tunnel" && profileId.isNullOrBlank()) {
        promise.reject("playback_profile_required", "profile_required")
        return
      }
      val libraryKey = Base64.decode(libraryKeyBase64, Base64.NO_WRAP)
      if (libraryKey.size != 32) {
        promise.reject("cast_server_error", "library_key_size_invalid: ${libraryKey.size}")
        return
      }
      val masterKey = MediaCrypto.deriveMasterKey(libraryKey)
      val session = PlaybackSetup.parseSession(metadataJson)
      val address = wifiAddress()
      if (address == null) {
        promise.reject("cast_no_wifi", "cast_no_wifi: the phone is not on a Wi-Fi network")
        return
      }

      server?.stop()
      server = null
      // Its own spool (the player's is wiped whenever a spool is created or cleared) and a traffic sink: the tunnel only
      // renews its gateway session (about every 10 minutes) while a sink is set, and the sink carries a stop or a
      // refusal to the cast screen.
      val fetcher = PlaybackSetup.buildChunkFetcher(
        reactApplicationContext, config, masterKey, spoolDir = "cast-spool", profileId = profileId, onTraffic = ::emitTraffic,
      )
      val s = PlaybackHttpServer(fetcher, LanBinding(address, token))
      val port = s.start()
      val warmFrom = if (config.hasKey("castStartSeconds")) config.getDouble("castStartSeconds") else 0.0
      val masterUrl = s.createSession(session, warmFrom)
      server = s
      keepAwake.acquire()
      // The token is a credential for the whole local network: log that a cast started, never the URL.
      Log.i(TAG, "start host=${address.hostAddress} port=$port videos=${session.videos.size} audio=${session.audio.size} subs=${session.subtitles.size} elapsedMs=${System.currentTimeMillis() - startedAt}")
      val result = Arguments.createMap()
      result.putString("baseUrl", s.baseUrl())
      result.putString("masterUrl", masterUrl)
      result.putString("host", address.hostAddress)
      result.putInt("port", port)
      promise.resolve(result)
    } catch (e: Throwable) {
      Log.e(TAG, "start.error", e)
      stopServer()
      promise.reject("cast_server_error", e.message ?: "unknown", e)
    }
  }

  @ReactMethod
  fun readText(key: String, promise: Promise) {
    val s = server
    if (s == null) {
      promise.reject("cast_server_error", "cast_server_not_running")
      return
    }
    // Off the bridge thread: the object comes through the storage tunnel.
    Thread({
      try {
        promise.resolve(s.readText(key))
      } catch (e: Throwable) {
        Log.e(TAG, "readText.error key=$key", e)
        promise.reject("cast_server_error", e.message ?: "unknown", e)
      }
    }, "CastServer-readText").apply { isDaemon = true; start() }
  }

  @ReactMethod
  fun putText(key: String, body: String, promise: Promise) {
    val s = server
    if (s == null) {
      promise.reject("cast_server_error", "cast_server_not_running")
      return
    }
    s.putText(key, body)
    promise.resolve(true)
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      stopServer()
      promise.resolve(true)
    } catch (e: Throwable) {
      promise.reject("cast_server_error", e.message ?: "unknown", e)
    }
  }

  override fun invalidate() {
    stopServer()
    super.invalidate()
  }

  private fun emitTraffic(json: String) {
    if (!reactApplicationContext.hasActiveReactInstance()) return
    reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(TRAFFIC_EVENT, json)
  }

  private fun stopServer() {
    server?.stop()
    server = null
    keepAwake.release()
  }

  /** The IPv4 address of the Wi-Fi network (the one a Cast device on the same LAN can reach), or null off Wi-Fi. */
  @Suppress("DEPRECATION")
  private fun wifiAddress(): Inet4Address? {
    val cm = reactApplicationContext.getSystemService(ConnectivityManager::class.java) ?: return null
    for (network in cm.allNetworks) {
      val caps = cm.getNetworkCapabilities(network) ?: continue
      if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) continue
      val v4 = cm.getLinkProperties(network)?.linkAddresses?.map { it.address }?.filterIsInstance<Inet4Address>()?.firstOrNull { !it.isLoopbackAddress }
      if (v4 != null) return v4
    }
    return null
  }

  companion object {
    private const val TAG = "CastServer"

    /** Device event JS (`CastServer.onTraffic`) listens to: the gateway's traffic answers, as `SpacePlaybackTraffic` carries them. */
    private const val TRAFFIC_EVENT = "SpaceCastTraffic"
    private val TOKEN = Regex("^[A-Za-z0-9_-]{32}$")
  }
}

/**
 * The partial wake lock and Wi-Fi lock a running cast server holds (see [CastServerModule]). Both are reference-free, so
 * a second [acquire] is a no-op and [release] is idempotent. The wake lock carries a safety timeout well past any film,
 * so a lock leaked by a crash before [release] cannot drain the battery for good.
 */
internal class KeepAwake(private val context: Context) {
  private var wake: PowerManager.WakeLock? = null
  private var wifi: WifiManager.WifiLock? = null

  @Synchronized
  fun acquire() {
    if (wake?.isHeld == true) return
    try {
      wake = context.getSystemService(PowerManager::class.java)
        ?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "spacefleet:cast-server")
        ?.apply { setReferenceCounted(false); acquire(MAX_HOLD_MS) }
      // HIGH_PERF keeps Wi-Fi out of power save with the screen off (Android 14 made it best-effort; it is still what
      // exists for a screen-off server, LOW_LATENCY only applies while the app is in front).
      @Suppress("DEPRECATION")
      wifi = context.applicationContext.getSystemService(WifiManager::class.java)
        ?.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "spacefleet:cast-server")
        ?.apply { setReferenceCounted(false); acquire() }
      Log.i(TAG, "keepAwake.acquired wake=${wake?.isHeld} wifi=${wifi?.isHeld}")
    } catch (e: Throwable) {
      // Missing permission or a refusing OS: the cast still plays with the screen on.
      Log.w(TAG, "keepAwake.failed msg=${e.message}")
    }
  }

  @Synchronized
  fun release() {
    val held = wake?.isHeld == true || wifi?.isHeld == true
    try { wake?.takeIf { it.isHeld }?.release() } catch (_: Throwable) {}
    try { wifi?.takeIf { it.isHeld }?.release() } catch (_: Throwable) {}
    wake = null
    wifi = null
    if (held) Log.i(TAG, "keepAwake.released")
  }

  private companion object {
    const val TAG = "CastServer"
    /** Longest a cast may hold the CPU awake: 6 h, longer than any film or episode run on one screen. */
    const val MAX_HOLD_MS = 6 * 60 * 60 * 1000L
  }
}
