package com.spacefleet.mediaproxy

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager
import com.spacefleet.mediaproxy.downloads.DownloadsModule

/**
 * Registers the `PlaybackBridge` native module (the loopback decrypt proxy shared by Badger (mpv) and Parrot (ExoPlayer)),
 * `CastServer` (the LAN HLS server that feeds a cast target, UX-TV-03), `DownloadsBridge` (offline downloads into the
 * encrypted [OfflineStore]: Badger's titles, Parrot's kept songs, OFFL-FILE-03, PAR-OFFL-01) and `SpaceAppInfo` (the
 * build's version and installer, stated to the API, REL-CD-29).
 */
class MediaProxyPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(PlaybackBridge(reactContext), CastServerModule(reactContext), DownloadsModule(reactContext), AppInfoModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
