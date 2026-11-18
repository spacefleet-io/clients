package com.spacefleet.mpvplayback.mpv

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import android.util.Log
import `is`.xyz.mpv.MPVLib

/**
 * Android audio focus and `ACTION_AUDIO_BECOMING_NOISY` for the mpv player (PLAY-FOCUS-01); the decisions are
 * [AudioFocusPolicy]'s. Parrot's phone player gets the same behaviour from Media3's ExoPlayer
 * (`handleAudioFocus = true`, `setHandleAudioBecomingNoisy`); libmpv has none of its own.
 *
 * Pausing and resuming set mpv's `pause` property, the same path as the player's own pause button
 * (`MpvControl.setPaused`), so the JS snapshot, the player controls and the OS media card (PLAY-OSMEDIA-01) all show
 * the pause. Every callback is moved to [mainHandler]: mpv's observer thread and the system's focus callbacks never
 * touch the policy concurrently.
 */
class MpvAudioFocus(context: Context, private val mainHandler: Handler) : MPVLib.EventObserver {
  private val appContext = context.applicationContext
  private val audioManager = appContext.getSystemService(AudioManager::class.java)
  private val policy = AudioFocusPolicy()
  @Volatile private var released = false

  private val focusRequest: AudioFocusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
    .setAudioAttributes(
      AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
        .build(),
    )
    // A "can duck" loss: the system lowers the volume itself, no pause for a notification sound.
    .setWillPauseWhenDucked(false)
    .setOnAudioFocusChangeListener({ change -> onFocusChange(change) }, mainHandler)
    .build()

  private val noisyReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (intent.action != AudioManager.ACTION_AUDIO_BECOMING_NOISY) return
      mainHandler.post {
        if (released) return@post
        Log.i(TAG, "focus.becoming_noisy playing=${policy.playing}")
        apply(policy.onBecomingNoisy())
      }
    }
  }

  override fun eventProperty(property: String) = Unit
  override fun eventProperty(property: String, value: Long) = Unit
  override fun eventProperty(property: String, value: String) = Unit
  override fun eventProperty(property: String, value: Double) = Unit

  override fun eventProperty(property: String, value: Boolean) {
    if (property != "pause") return
    post { policy.onPauseChanged(value) }
  }

  override fun event(eventId: Int) {
    when (eventId) {
      MPVLib.MpvEvent.MPV_EVENT_FILE_LOADED -> post { policy.onFileLoaded() }
      MPVLib.MpvEvent.MPV_EVENT_END_FILE, MPVLib.MpvEvent.MPV_EVENT_IDLE -> post { policy.onFileEnded() }
    }
  }

  /** Player closed: give the focus back and stop listening. Main thread (engine teardown). */
  fun release() {
    if (released) return
    apply(policy.onRelease())
    released = true
    Log.i(TAG, "focus.released")
  }

  private fun post(step: () -> List<AudioFocusPolicy.Effect>) {
    mainHandler.post {
      if (released) return@post
      apply(step())
    }
  }

  private fun onFocusChange(change: Int) {
    if (released) return
    val mapped = when (change) {
      AudioManager.AUDIOFOCUS_GAIN -> AudioFocusPolicy.Change.GAIN
      AudioManager.AUDIOFOCUS_LOSS -> AudioFocusPolicy.Change.LOSS
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> AudioFocusPolicy.Change.LOSS_TRANSIENT
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> AudioFocusPolicy.Change.LOSS_TRANSIENT_CAN_DUCK
      else -> return
    }
    Log.i(TAG, "focus.change $mapped playing=${policy.playing} pausedByFocusLoss=${policy.pausedByFocusLoss}")
    apply(policy.onFocusChange(mapped))
  }

  private fun apply(effects: List<AudioFocusPolicy.Effect>) {
    for (effect in effects) {
      when (effect) {
        AudioFocusPolicy.Effect.REQUEST_FOCUS -> {
          val result = audioManager.requestAudioFocus(focusRequest)
          val granted = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
          Log.i(TAG, "focus.request result=$result")
          apply(policy.onRequestResult(granted))
        }
        AudioFocusPolicy.Effect.ABANDON_FOCUS -> {
          audioManager.abandonAudioFocusRequest(focusRequest)
          Log.i(TAG, "focus.abandon")
        }
        AudioFocusPolicy.Effect.PAUSE -> setPause(true)
        AudioFocusPolicy.Effect.RESUME -> setPause(false)
        AudioFocusPolicy.Effect.REGISTER_NOISY ->
          appContext.registerReceiver(noisyReceiver, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY))
        AudioFocusPolicy.Effect.UNREGISTER_NOISY ->
          runCatching { appContext.unregisterReceiver(noisyReceiver) }
      }
    }
  }

  private fun setPause(paused: Boolean) {
    Log.i(TAG, "focus.${if (paused) "pause" else "resume"}")
    // Same property the player's pause button sets; the core may already be gone at teardown.
    runCatching { MpvGuard.setPropertyBoolean("pause", paused) }
      .onFailure { Log.w(TAG, "focus.set_pause failed: ${it.message}") }
  }

  private companion object {
    const val TAG = "MpvAudioFocus"
  }
}
