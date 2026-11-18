package com.spacefleet.mediasession

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.DeviceInfo
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

/** The JS plan (`NativeMediaSessionPlan` in src/binder.ts), in milliseconds. */
data class SessionPlan(
    val playbackState: String,
    val title: String,
    val artist: String,
    val album: String,
    val artworkUri: String?,
    val durationMs: Long?,
    val positionMs: Long?,
    val rate: Float,
    val actions: Set<String>,
    /** An episode switch still loading: shown as buffering with play intent, so Media3 keeps the service foreground. */
    val loading: Boolean = false,
) {
    val active get() = playbackState == "playing" || playbackState == "paused"

    /** What keeps the service foreground and the JS keep-alive running. */
    val wantsPlay get() = playbackState == "playing" || loading
}

/**
 * The volume of the device the media plays on when that is not the phone (a Google Cast receiver), in steps of
 * `0..maxLevel`. The app supplies it (`SessionHub.remoteVolume`); while [level] is not null the session reports
 * remote playback, so the phone's volume keys move this device's volume even with the screen off (UX-TV-03).
 */
interface RemoteVolume {
    val maxLevel: Int
    /** The device's level, or null when nothing plays remotely (the phone's own volume applies). */
    fun level(): Int?
    fun muted(): Boolean
    fun setLevel(level: Int)
    fun setMuted(muted: Boolean)
}

/** Level arithmetic of [RemoteVolume]: a device volume fraction (0..1) in `steps` steps, and one key press. */
object RemoteVolumeLevels {
    fun fromFraction(fraction: Double, steps: Int): Int = Math.round(fraction * steps).toInt().coerceIn(0, steps)

    fun toFraction(level: Int, steps: Int): Double = level.coerceIn(0, steps).toDouble() / steps

    fun step(level: Int, delta: Int, max: Int): Int = (level + delta).coerceIn(0, max)
}

/**
 * Process-wide state shared by the React module (which writes the plan and listens for actions) and the
 * `SpaceMediaSessionService` (which owns the session and its `MirrorPlayer`). Main thread only.
 */
object SessionHub {
    private const val TAG = "SpaceMediaSession"
    private const val ARTWORK_MAX_PX = 512

    var plan: SessionPlan? = null
        private set
    /** When `plan` was applied (elapsedRealtime), to extrapolate the position while playing. */
    var planAtMs = 0L
        private set
    var artwork: ByteArray? = null
        private set
    private var artworkFor: String? = null
    var player: MirrorPlayer? = null
    var onAction: ((action: String, seekTimeMs: Long?, seekOffsetMs: Long?) -> Unit)? = null
    /** Set by the app; [refreshVolume] whenever its level or availability changes. */
    var remoteVolume: RemoteVolume? = null

    private val main = Handler(Looper.getMainLooper())
    private val decoder = Executors.newSingleThreadExecutor()

    fun apply(next: SessionPlan?) {
        plan = next
        planAtMs = SystemClock.elapsedRealtime()
        val uri = next?.artworkUri
        if (uri != artworkFor) {
            artworkFor = uri
            artwork = null
            if (uri != null) loadArtwork(uri)
        }
        player?.refresh()
    }

    fun emit(action: String, seekTimeMs: Long? = null, seekOffsetMs: Long? = null) {
        Log.i(TAG, "media_session.native_action action=$action seekTimeMs=$seekTimeMs seekOffsetMs=$seekOffsetMs")
        onAction?.invoke(action, seekTimeMs, seekOffsetMs)
            ?: Log.w(TAG, "media_session.native_action_dropped (no JS listener) action=$action")
    }

    /** The remote device's volume changed, or a remote device came or went: redraw the session's volume. */
    fun refreshVolume() {
        player?.refreshVolume()
    }

    /** Decodes the local poster or cover off the main thread, scaled down so the session's binder parcels stay small. */
    private fun loadArtwork(uri: String) {
        decoder.execute {
            val bytes = runCatching {
                val path = Uri.parse(uri).path ?: error("no path in $uri")
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFile(path, bounds)
                var sample = 1
                while (bounds.outWidth / (sample * 2) >= ARTWORK_MAX_PX || bounds.outHeight / (sample * 2) >= ARTWORK_MAX_PX) sample *= 2
                val bitmap = BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })
                    ?: error("undecodable image")
                ByteArrayOutputStream().use { out ->
                    bitmap.compress(Bitmap.CompressFormat.JPEG, 90, out)
                    bitmap.recycle()
                    out.toByteArray()
                }
            }.onFailure { Log.w(TAG, "media_session.artwork_failed uri=$uri", it) }.getOrNull()
            main.post {
                if (artworkFor != uri) return@post
                artwork = bytes
                Log.i(TAG, "media_session.artwork_loaded bytes=${bytes?.size ?: 0}")
                player?.refresh()
            }
        }
    }
}

/**
 * A player with nothing to play: its state mirrors the JS plan (what mpv or the TV is doing), so Media3 draws the
 * notification and lock-screen card and maps headset and Bluetooth buttons; every command a controller sends becomes a
 * `SpaceMediaSessionAction` event for the real player in JS (PLAY-OSMEDIA-01).
 */
class MirrorPlayer(looper: Looper) : SimpleBasePlayer(looper) {
    /** Optimistic play/pause until the next plan arrives, so the card answers the press at once. */
    private var pendingPlayWhenReady: Boolean? = null

    fun refresh() {
        pendingPlayWhenReady = null
        invalidateState()
    }

    /** Re-reads the state without dropping an optimistic play/pause still waiting for its plan. */
    fun refreshVolume() {
        invalidateState()
    }

    override fun getState(): State {
        val plan = SessionHub.plan
        if (plan == null || !plan.active) {
            return State.Builder().setAvailableCommands(Player.Commands.EMPTY).setPlaybackState(Player.STATE_IDLE).build()
        }
        val playing = pendingPlayWhenReady ?: plan.wantsPlay
        val metadata = MediaMetadata.Builder()
            .setTitle(plan.title)
            .setDisplayTitle(plan.title)
            .setArtist(plan.artist.ifEmpty { null })
            .setAlbumTitle(plan.album.ifEmpty { null })
            .apply { SessionHub.artwork?.let { setArtworkData(it, MediaMetadata.PICTURE_TYPE_FRONT_COVER) } }
            .build()
        val durationMs = plan.durationMs
        val item = MediaItemData.Builder(ITEM_UID)
            .setMediaItem(MediaItem.Builder().setMediaId(ITEM_UID).setMediaMetadata(metadata).build())
            .setMediaMetadata(metadata)
            .setDurationUs(if (durationMs != null) durationMs * 1000 else C.TIME_UNSET)
            .setIsSeekable(durationMs != null)
            .build()
        val positionMs = plan.positionMs ?: 0L
        val position = if (playing && plan.playbackState == "playing") {
            val elapsed = ((SystemClock.elapsedRealtime() - SessionHub.planAtMs) * plan.rate).toLong()
            PositionSupplier.getExtrapolating(positionMs + elapsed, plan.rate)
        } else {
            PositionSupplier.getConstant(positionMs)
        }
        val remote = SessionHub.remoteVolume
        val remoteLevel = remote?.level()
        return State.Builder()
            .setAvailableCommands(commandsFor(plan.actions, remoteVolume = remoteLevel != null))
            .setPlaylist(listOf(item))
            .setCurrentMediaItemIndex(0)
            .setPlaybackState(if (plan.loading) Player.STATE_BUFFERING else Player.STATE_READY)
            .setPlayWhenReady(playing, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
            .setContentPositionMs(position)
            .setPlaybackParameters(PlaybackParameters(plan.rate))
            .setSeekBackIncrementMs(SEEK_STEP_MS)
            .setSeekForwardIncrementMs(SEEK_STEP_MS)
            .apply {
                if (remote != null && remoteLevel != null) {
                    setDeviceInfo(DeviceInfo.Builder(DeviceInfo.PLAYBACK_TYPE_REMOTE).setMaxVolume(remote.maxLevel).build())
                    setDeviceVolume(remoteLevel)
                    setIsDeviceMuted(remote.muted())
                }
            }
            .build()
    }

    /** The phone's volume keys and the system volume panel, while the media plays on a remote device. */
    override fun handleSetDeviceVolume(deviceVolume: Int, flags: Int): ListenableFuture<*> {
        SessionHub.remoteVolume?.setLevel(deviceVolume)
        return Futures.immediateVoidFuture()
    }

    override fun handleIncreaseDeviceVolume(flags: Int): ListenableFuture<*> = stepVolume(1)

    override fun handleDecreaseDeviceVolume(flags: Int): ListenableFuture<*> = stepVolume(-1)

    override fun handleSetDeviceMuted(muted: Boolean, flags: Int): ListenableFuture<*> {
        SessionHub.remoteVolume?.setMuted(muted)
        return Futures.immediateVoidFuture()
    }

    private fun stepVolume(delta: Int): ListenableFuture<*> {
        val remote = SessionHub.remoteVolume
        val level = remote?.level()
        Log.i(TAG, "media_session.remote_volume_step delta=$delta level=$level")
        if (remote != null && level != null) remote.setLevel(RemoteVolumeLevels.step(level, delta, remote.maxLevel))
        return Futures.immediateVoidFuture()
    }

    override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
        pendingPlayWhenReady = playWhenReady
        SessionHub.emit(if (playWhenReady) "play" else "pause")
        return Futures.immediateVoidFuture()
    }

    override fun handlePrepare(): ListenableFuture<*> = Futures.immediateVoidFuture()

    override fun handleStop(): ListenableFuture<*> {
        SessionHub.emit("stop")
        return Futures.immediateVoidFuture()
    }

    /** Media3 passes the command behind every seek (next, previous, ±10 s, the seek bar); the JS player decides what it means. */
    override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
        when (seekCommand) {
            Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM -> SessionHub.emit("nexttrack")
            Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> SessionHub.emit("previoustrack")
            Player.COMMAND_SEEK_BACK -> SessionHub.emit("seekbackward", seekOffsetMs = SEEK_STEP_MS)
            Player.COMMAND_SEEK_FORWARD -> SessionHub.emit("seekforward", seekOffsetMs = SEEK_STEP_MS)
            else -> if (positionMs != C.TIME_UNSET) SessionHub.emit("seekto", seekTimeMs = positionMs)
        }
        return Futures.immediateVoidFuture()
    }

    companion object {
        private const val TAG = "SpaceMediaSession"
        private const val ITEM_UID = "spacefleet-now-playing"
        /** `SEEK_STEP_S` of @space/media-session. */
        const val SEEK_STEP_MS = 10_000L

        fun commandsFor(actions: Set<String>, remoteVolume: Boolean = false): Player.Commands {
            val builder = Player.Commands.Builder().addAll(
                Player.COMMAND_GET_CURRENT_MEDIA_ITEM,
                Player.COMMAND_GET_TIMELINE,
                Player.COMMAND_GET_METADATA,
            )
            if ("play" in actions || "pause" in actions) builder.add(Player.COMMAND_PLAY_PAUSE)
            if ("stop" in actions) builder.add(Player.COMMAND_STOP)
            if ("nexttrack" in actions) builder.addAll(Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
            if ("previoustrack" in actions) builder.addAll(Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
            if ("seekto" in actions) builder.add(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM)
            if ("seekbackward" in actions) builder.add(Player.COMMAND_SEEK_BACK)
            if ("seekforward" in actions) builder.add(Player.COMMAND_SEEK_FORWARD)
            if (remoteVolume) {
                builder.addAll(
                    Player.COMMAND_GET_DEVICE_VOLUME,
                    Player.COMMAND_SET_DEVICE_VOLUME_WITH_FLAGS,
                    Player.COMMAND_ADJUST_DEVICE_VOLUME_WITH_FLAGS,
                )
            }
            return builder.build()
        }
    }
}
