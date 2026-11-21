package com.spacefleet.audioplayback

import android.content.ComponentName
import android.content.Intent
import android.media.MediaRouter2
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.WindowManager
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.common.util.concurrent.ListenableFuture
import java.util.concurrent.Executor
import org.json.JSONArray
import org.json.JSONObject

/**
 * JS face of `AudioPlaybackService`: a MediaController on the main thread. Every call connects the controller once
 * (which starts the service) and then acts on it; state changes reach JS as `AudioPlaybackState` events.
 */
class AudioPlaybackModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    private val main = Handler(Looper.getMainLooper())
    private val mainExecutor = Executor { main.post(it) }
    private var controllerFuture: ListenableFuture<MediaController>? = null

    private val listener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) {
            val state = snapshot(player)
            Log.i(TAG, "audio.state ${state.toHashMap()}")
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(STATE_EVENT, snapshot(player))
        }
    }

    override fun getName() = NAME

    private fun withController(promise: Promise, block: (MediaController) -> Any?) {
        main.post {
            val future = controllerFuture ?: MediaController.Builder(
                reactApplicationContext,
                SessionToken(reactApplicationContext, ComponentName(reactApplicationContext, AudioPlaybackService::class.java)),
            ).buildAsync().also { built ->
                controllerFuture = built
                built.addListener({ runCatching { built.get().addListener(listener) } }, mainExecutor)
            }
            future.addListener({
                try {
                    promise.resolve(block(future.get()))
                } catch (error: Exception) {
                    // A failed connection is retried on the next call.
                    if (future.isDone && runCatching { future.get() }.isFailure) controllerFuture = null
                    Log.w(TAG, "audio.call_failed", error)
                    promise.reject("audio_playback_failed", error.message, error)
                }
            }, mainExecutor)
        }
    }

    /**
     * `itemsJson`: `[{id, url, mimeType?, title, artist?, album?, artworkUri?}]`. Replaces the queue and plays from
     * `startIndex`. `artworkUri` (a local `file://` picture) is the cover the notification and lock-screen card show.
     */
    @ReactMethod
    fun setQueue(itemsJson: String, startIndex: Double, startPositionMs: Double, promise: Promise) {
        val items = parseItems(itemsJson)
        withController(promise) { controller ->
            controller.setMediaItems(items, startIndex.toInt(), startPositionMs.toLong())
            controller.prepare()
            controller.play()
            snapshot(controller)
        }
    }

    /**
     * Adds songs to the queue without stopping the one playing: `where` "next" puts them right after it (Play next),
     * "end" after the last song (Add to queue), also with shuffle on ([UpNextShuffleOrder]). An empty queue starts
     * playing them.
     */
    @ReactMethod
    fun addItems(itemsJson: String, where: String, promise: Promise) {
        val items = parseItems(itemsJson)
        withController(promise) { controller ->
            val empty = controller.mediaItemCount == 0
            val atEnd = empty || where != "next"
            UpNextShuffleOrder.insertAtEnd = atEnd
            controller.addMediaItems(if (atEnd) controller.mediaItemCount else controller.currentMediaItemIndex + 1, items)
            if (empty) {
                controller.prepare()
                controller.play()
            }
            snapshot(controller)
        }
    }

    /**
     * `itemsJson`: `[{id, url, mimeType?, title, artist?, album?, artworkUri?, gainDb?, key?}]`. `artworkUri` (a local
     * `file://` picture) is the cover the notification and lock-screen card show; `gainDb` the song's even-volume gain.
     * `key` names this queue entry for the app (the state's `key` and `nextKey`); it rides in the metadata extras, which
     * reach the controller.
     */
    private fun parseItems(itemsJson: String): List<MediaItem> = JSONArray(itemsJson).let { array ->
        (0 until array.length()).map { index ->
            val item = array.getJSONObject(index)
            if (item.has("gainDb")) EvenVolume.gainsDb[item.getString("id")] = item.getDouble("gainDb").toFloat()
            MediaItem.Builder()
                .setMediaId(item.getString("id"))
                .setUri(Uri.parse(item.getString("url")))
                .apply { item.optString("mimeType").takeIf { it.isNotEmpty() }?.let { setMimeType(it) } }
                .setMediaMetadata(
                    MediaMetadata.Builder()
                        .setTitle(item.optString("title"))
                        .setArtist(item.optString("artist").ifEmpty { null })
                        .setAlbumTitle(item.optString("album").ifEmpty { null })
                        .apply { item.optString("artworkUri").takeIf { it.isNotEmpty() }?.let { setArtworkUri(Uri.parse(it)) } }
                        .apply { item.optString("key").takeIf { it.isNotEmpty() }?.let { setExtras(Bundle().apply { putString(KEY_EXTRA, it) }) } }
                        .build(),
                )
                .build()
        }
    }

    /** Changes songs' even-volume gains (album values become track values when shuffle turns on); `gainsJson`: `{id: dB}`. */
    @ReactMethod
    fun setGains(gainsJson: String, promise: Promise) {
        val gains = JSONObject(gainsJson)
        for (id in gains.keys()) EvenVolume.gainsDb[id] = gains.getDouble(id).toFloat()
        promise.resolve(null)
    }

    /** Turns the limiter of Even out volume at Loud on or off, from the next samples. */
    @ReactMethod
    fun setLimiting(on: Boolean, promise: Promise) {
        EvenVolume.limiting = on
        promise.resolve(null)
    }

    @ReactMethod
    fun play(promise: Promise) = withController(promise) { it.play(); snapshot(it) }

    @ReactMethod
    fun pause(promise: Promise) = withController(promise) { it.pause(); snapshot(it) }

    @ReactMethod
    fun next(promise: Promise) = withController(promise) { it.seekToNextMediaItem(); snapshot(it) }

    /** Restarts the track past its first 3 seconds, else goes to the previous one (the system's rule). */
    @ReactMethod
    fun previous(promise: Promise) = withController(promise) { it.seekToPrevious(); snapshot(it) }

    @ReactMethod
    fun seekTo(positionMs: Double, promise: Promise) = withController(promise) { it.seekTo(positionMs.toLong()); snapshot(it) }

    @ReactMethod
    fun getState(promise: Promise) = withController(promise) { snapshot(it) }

    /**
     * The ids of the songs that play after the current one, in the player's own order: the shuffled order with shuffle
     * on, back to the start with repeat all. Repeat one lists what Next plays.
     */
    @ReactMethod
    fun getUpNext(promise: Promise) = withController(promise) { controller ->
        val timeline = controller.currentTimeline
        val mode = if (controller.repeatMode == Player.REPEAT_MODE_ALL) Player.REPEAT_MODE_ALL else Player.REPEAT_MODE_OFF
        val ids = Arguments.createArray()
        if (!timeline.isEmpty) {
            upNextIndices(controller.currentMediaItemIndex, timeline.windowCount) { at ->
                timeline.getNextWindowIndex(at, mode, controller.shuffleModeEnabled)
            }.forEach { ids.pushString(controller.getMediaItemAt(it).mediaId) }
        }
        ids
    }

    /** Plays the queue in a shuffled order (Media3 keeps the current song and draws the rest), or back in order. */
    @ReactMethod
    fun setShuffle(enabled: Boolean, promise: Promise) = withController(promise) { it.shuffleModeEnabled = enabled; snapshot(it) }

    /** "off", "all" (the queue starts again after its last song) or "one" (the same song again). */
    @ReactMethod
    fun setRepeatMode(mode: String, promise: Promise) = withController(promise) {
        it.repeatMode = when (mode) {
            "all" -> Player.REPEAT_MODE_ALL
            "one" -> Player.REPEAT_MODE_ONE
            else -> Player.REPEAT_MODE_OFF
        }
        snapshot(it)
    }

    /** True where the phone has a system picker for where the sound plays (Android 11 and later). */
    @ReactMethod
    fun canShowOutputSwitcher(promise: Promise) = promise.resolve(Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)

    /**
     * Opens Android's own "play on" picker (phone speaker, Bluetooth, cast devices the system knows): MediaRouter2's
     * system output switcher on Android 14+, the System UI media output dialog on Android 11 to 13. Resolves false
     * when the phone has neither.
     */
    @ReactMethod
    fun showOutputSwitcher(promise: Promise) {
        main.post {
            try {
                val context = reactApplicationContext
                val shown = when {
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE ->
                        MediaRouter2.getInstance(context).showSystemOutputSwitcher()
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.R -> {
                        val intent = Intent("com.android.systemui.action.LAUNCH_MEDIA_OUTPUT_DIALOG")
                            .setPackage("com.android.systemui")
                            .putExtra("package_name", context.packageName)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        context.sendBroadcast(intent)
                        true
                    }
                    else -> false
                }
                promise.resolve(shown)
            } catch (error: Exception) {
                Log.w(NAME, "output switcher failed", error)
                promise.resolve(false)
            }
        }
    }

    /**
     * Keeps the screen awake (no screensaver, no sleep) while `enabled`: Parrot TV's Now playing and lyrics (PAR-TV-12).
     * FLAG_KEEP_SCREEN_ON on the app's window only holds while that window shows, so in the background the TV's
     * screensaver starts as usual. Resolves false without an activity.
     */
    @ReactMethod
    fun setKeepScreenOn(enabled: Boolean, promise: Promise) {
        val activity = reactApplicationContext.currentActivity
        if (activity == null) {
            Log.w(NAME, "keep_awake enabled=$enabled applied=false reason=no_activity")
            promise.resolve(false)
            return
        }
        activity.runOnUiThread {
            if (enabled) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            Log.i(NAME, "keep_awake enabled=$enabled")
            promise.resolve(true)
        }
    }

    /** Clears the queue and stops the service (sign out). */
    @ReactMethod
    fun stop(promise: Promise) = withController(promise) { controller ->
        controller.stop()
        controller.clearMediaItems()
        snapshot(controller)
    }

    @ReactMethod
    fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) = Unit

    @ReactMethod
    fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Double) = Unit

    override fun invalidate() {
        main.post {
            controllerFuture?.let { future -> MediaController.releaseFuture(future) }
            controllerFuture = null
        }
        super.invalidate()
    }

    private fun snapshot(player: Player): WritableMap = Arguments.createMap().apply {
        putString(
            "state",
            when (player.playbackState) {
                Player.STATE_IDLE -> "idle"
                Player.STATE_BUFFERING -> "buffering"
                Player.STATE_READY -> "ready"
                else -> "ended"
            },
        )
        putBoolean("playing", player.isPlaying)
        putBoolean("playWhenReady", player.playWhenReady)
        // A phone call, an alarm or a voice assistant holds the music back without a pause press (ExoPlayer keeps
        // playWhenReady and plays again by itself afterwards): the controls show paused meanwhile (PLAY-FOCUS-01 item 5).
        putBoolean("suppressed", player.playbackSuppressionReason != Player.PLAYBACK_SUPPRESSION_REASON_NONE)
        putDouble("positionMs", player.currentPosition.toDouble())
        putDouble("durationMs", if (player.duration == C.TIME_UNSET) -1.0 else player.duration.toDouble())
        putInt("index", player.currentMediaItemIndex)
        putInt("count", player.mediaItemCount)
        player.currentMediaItem?.mediaId?.let { putString("mediaId", it) } ?: putNull("mediaId")
        player.currentMediaItem?.mediaMetadata?.extras?.getString(KEY_EXTRA)?.let { putString("key", it) } ?: putNull("key")
        val nextIndex = player.nextMediaItemIndex
        val nextKey = if (nextIndex == C.INDEX_UNSET) null else player.getMediaItemAt(nextIndex).mediaMetadata.extras?.getString(KEY_EXTRA)
        nextKey?.let { putString("nextKey", it) } ?: putNull("nextKey")
        val previousIndex = player.previousMediaItemIndex
        val previousKey = if (previousIndex == C.INDEX_UNSET) null else player.getMediaItemAt(previousIndex).mediaMetadata.extras?.getString(KEY_EXTRA)
        previousKey?.let { putString("previousKey", it) } ?: putNull("previousKey")
        player.playerError?.let { putString("error", it.errorCodeName) } ?: putNull("error")
        putBoolean("shuffle", player.shuffleModeEnabled)
        putString(
            "repeat",
            when (player.repeatMode) {
                Player.REPEAT_MODE_ALL -> "all"
                Player.REPEAT_MODE_ONE -> "one"
                else -> "off"
            },
        )
    }

    companion object {
        const val NAME = "AudioPlayback"
        const val STATE_EVENT = "AudioPlaybackState"
        /** Metadata extra holding a queue item's `key`. */
        private const val KEY_EXTRA = "space.key"
        private const val TAG = "AudioPlayback"
    }
}
