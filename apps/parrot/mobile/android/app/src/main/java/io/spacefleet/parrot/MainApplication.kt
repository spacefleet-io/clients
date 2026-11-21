package io.spacefleet.parrot

import android.app.Application
import android.util.Log
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.common.assets.ReactFontManager
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {
  // Every native module is autolinked (react-native.config.js lists the workspace ones).
  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(context = applicationContext, packageList = PackageList(this).packages)
  }

  override fun onCreate() {
    super.onCreate()
    // The TV app (PAR-TV-01) is Badger TV's look with Parrot's green (Chris 2026-11-20): the family's TV views ask for
    // Inter and Space Grotesk (theme.ts font.family), registered under the iOS family names as Badger's MainApplication
    // does. The phone keeps the system font it has always shown, so they are registered on a TV only.
    if (isTelevision()) {
      ReactFontManager.getInstance().addCustomFont(this, "Inter", R.font.inter)
      ReactFontManager.getInstance().addCustomFont(this, "Space Grotesk", R.font.space_grotesk)
      Log.i("parrot.app", "TV fonts registered: Inter, Space Grotesk")
    }
    loadReactNative(this)
    ModalWindows.install(reactHost)
  }
}
