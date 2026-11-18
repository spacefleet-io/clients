package com.spacebadger.mobile

import android.app.Activity
import android.util.Log
import androidx.mediarouter.media.MediaRouter
import androidx.mediarouter.media.MediaRouterParams
import com.reactnative.googlecast.api.RNGCCastContext
import com.spacefleet.mediasession.SessionHub

/**
 * Google Cast in the Play build (UX-TV-03), driven by [MainActivity]'s lifecycle. The Google-free build (SF_FOSS=1)
 * compiles src/foss's CastSupport instead, which does nothing.
 */
class CastSupport(private val activity: Activity, private val television: Boolean) {
  /** Holds the Cast discovery request while the app is visible on a phone (see [onStart]). */
  private val castDiscovery = object : MediaRouter.Callback() {}

  fun onCreate() {
    // The SDK's CastContext must exist before the first session / discovery call from JS.
    // The receiver is Google's default media receiver (BadgerCastOptionsProvider, set in the manifest).
    val cast = RNGCCastContext.getSharedInstance(activity)
    if (!television) {
      useClassicCastRoutes()
      // Once per process: the phone's volume keys reach the TV through the app's media session.
      if (cast != null && SessionHub.remoteVolume == null) SessionHub.remoteVolume = CastRemoteVolume(cast)
    }
  }

  /**
   * The Cast SDK turns on media transfer, so MediaRouter lists the Cast devices through the system's MediaRouter2
   * (`CastMediaRoute2ProviderService_Persistent`). Selecting a route there makes Play services republish its list
   * empty for ~200 ms ("Published 0 routes"); MediaRouter then unselects the route (reason 3) and the session never
   * starts: on a Google TV (MiTV-AFMU1) the first cast after the app opened stuck on "Connecting". The app has no
   * output-switcher use for transfer, so it routes through Play services' own provider instead.
   */
  private fun useClassicCastRoutes() {
    val router = MediaRouter.getInstance(activity)
    val params = router.routerParams
    val builder = if (params == null) MediaRouterParams.Builder() else MediaRouterParams.Builder(params)
    router.setRouterParams(builder.setMediaTransferReceiverEnabled(false).setTransferToLocalEnabled(false).build())
    Log.i("BadgerCast", "routerParams transferReceiver=false (was ${params?.isMediaTransferReceiverEnabled})")
  }

  /**
   * Asks for Cast discovery while the app is visible on a phone. react-native-google-cast only listens to MediaRouter
   * without asking for discovery (its startDiscovery does nothing on Android), and the app has no Cast button that
   * would ask. The active scan keeps the device list fresh instead of a cached one; the route that vanished at session
   * start is fixed by [useClassicCastRoutes]. Stopped in [onStop], as Google advises.
   */
  fun onStart() {
    if (television) return
    val selector = RNGCCastContext.getSharedInstance(activity)?.mergedSelector ?: return
    MediaRouter.getInstance(activity).addCallback(
      selector,
      castDiscovery,
      MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY or MediaRouter.CALLBACK_FLAG_PERFORM_ACTIVE_SCAN,
    )
  }

  fun onStop() {
    if (!television) MediaRouter.getInstance(activity).removeCallback(castDiscovery)
  }
}
