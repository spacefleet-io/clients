package com.spacefleet.audioplayback

import android.app.PendingIntent
import android.content.Intent
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

/**
 * The music player of a suite phone app (Parrot, PAR-PLAY-01): one ExoPlayer inside a Media3 MediaSessionService. The
 * service is what keeps music going with the app in the background, and its session drives the media notification,
 * the lock screen and headset buttons (PAR-PLAY-03). The app's JS talks to it through `AudioPlaybackModule`'s
 * MediaController, like any other controller.
 */
class AudioPlaybackService : MediaSessionService() {
    private var session: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        // A raw AAC (ADTS) file has no index and no length, so ExoPlayer by default gives it no duration and cannot seek
        // in it (the bar shows --:--). Estimating both from the average frame size, as browsers do, gives it a
        // duration and seeking (PAR-FMT-01).
        val extractors = DefaultExtractorsFactory().setConstantBitrateSeekingEnabled(true)
        // ParrotRenderersFactory adds Parrot's own Apple Lossless (ALAC) decoder, which Android lacks (PAR-FMT-01), and
        // plays each song at its own even-volume gain, switched sample-exactly between songs (PAR-PLAY-03 item 2).
        val player = ExoPlayer.Builder(this, ParrotRenderersFactory(this), DefaultMediaSourceFactory(this, extractors))
            .setAudioAttributes(
                AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
                /* handleAudioFocus= */ true,
            )
            .setHandleAudioBecomingNoisy(true)
            // The media comes from the loopback proxy, which fetches from the network: keep Wi-Fi up while playing.
            .setWakeMode(C.WAKE_MODE_NETWORK)
            // The OS card's and headset's seek-back and seek-forward step 10 seconds, like every player (PLAY-OSMEDIA-01).
            .setSeekBackIncrementMs(SEEK_STEP_MS)
            .setSeekForwardIncrementMs(SEEK_STEP_MS)
            .build()
            // Songs added with "Play next" or "Add to queue" keep their place with shuffle on (PAR-CARD-01).
            .apply { setShuffleOrder(UpNextShuffleOrder(IntArray(0))) }
        val builder = MediaSession.Builder(this, player)
        packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
            builder.setSessionActivity(
                PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT),
            )
        }
        session = builder.build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    /** Swiping the app away stops the service only when nothing is playing; playing music keeps going. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        val player = session?.player
        if (player == null || !player.playWhenReady || player.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        session?.run {
            player.release()
            release()
        }
        session = null
        super.onDestroy()
    }

    private companion object {
        const val SEEK_STEP_MS = 10_000L
    }
}
