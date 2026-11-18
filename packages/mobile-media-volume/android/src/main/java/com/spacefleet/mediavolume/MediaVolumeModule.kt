package com.spacefleet.mediavolume

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.os.Build
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * The phone's media volume (STREAM_MUSIC, the stream the hardware volume keys move during playback) as 0..1, shared
 * by both phone apps: Badger's player gestures and Parrot's player screen slider (PAR-PLAY-05).
 */
class MediaVolumeModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    private val audioManager: AudioManager
        get() = reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    private var listeners = 0
    private var receiver: BroadcastReceiver? = null
    private var lastIndex = -1

    override fun getName() = NAME

    private fun level(am: AudioManager): Double {
        val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
        return am.getStreamVolume(AudioManager.STREAM_MUSIC).toDouble() / max
    }

    @ReactMethod
    fun getMediaVolume(promise: Promise) {
        promise.resolve(level(audioManager))
    }

    /** Sets the media volume from 0..1 (0 = mute) without the system volume panel; resolves the applied level. */
    @ReactMethod
    fun setMediaVolume(level: Double, promise: Promise) {
        val am = audioManager
        val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
        val index = Math.round(level.coerceIn(0.0, 1.0) * max).toInt()
        try {
            am.setStreamVolume(AudioManager.STREAM_MUSIC, index, 0)
            Log.i(TAG, "set level=$level index=$index/$max")
            promise.resolve(index.toDouble() / max)
        } catch (e: SecurityException) {
            // Do Not Disturb can refuse volume changes.
            Log.w(TAG, "set refused: ${e.message}")
            promise.reject("volume_denied", e.message)
        }
    }

    /** NativeEventEmitter bookkeeping: the receiver runs only while JS listens to `mediaVolumeChanged`. */
    @ReactMethod
    fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {
        listeners += 1
        if (receiver != null) return
        val r = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                // Every stream's change arrives here (ring, alarm...): emit only when the media index really moved.
                val am = audioManager
                val index = am.getStreamVolume(AudioManager.STREAM_MUSIC)
                if (index == lastIndex) return
                lastIndex = index
                val value = level(am)
                Log.i(TAG, "changed index=$index level=$value")
                if (reactApplicationContext.hasActiveReactInstance()) {
                    reactApplicationContext
                        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                        .emit(CHANGED_EVENT, value)
                }
            }
        }
        lastIndex = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC)
        // The volume keys, the system panel, Bluetooth and `setMediaVolume` all send this system broadcast.
        val filter = IntentFilter(VOLUME_CHANGED_ACTION)
        if (Build.VERSION.SDK_INT >= 33) {
            reactApplicationContext.registerReceiver(r, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            reactApplicationContext.registerReceiver(r, filter)
        }
        receiver = r
    }

    @ReactMethod
    fun removeListeners(count: Double) {
        listeners = (listeners - count.toInt()).coerceAtLeast(0)
        if (listeners == 0) unregister()
    }

    private fun unregister() {
        receiver?.let { runCatching { reactApplicationContext.unregisterReceiver(it) } }
        receiver = null
    }

    override fun invalidate() {
        unregister()
        super.invalidate()
    }

    companion object {
        const val NAME = "MediaVolume"
        const val CHANGED_EVENT = "mediaVolumeChanged"
        private const val TAG = "MediaVolume"
        private const val VOLUME_CHANGED_ACTION = "android.media.VOLUME_CHANGED_ACTION"
    }
}
