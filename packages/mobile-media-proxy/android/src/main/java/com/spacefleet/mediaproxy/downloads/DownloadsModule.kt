package com.spacefleet.mediaproxy.downloads

import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * `NativeModules.DownloadsBridge` — thin JS surface over [DownloadEngine].
 * All decisions (what to download, space checks, Wi-Fi policy at enqueue time)
 * live in JS (`apps/badger/mobile/src/lib/downloads`); native only executes,
 * persists and resumes. Progress is pushed as the `SpaceDownloadsChanged`
 * device event carrying the full state JSON (see [DownloadEngine.stateJson]).
 *
 * Calls are dispatched on a private executor: enqueue persists large object
 * lists and must not block the bridge thread.
 */
class DownloadsModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "DownloadsBridge-io") }
  private val engine: DownloadEngine get() = DownloadEngine.get(reactContext.applicationContext)

  override fun getName(): String = "DownloadsBridge"

  override fun initialize() {
    super.initialize()
    engine.listener = { json ->
      if (reactContext.hasActiveReactInstance()) {
        reactContext
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit(EVENT_NAME, json)
      }
    }
  }

  override fun invalidate() {
    engine.listener = null
    // Let queued calls finish, then retire the thread; a JS reload creates a fresh module + executor.
    io.shutdown()
    super.invalidate()
  }

  @ReactMethod
  fun configure(authToken: String, appId: String, wifiOnly: Boolean, labelsJson: String, promise: Promise) {
    run(promise) {
      engine.configure(authToken, appId, wifiOnly, labelsJson)
      true
    }
  }

  /**
   * @param itemJson `{ id, mediaId, title, subtitle, kind, seasonNumber, episodeNumber,
   *                    quality, formatId, codec, estimatedBytes, gatewayCandidates[],
   *                    objects: [[key, sizeBytes], ...] }`
   */
  @ReactMethod
  fun enqueue(itemJson: String, promise: Promise) {
    run(promise) {
      val o = JSONObject(itemJson)
      val arr = o.getJSONArray("objects")
      val objects = List(arr.length()) {
        val pair = arr.getJSONArray(it)
        DownloadObject(pair.getString(0), pair.optLong(1, 0L))
      }
      o.put("totalObjects", objects.size)
      val item = DownloadItem.fromJson(o)
      engine.enqueue(item, objects)
      true
    }
  }

  @ReactMethod
  fun retry(id: String, gatewayCandidatesJson: String?, promise: Promise) {
    run(promise) {
      val candidates = gatewayCandidatesJson?.let {
        val arr = JSONArray(it)
        List(arr.length()) { i -> arr.getString(i) }
      }
      engine.retry(id, candidates)
      true
    }
  }

  @ReactMethod
  fun remove(idsJson: String, promise: Promise) {
    run(promise) {
      val arr = JSONArray(idsJson)
      engine.remove(List(arr.length()) { arr.getString(it) })
      true
    }
  }

  @ReactMethod
  fun resume(promise: Promise) {
    run(promise) {
      engine.resume()
      true
    }
  }

  @ReactMethod
  fun getState(promise: Promise) {
    run(promise) { engine.stateJson() }
  }

  /** `{ networkType, freeBytes }` — inputs of the JS-side start decision. */
  @ReactMethod
  fun getStatus(promise: Promise) {
    run(promise) {
      JSONObject().apply {
        put("networkType", engine.networkType())
        put("freeBytes", engine.freeBytes())
      }.toString()
    }
  }

  // Required by NativeEventEmitter on the JS side; DeviceEventEmitter needs no-ops.
  @ReactMethod
  fun addListener(eventName: String) = Unit

  @ReactMethod
  fun removeListeners(count: Int) = Unit

  private fun run(promise: Promise, block: () -> Any) {
    io.execute {
      try {
        promise.resolve(block())
      } catch (e: Throwable) {
        Log.e(TAG, "call.failed", e)
        promise.reject("downloads_bridge_error", e.message ?: e.javaClass.simpleName, e)
      }
    }
  }

  companion object {
    private const val TAG = "DownloadsModule"
    const val EVENT_NAME = "SpaceDownloadsChanged"
  }
}
