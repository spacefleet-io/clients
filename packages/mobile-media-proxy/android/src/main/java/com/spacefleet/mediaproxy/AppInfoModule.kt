package com.spacefleet.mediaproxy

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * `SpaceAppInfo` (REL-CD-29): what the phone apps (Badger, Parrot) state about their build on every API call. It lives
 * in this package because it is the one native library both apps already link on every platform.
 * - `appVersion`: the store version (`versionName`).
 * - `installer`: the package name of the app that installed this build (Play, an F-Droid client, Obtainium, the system
 *   package installer), or "" when unknown. JS maps it to a coarse family (`@space/shared/installSource`); the raw name
 *   never leaves the device.
 * - `openInstaller()`: the update-required screen's button. Android lets an app see the app that installed it, so no
 *   `<queries>` entry is needed for either intent.
 */
class AppInfoModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val tag = "SpaceAppInfo"

  override fun getName(): String = "SpaceAppInfo"

  private fun installerName(): String = try {
    val packageManager = context.packageManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      packageManager.getInstallSourceInfo(context.packageName).installingPackageName
    } else {
      @Suppress("DEPRECATION")
      packageManager.getInstallerPackageName(context.packageName)
    } ?: ""
  } catch (error: Exception) {
    Log.e(tag, "installer.failed", error)
    ""
  }

  override fun getConstants(): Map<String, Any> {
    val version = try {
      context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: ""
    } catch (error: Exception) {
      Log.e(tag, "appVersion.failed", error)
      ""
    }
    val installer = installerName()
    Log.i(tag, "constants version=$version installer=$installer")
    return mapOf("appVersion" to version, "installer" to installer)
  }

  /**
   * Opens this app's page in the store that installed it (`market://details?id=<package>` aimed at that store: Play,
   * F-Droid clients, Aurora, Amazon and most stores answer it), else launches that store or updater (Obtainium shows
   * no page). Resolves false when the installer is unknown or opens nothing; JS then opens its web address.
   */
  @ReactMethod
  fun openInstaller(promise: Promise) {
    val installer = installerName()
    try {
      if (installer.isEmpty()) {
        Log.i(tag, "openInstaller.none")
        promise.resolve(false)
        return
      }
      val packageManager = context.packageManager
      val listing = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=${context.packageName}")).setPackage(installer)
      val intent = if (listing.resolveActivity(packageManager) != null) listing else packageManager.getLaunchIntentForPackage(installer)
      if (intent == null) {
        Log.i(tag, "openInstaller.unresolved installer=$installer")
        promise.resolve(false)
        return
      }
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      Log.i(tag, "openInstaller.opened installer=$installer listing=${intent === listing}")
      promise.resolve(true)
    } catch (error: Exception) {
      Log.e(tag, "openInstaller.failed installer=$installer", error)
      promise.resolve(false)
    }
  }
}
