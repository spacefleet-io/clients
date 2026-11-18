package com.spacebadger.mobile

import android.util.Log
import com.google.android.gms.cast.Cast
import com.google.android.gms.cast.framework.CastContext
import com.google.android.gms.cast.framework.CastSession
import com.google.android.gms.cast.framework.SessionManagerListener
import com.spacefleet.mediasession.RemoteVolume
import com.spacefleet.mediasession.RemoteVolumeLevels
import com.spacefleet.mediasession.SessionHub
import java.io.IOException

/**
 * The Google Cast device's volume behind the app's OS media session (UX-TV-03). The Cast SDK keeps no media session of
 * its own here (BadgerCastOptionsProvider), so the app's session reports remote playback while a Cast session is
 * connected: Android then sends the phone's volume keys to it, screen on or off, and shows the TV's volume in the
 * system volume panel. One key press is one step of 5 %, the cast screen's volume bar step.
 */
class CastRemoteVolume(private val cast: CastContext) : RemoteVolume {
  override val maxLevel = STEPS

  private val volumeListener = object : Cast.Listener() {
    override fun onVolumeChanged() = SessionHub.refreshVolume()
  }

  private val sessions = object : SessionManagerListener<CastSession> {
    override fun onSessionStarted(session: CastSession, sessionId: String) = follow(session)
    override fun onSessionResumed(session: CastSession, wasSuspended: Boolean) = follow(session)
    override fun onSessionEnded(session: CastSession, error: Int) = unfollow(session)
    override fun onSessionSuspended(session: CastSession, reason: Int) = SessionHub.refreshVolume()
    override fun onSessionStarting(session: CastSession) = Unit
    override fun onSessionStartFailed(session: CastSession, error: Int) = Unit
    override fun onSessionEnding(session: CastSession) = Unit
    override fun onSessionResuming(session: CastSession, sessionId: String) = Unit
    override fun onSessionResumeFailed(session: CastSession, error: Int) = Unit
  }

  init {
    cast.sessionManager.addSessionManagerListener(sessions, CastSession::class.java)
    cast.sessionManager.currentCastSession?.let(::follow)
  }

  private fun follow(session: CastSession) {
    session.addCastListener(volumeListener)
    SessionHub.refreshVolume()
  }

  private fun unfollow(session: CastSession) {
    session.removeCastListener(volumeListener)
    SessionHub.refreshVolume()
  }

  private fun connected(): CastSession? = cast.sessionManager.currentCastSession?.takeIf { it.isConnected }

  override fun level(): Int? = connected()?.let { RemoteVolumeLevels.fromFraction(it.volume, STEPS) }

  override fun muted(): Boolean = connected()?.isMute ?: false

  override fun setLevel(level: Int) {
    val session = connected() ?: return
    Log.i(TAG, "cast.remote_volume level=$level/$STEPS")
    try {
      session.volume = RemoteVolumeLevels.toFraction(level, STEPS)
    } catch (_: IOException) {
      // The device dropped mid-press; the session listener ends the cast.
    } catch (_: IllegalStateException) {
      // Same: the session is no longer connected.
    }
  }

  override fun setMuted(muted: Boolean) {
    val session = connected() ?: return
    try {
      session.isMute = muted
    } catch (_: IOException) {
    } catch (_: IllegalStateException) {
    }
  }

  companion object {
    private const val TAG = "BadgerCast"
    /** 20 steps of 5 %: the cast screen's volume bar step. */
    const val STEPS = 20
  }
}
