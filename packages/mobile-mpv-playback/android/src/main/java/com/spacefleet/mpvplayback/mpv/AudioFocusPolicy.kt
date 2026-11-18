package com.spacefleet.mpvplayback.mpv

/**
 * What the mpv player does when Android's audio focus or audio route changes (PLAY-FOCUS-01). Pure: [MpvAudioFocus]
 * feeds it mpv's state and the system's focus callbacks and carries out the returned [Effect]s. No Android types, so
 * the JVM tests run it directly.
 *
 * - Playing (a file loaded and `pause=false`) asks for focus when the player does not already hold it; a refused
 *   request pauses.
 * - A permanent loss (another app plays, a call app takes focus for good) pauses and gives the focus back; nothing
 *   resumes until the user presses play.
 * - A transient loss (a call ringing, a navigation prompt) pauses; the focus coming back resumes only when this policy
 *   was the one that paused. A user pause or play in between cancels that resume.
 * - A "can duck" loss is left to the system, which lowers the player's volume itself (Android 8+, minSdk 26).
 * - Headphones or a Bluetooth headset going away (`ACTION_AUDIO_BECOMING_NOISY`) pauses, and cancels a pending
 *   focus-loss resume; the noisy receiver is registered only while playing or while such a resume waits.
 * - [onRelease] (player closed) gives the focus back.
 */
class AudioFocusPolicy {
  enum class Focus { NONE, HELD, LOST_TRANSIENT }

  enum class Change { GAIN, LOSS, LOSS_TRANSIENT, LOSS_TRANSIENT_CAN_DUCK }

  enum class Effect { REQUEST_FOCUS, ABANDON_FOCUS, PAUSE, RESUME, REGISTER_NOISY, UNREGISTER_NOISY }

  var focus: Focus = Focus.NONE
    private set
  var loaded: Boolean = false
    private set
  var paused: Boolean = false
    private set
  var pausedByFocusLoss: Boolean = false
    private set
  private var noisyRegistered = false

  val playing: Boolean get() = loaded && !paused

  /** mpv's `pause` property changed (a user press, the OS card, or one of this policy's own [Effect.PAUSE]/[Effect.RESUME]). */
  fun onPauseChanged(paused: Boolean): List<Effect> {
    if (paused == this.paused) return emptyList()
    this.paused = paused
    // Our own pause arrives here too and must keep the resume armed; a play (ours or the user's) settles it.
    if (!paused) pausedByFocusLoss = false
    return evaluate()
  }

  /** A file finished loading (`MPV_EVENT_FILE_LOADED`). */
  fun onFileLoaded(): List<Effect> {
    loaded = true
    return evaluate()
  }

  /** The file ended or mpv went idle. Focus is kept: the next episode usually follows straight away. */
  fun onFileEnded(): List<Effect> {
    loaded = false
    pausedByFocusLoss = false
    return evaluate()
  }

  /** Result of the [Effect.REQUEST_FOCUS] just carried out. */
  fun onRequestResult(granted: Boolean): List<Effect> {
    if (granted) {
      focus = Focus.HELD
      return emptyList()
    }
    focus = Focus.NONE
    return if (playing) listOf(Effect.PAUSE) else emptyList()
  }

  fun onFocusChange(change: Change): List<Effect> = when (change) {
    Change.GAIN -> {
      focus = Focus.HELD
      if (pausedByFocusLoss && loaded && paused) {
        // The flag clears with the `pause=false` this RESUME leads to; the noisy receiver stays meanwhile.
        listOf(Effect.RESUME)
      } else {
        pausedByFocusLoss = false
        syncNoisy()
      }
    }
    Change.LOSS -> {
      focus = Focus.NONE
      pausedByFocusLoss = false
      buildList {
        if (playing) add(Effect.PAUSE)
        addAll(syncNoisy())
        add(Effect.ABANDON_FOCUS)
      }
    }
    Change.LOSS_TRANSIENT -> {
      focus = Focus.LOST_TRANSIENT
      if (playing) {
        pausedByFocusLoss = true
        listOf(Effect.PAUSE)
      } else {
        emptyList()
      }
    }
    Change.LOSS_TRANSIENT_CAN_DUCK -> emptyList()
  }

  /** `ACTION_AUDIO_BECOMING_NOISY`: the sound would move to the phone's speaker, so no resume after a call either. */
  fun onBecomingNoisy(): List<Effect> {
    pausedByFocusLoss = false
    return if (playing) listOf(Effect.PAUSE) else syncNoisy()
  }

  fun onRelease(): List<Effect> = buildList {
    if (noisyRegistered) {
      noisyRegistered = false
      add(Effect.UNREGISTER_NOISY)
    }
    if (focus != Focus.NONE) add(Effect.ABANDON_FOCUS)
    focus = Focus.NONE
    loaded = false
    pausedByFocusLoss = false
  }

  /**
   * The noisy receiver listens while playing and while a focus-loss pause waits to resume (headphones pulled during a
   * call cancel that resume).
   */
  private fun syncNoisy(): List<Effect> {
    val want = playing || pausedByFocusLoss
    if (want == noisyRegistered) return emptyList()
    noisyRegistered = want
    return listOf(if (want) Effect.REGISTER_NOISY else Effect.UNREGISTER_NOISY)
  }

  // The receiver change comes first: a refused request's PAUSE (and the UNREGISTER it leads to) must follow it.
  private fun evaluate(): List<Effect> = buildList {
    addAll(syncNoisy())
    if (playing && focus != Focus.HELD) add(Effect.REQUEST_FOCUS)
  }
}
