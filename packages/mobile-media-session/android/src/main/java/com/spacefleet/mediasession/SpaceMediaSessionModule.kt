package com.spacefleet.mediasession

import android.content.ComponentName
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.common.util.concurrent.ListenableFuture

/**
 * JS face of the OS media session (`@space/mobile-media-session`): `update(plan)` mirrors the player into
 * `SessionHub` and keeps `SpaceMediaSessionService` bound through a MediaController; `release()` (or a `none` plan)
 * drops the card and lets the service stop. Controller commands come back as `SpaceMediaSessionAction` events.
 * `JsKeepAlive` keeps JS timers running in the background while the card plays and just after a press.
 */
class SpaceMediaSessionModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    private val main = Handler(Looper.getMainLooper())
    private var controller: ListenableFuture<MediaController>? = null
    private val keepAlive = JsKeepAlive(context, main)

    override fun getName() = NAME

    @ReactMethod
    fun update(plan: ReadableMap) {
        val parsed = parse(plan)
        main.post {
            if (!parsed.active) {
                releaseOnMain("plan_none")
                return@post
            }
            SessionHub.onAction = ::emitAction
            SessionHub.apply(parsed)
            keepAlive.setPlaying(parsed.wantsPlay, if (parsed.loading) "plan_loading" else "plan_${parsed.playbackState}")
            if (controller == null) {
                Log.i(TAG, "media_session.claim title=${parsed.title} actions=${parsed.actions}")
                controller = MediaController.Builder(
                    reactApplicationContext,
                    SessionToken(reactApplicationContext, ComponentName(reactApplicationContext, SpaceMediaSessionService::class.java)),
                ).buildAsync()
            }
        }
    }

    @ReactMethod
    fun release() {
        main.post { releaseOnMain("js_release") }
    }

    @ReactMethod
    fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) = Unit

    @ReactMethod
    fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Double) = Unit

    override fun invalidate() {
        main.post {
            keepAlive.stop()
            releaseOnMain("react_invalidate")
        }
        super.invalidate()
    }

    private fun releaseOnMain(reason: String) {
        SessionHub.onAction = null
        SessionHub.apply(null)
        keepAlive.setPlaying(false, reason)
        val future = controller ?: return
        controller = null
        MediaController.releaseFuture(future)
        // Unbound and idle: let the service go (it is a started service once Media3 put it in the foreground).
        reactApplicationContext.stopService(Intent(reactApplicationContext, SpaceMediaSessionService::class.java))
        Log.i(TAG, "media_session.release reason=$reason")
    }

    private fun emitAction(action: String, seekTimeMs: Long?, seekOffsetMs: Long?) {
        if (!reactApplicationContext.hasActiveReactInstance()) return
        keepAlive.onAction()
        val payload = Arguments.createMap().apply {
            putString("action", action)
            seekTimeMs?.let { putDouble("seekTimeMs", it.toDouble()) }
            seekOffsetMs?.let { putDouble("seekOffsetMs", it.toDouble()) }
        }
        reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(EVENT, payload)
    }

    private fun parse(plan: ReadableMap): SessionPlan {
        val actions = plan.getArray("actions")
        return SessionPlan(
            playbackState = plan.getString("playbackState") ?: "none",
            title = plan.getString("title") ?: "",
            artist = plan.getString("artist") ?: "",
            album = plan.getString("album") ?: "",
            artworkUri = if (plan.hasKey("artworkUri") && !plan.isNull("artworkUri")) plan.getString("artworkUri") else null,
            durationMs = if (plan.hasKey("durationMs") && !plan.isNull("durationMs")) plan.getDouble("durationMs").toLong() else null,
            positionMs = if (plan.hasKey("positionMs") && !plan.isNull("positionMs")) plan.getDouble("positionMs").toLong() else null,
            rate = if (plan.hasKey("rate")) plan.getDouble("rate").toFloat() else 1f,
            actions = (0 until (actions?.size() ?: 0)).mapNotNull { actions?.getString(it) }.toSet(),
            loading = plan.hasKey("loading") && plan.getBoolean("loading"),
        )
    }

    companion object {
        const val NAME = "SpaceMediaSession"
        const val EVENT = "SpaceMediaSessionAction"
        private const val TAG = "SpaceMediaSession"
    }
}
