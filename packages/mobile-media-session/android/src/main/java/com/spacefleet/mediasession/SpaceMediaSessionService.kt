package com.spacefleet.mediasession

import android.app.PendingIntent
import android.content.Intent
import android.os.Looper
import android.util.Log
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

/**
 * Holds the OS media session of a player that plays elsewhere (Badger's mpv, or the TV the phone controls): Media3
 * draws the notification-shade and lock-screen card from `MirrorPlayer`, keeps the service in the foreground while it
 * reports playing, and routes headset and Bluetooth buttons to it (PLAY-OSMEDIA-01). Bound by `SpaceMediaSessionModule`
 * for as long as JS holds the session.
 */
class SpaceMediaSessionService : MediaSessionService() {
    private var session: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        val player = MirrorPlayer(Looper.getMainLooper())
        SessionHub.player = player
        val builder = MediaSession.Builder(this, player).setId(SESSION_ID)
        packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
            builder.setSessionActivity(
                PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT),
            )
        }
        session = builder.build()
        Log.i(TAG, "media_session.service_created")
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    /** The app's task is gone, and with it the JS player the card stood for: drop the card. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        Log.i(TAG, "media_session.task_removed")
        SessionHub.apply(null)
        stopSelf()
    }

    override fun onDestroy() {
        session?.run {
            player.release()
            release()
        }
        session = null
        SessionHub.player = null
        Log.i(TAG, "media_session.service_destroyed")
        super.onDestroy()
    }

    companion object {
        private const val TAG = "SpaceMediaSession"
        const val SESSION_ID = "spacefleet-os-media"
    }
}
