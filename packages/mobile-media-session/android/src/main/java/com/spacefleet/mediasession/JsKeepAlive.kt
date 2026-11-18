package com.spacefleet.mediasession

import android.os.Handler
import android.os.SystemClock
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Keeps the app's JS timers running while the app is not in front, for as long as the card stands for something that
 * plays, and for a short while after any card or headset press (PLAY-OSMEDIA-01 item 4). React Native stops JS timers
 * once the app leaves the front unless a headless JS task is running, and the players behind the card (Badger's mpv
 * snapshot poll, the next episode's loading) live on those timers: without this, a next pressed on the lock screen
 * only took effect back in the app, and the card's position froze. The task is `KEEP_ALIVE_TASK`, registered by
 * `@space/mobile-media-session`; it waits for `KEEP_ALIVE_END_EVENT` with its token. Main thread only.
 */
internal class JsKeepAlive(private val context: ReactApplicationContext, private val main: Handler) {
    private var taskId: Int? = null
    private var token = 0
    private var playing = false
    private var graceUntilMs = 0L
    private val graceOver = Runnable { sync("grace_over") }

    /** The card's plan changed: keep JS running while it says playing. */
    fun setPlaying(value: Boolean, reason: String) {
        playing = value
        sync(reason)
    }

    /**
     * A card or headset press reached JS: keep it running for [GRACE_MS], so what the press starts (a resume, the next
     * episode closing one player and opening another) can finish and report back even while the card is released.
     */
    fun onAction() {
        graceUntilMs = SystemClock.elapsedRealtime() + GRACE_MS
        main.removeCallbacks(graceOver)
        main.postDelayed(graceOver, GRACE_MS)
        sync("action")
    }

    /** The React instance is going away: end the task now, grace or not. */
    fun stop() {
        main.removeCallbacks(graceOver)
        playing = false
        graceUntilMs = 0L
        sync("stop")
    }

    private fun sync(reason: String) {
        val wanted = playing || SystemClock.elapsedRealtime() < graceUntilMs
        if (wanted && taskId == null) start(reason) else if (!wanted && taskId != null) finish(reason)
    }

    private fun start(reason: String) {
        if (!context.hasActiveReactInstance()) {
            Log.w(TAG, "media_session.keep_alive_skipped reason=$reason (no React instance)")
            return
        }
        token += 1
        val data = Arguments.createMap().apply { putInt("token", token) }
        taskId = try {
            HeadlessJsTaskContext.getInstance(context)
                .startTask(HeadlessJsTaskConfig(KEEP_ALIVE_TASK, data, 0, /* isAllowedInForeground= */ true))
        } catch (error: RuntimeException) {
            Log.w(TAG, "media_session.keep_alive_failed reason=$reason", error)
            null
        }
        Log.i(TAG, "media_session.keep_alive_start reason=$reason task=$taskId token=$token")
    }

    private fun finish(reason: String) {
        val id = taskId ?: return
        taskId = null
        HeadlessJsTaskContext.getInstance(context).finishTask(id)
        if (context.hasActiveReactInstance()) {
            val payload = Arguments.createMap().apply { putInt("token", token) }
            context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(KEEP_ALIVE_END_EVENT, payload)
        }
        Log.i(TAG, "media_session.keep_alive_end reason=$reason task=$id token=$token")
    }

    companion object {
        private const val TAG = "SpaceMediaSession"
        const val KEEP_ALIVE_TASK = "SpaceMediaSessionKeepAlive"
        const val KEEP_ALIVE_END_EVENT = "SpaceMediaSessionKeepAliveEnd"
        const val GRACE_MS = 15_000L
    }
}
