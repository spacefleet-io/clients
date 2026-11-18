package com.spacefleet.mediaproxy

import android.os.Build
import android.util.Log
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule

/**
 * `SpaceAppInfo` (REL-CD-29): what the phone apps (Badger, Parrot) state about their build on every API call. It lives
 * in this package because it is the one native library both apps already link on every platform.
 * - `appVersion`: the store version (`versionName`).
 * - `installer`: the package name of the app that installed this build (Play, an F-Droid client, Obtainium, the system
 *   package installer), or "" when unknown. JS maps it to a coarse family (`@space/shared/installSource`); the raw name
 *   never leaves the device.
 */
class AppInfoModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val tag = "SpaceAppInfo"

  override fun getName(): String = "SpaceAppInfo"

  override fun getConstants(): Map<String, Any> {
    val packageManager = context.packageManager
    val packageName = context.packageName
    val version = try {
      packageManager.getPackageInfo(packageName, 0).versionName ?: ""
    } catch (error: Exception) {
      Log.e(tag, "appVersion.failed", error)
      ""
    }
    val installer = try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        packageManager.getInstallSourceInfo(packageName).installingPackageName
      } else {
        @Suppress("DEPRECATION")
        packageManager.getInstallerPackageName(packageName)
      } ?: ""
    } catch (error: Exception) {
      Log.e(tag, "installer.failed", error)
      ""
    }
    Log.i(tag, "constants version=$version installer=$installer")
    return mapOf("appVersion" to version, "installer" to installer)
  }
}
