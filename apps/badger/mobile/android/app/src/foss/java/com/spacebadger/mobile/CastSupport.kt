package com.spacebadger.mobile

import android.app.Activity

/**
 * The Google-free build (SF_FOSS=1, PLAT-MOBILE-06) has no Google Cast: the Cast SDK is Google Play services. The
 * Play build's CastSupport is in src/play.
 */
@Suppress("UNUSED_PARAMETER")
class CastSupport(activity: Activity, television: Boolean) {
  fun onCreate() = Unit

  fun onStart() = Unit

  fun onStop() = Unit
}
