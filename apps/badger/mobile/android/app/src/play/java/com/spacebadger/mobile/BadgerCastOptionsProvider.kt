package com.spacebadger.mobile

import android.content.Context
import com.google.android.gms.cast.framework.CastOptions
import com.google.android.gms.cast.framework.media.CastMediaOptions
import com.reactnative.googlecast.GoogleCastOptionsProvider
import com.reactnative.googlecast.RNGCExpandedControllerActivity

/**
 * Google Cast options of the Badger app (UX-TV-03), set in the manifest instead of the library's own provider: the
 * SDK shows no notification and keeps no media session of its own. The cast screen drives the app's own OS media
 * session instead (`@space/mobile-media-session`, PLAY-OSMEDIA-01), the one the player and the TV remote use: one
 * card with the Badger glyph, a foreground service that keeps the phone serving the film with the screen off, and
 * the headset and lock-screen play/pause reaching the TV. Two cards (the SDK's and ours) would also fight over
 * those keys. Everything else is the library's default: Google's Default Media Receiver and its expanded controller.
 */
class BadgerCastOptionsProvider : GoogleCastOptionsProvider() {
  override fun getCastOptions(context: Context): CastOptions {
    val media = CastMediaOptions.Builder()
      .setNotificationOptions(null)
      .setMediaSessionEnabled(false)
      .setExpandedControllerActivityClassName(RNGCExpandedControllerActivity::class.java.name)
      .build()
    return CastOptions.Builder()
      .setReceiverApplicationId(getReceiverApplicationId(context))
      .setCastMediaOptions(media)
      .build()
  }
}
