package com.spacefleet.mpvplayback.mpv

import com.spacefleet.mpvplayback.mpv.AudioFocusPolicy.Change
import com.spacefleet.mpvplayback.mpv.AudioFocusPolicy.Effect
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * @req PLAY-FOCUS-01[badger-mobile]
 *
 * Drives [AudioFocusPolicy] the way [MpvAudioFocus] does: the effects it returns are carried out, and a PAUSE/RESUME
 * comes back as mpv's `pause` property change, like on the device.
 */
class AudioFocusPolicyTest {
  private val policy = AudioFocusPolicy()
  private val log = mutableListOf<String>()

  /** Carries out [effects] like the Android glue: a request is granted unless [grant] says otherwise. */
  private fun run(effects: List<Effect>, grant: Boolean = true): List<Effect> {
    val all = mutableListOf<Effect>()
    for (effect in effects) {
      all += effect
      when (effect) {
        Effect.REQUEST_FOCUS -> all += run(policy.onRequestResult(grant), grant)
        Effect.PAUSE -> all += run(policy.onPauseChanged(true), grant)
        Effect.RESUME -> all += run(policy.onPauseChanged(false), grant)
        else -> Unit
      }
    }
    log += "effects=$all focus=${policy.focus} loaded=${policy.loaded} paused=${policy.paused} pausedByFocusLoss=${policy.pausedByFocusLoss}"
    return all
  }

  private fun startPlaying(): List<Effect> {
    run(policy.onPauseChanged(false))
    return run(policy.onFileLoaded())
  }

  private fun check(message: String, expected: Any?, actual: Any?) {
    if (expected != actual) println("AudioFocusPolicyTest history:\n" + log.joinToString("\n"))
    assertEquals(message, expected, actual)
  }

  @Test
  fun `no focus is asked before a file plays`() {
    check("idle mpv with pause=false", emptyList<Effect>(), run(policy.onPauseChanged(false)))
    check("focus", AudioFocusPolicy.Focus.NONE, policy.focus)
  }

  @Test
  fun `playing asks for focus once and listens for headphones going away`() {
    check("first play", listOf(Effect.REGISTER_NOISY, Effect.REQUEST_FOCUS), startPlaying())
    check("focus", AudioFocusPolicy.Focus.HELD, policy.focus)
    check("pause keeps focus, stops noisy", listOf(Effect.UNREGISTER_NOISY), run(policy.onPauseChanged(true)))
    check("play again, focus still held", listOf(Effect.REGISTER_NOISY), run(policy.onPauseChanged(false)))
  }

  @Test
  fun `a refused request pauses`() {
    run(policy.onPauseChanged(false))
    val effects = run(policy.onFileLoaded(), grant = false)
    check("refused", listOf(Effect.REGISTER_NOISY, Effect.REQUEST_FOCUS, Effect.PAUSE, Effect.UNREGISTER_NOISY), effects)
    check("paused", true, policy.paused)
  }

  @Test
  fun `permanent loss pauses, gives focus back and never resumes on its own`() {
    startPlaying()
    val effects = run(policy.onFocusChange(Change.LOSS))
    check("loss", listOf(Effect.PAUSE, Effect.UNREGISTER_NOISY, Effect.ABANDON_FOCUS), effects)
    check("focus", AudioFocusPolicy.Focus.NONE, policy.focus)
    check("a later gain does not resume", emptyList<Effect>(), run(policy.onFocusChange(Change.GAIN)))
    check("still paused", true, policy.paused)
    check("user play asks again", listOf(Effect.REGISTER_NOISY), run(policy.onPauseChanged(false)).filter { it != Effect.REQUEST_FOCUS })
  }

  @Test
  fun `user play after a permanent loss asks for focus again`() {
    startPlaying()
    run(policy.onFocusChange(Change.LOSS))
    check("play", listOf(Effect.REGISTER_NOISY, Effect.REQUEST_FOCUS), run(policy.onPauseChanged(false)))
  }

  @Test
  fun `transient loss pauses and the regain resumes`() {
    startPlaying()
    check("transient loss keeps the noisy receiver", listOf(Effect.PAUSE), run(policy.onFocusChange(Change.LOSS_TRANSIENT)))
    check("armed", true, policy.pausedByFocusLoss)
    check("gain", listOf(Effect.RESUME), run(policy.onFocusChange(Change.GAIN)))
    check("playing", true, policy.playing)
    check("focus", AudioFocusPolicy.Focus.HELD, policy.focus)
  }

  @Test
  fun `transient loss while the user had paused does not resume`() {
    startPlaying()
    run(policy.onPauseChanged(true))
    check("transient loss while paused", emptyList<Effect>(), run(policy.onFocusChange(Change.LOSS_TRANSIENT)))
    check("gain", emptyList<Effect>(), run(policy.onFocusChange(Change.GAIN)))
    check("paused", true, policy.paused)
  }

  @Test
  fun `user play during a transient loss cancels the resume and asks for focus`() {
    startPlaying()
    run(policy.onFocusChange(Change.LOSS_TRANSIENT))
    check("user play", listOf(Effect.REQUEST_FOCUS), run(policy.onPauseChanged(false)))
    check("user pause", listOf(Effect.UNREGISTER_NOISY), run(policy.onPauseChanged(true)))
    check("gain does not resume a user pause", emptyList<Effect>(), run(policy.onFocusChange(Change.GAIN)))
  }

  @Test
  fun `a can-duck loss is left to the system`() {
    startPlaying()
    check("duck", emptyList<Effect>(), run(policy.onFocusChange(Change.LOSS_TRANSIENT_CAN_DUCK)))
    check("playing", true, policy.playing)
  }

  @Test
  fun `headphones going away pause, and only while playing`() {
    startPlaying()
    check("noisy", listOf(Effect.PAUSE, Effect.UNREGISTER_NOISY), run(policy.onBecomingNoisy()))
    check("noisy while paused", emptyList<Effect>(), run(policy.onBecomingNoisy()))
  }

  @Test
  fun `noisy during a transient loss cancels the resume`() {
    startPlaying()
    run(policy.onFocusChange(Change.LOSS_TRANSIENT))
    run(policy.onBecomingNoisy())
    check("gain", emptyList<Effect>(), run(policy.onFocusChange(Change.GAIN)))
  }

  @Test
  fun `the next episode keeps focus and release gives it back`() {
    startPlaying()
    check("end of file", listOf(Effect.UNREGISTER_NOISY), run(policy.onFileEnded()))
    check("next file", listOf(Effect.REGISTER_NOISY), run(policy.onFileLoaded()))
    check("release", listOf(Effect.UNREGISTER_NOISY, Effect.ABANDON_FOCUS), run(policy.onRelease()))
    check("released twice", emptyList<Effect>(), run(policy.onRelease()))
  }
}
