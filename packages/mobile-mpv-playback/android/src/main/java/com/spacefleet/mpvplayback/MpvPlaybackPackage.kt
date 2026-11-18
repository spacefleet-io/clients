package com.spacefleet.mpvplayback

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager
import com.spacefleet.mediaproxy.MediaProxyHooks
import com.spacefleet.mediaproxy.TrafficBuffer
import com.spacefleet.mpvplayback.mpv.DecoderCaps
import com.spacefleet.mpvplayback.mpv.MpvControlModule
import com.spacefleet.mpvplayback.mpv.MpvGuard
import com.spacefleet.mpvplayback.mpv.MpvSurfaceViewManager


/**
 * SpaceBadger shared mpv playback package.
 *
 * Registers:
 *   - MpvControlModule (NativeModules.MpvControl) — playback control surface.
 *   - MpvSurfaceViewManager — exposes the libmpv-driven surface view to JS as
 *     requireNativeComponent("MpvPlayerView").
 *
 * The loopback proxy (NativeModules.PlaybackBridge) and offline downloads (NativeModules.DownloadsBridge) are
 * `@space/mobile-media-proxy`'s own package; this one plugs mpv into
 * it through [MediaProxyHooks]: the MediaCodec operating rate behind each playlist's decoder options, and mpv's cache
 * under the high-traffic buffer cap (STOR-BW-01).
 */
class MpvPlaybackPackage : ReactPackage {
  init {
    MediaProxyHooks.operatingRate = { codecString, width, height ->
      DecoderCaps.mimeForCodecString(codecString)?.let { DecoderCaps.operatingRateFor(it, width, height) }
    }
    // Best effort: no live mpv core = nothing to change; the next player starts with the normal cache.
    MediaProxyHooks.onBufferCap = { seconds ->
      MpvGuard.setPropertyString("cache-secs", TrafficBuffer.cacheSecs(seconds).toString())
      MpvGuard.setPropertyString("demuxer-readahead-secs", TrafficBuffer.readaheadSecs(seconds).toString())
    }
  }

  override fun createNativeModules(reactContext: ReactApplicationContext): MutableList<NativeModule> {
    return mutableListOf(
      MpvControlModule(reactContext),
    )
  }

  override fun createViewManagers(reactContext: ReactApplicationContext): MutableList<ViewManager<*, *>> {
    return mutableListOf(
      MpvSurfaceViewManager(reactContext),
    )
  }
}
