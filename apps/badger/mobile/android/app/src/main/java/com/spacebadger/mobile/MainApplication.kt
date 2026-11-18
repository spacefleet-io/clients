package com.spacebadger.mobile

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.common.assets.ReactFontManager
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.spacebadger.mobile.library.LibrarySyncPackage

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          // add(MyReactNativePackage())
          add(LibrarySyncPackage())
          // mpv playback (MpvControl, MpvPlayerView, PlaybackBridge) is now
          // autolinked from @space/mobile-mpv-playback via the workspace
          // package. Don't add it manually here.
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    // fontFamily names match the iOS family names (theme.ts font.family).
    ReactFontManager.getInstance().addCustomFont(this, "Inter", R.font.inter)
    ReactFontManager.getInstance().addCustomFont(this, "Space Grotesk", R.font.space_grotesk)
    loadReactNative(this)
  }
}
