package com.spacefleet.mpvplayback.mpv

import `is`.xyz.mpv.MPVLib
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.write

/**
 * Serialises every JS-driven [MPVLib] call against core teardown.
 *
 * libmpv is a process-wide singleton and `MPVLib.destroy()` frees the core; a bridge call that
 * races it dereferences freed native memory (SIGSEGV, not a catchable exception). Bridge methods
 * run on the RN native-modules thread while [MpvEngine.destroy] runs on the UI thread from
 * `onDropViewInstance`, so unmount-time JS calls (`setPaused`, `getTimePos`, a late `seek`) can
 * overlap it.
 *
 * Calls take the read lock and throw [IllegalStateException] while the core is not live; every
 * bridge method already maps exceptions to a promise rejection or a safe default. [destroy] takes
 * the write lock so it waits for in-flight calls and blocks new ones.
 */
object MpvGuard {
  private val lock = ReentrantReadWriteLock()
  @Volatile private var live = false

  /** Called right after `MPVLib.init()`. */
  fun markLive() = lock.write { live = true }

  /** Runs [teardown] (the `MPVLib.destroy()` call) with no bridge call in flight, then marks dead. */
  fun destroy(teardown: () -> Unit) = lock.write {
    live = false
    teardown()
  }

  private inline fun <T> guarded(block: () -> T): T = lock.read {
    check(live) { "mpv core is not live" }
    block()
  }

  fun command(args: Array<String>) = guarded { MPVLib.command(args) }
  fun setPropertyString(name: String, value: String) = guarded { MPVLib.setPropertyString(name, value) }
  fun setPropertyInt(name: String, value: Int) = guarded { MPVLib.setPropertyInt(name, value) }
  fun setPropertyDouble(name: String, value: Double) = guarded { MPVLib.setPropertyDouble(name, value) }
  fun setPropertyBoolean(name: String, value: Boolean) = guarded { MPVLib.setPropertyBoolean(name, value) }
  fun getPropertyString(name: String): String? = guarded { MPVLib.getPropertyString(name) }
  fun getPropertyInt(name: String): Int? = guarded { MPVLib.getPropertyInt(name) }
  fun getPropertyDouble(name: String): Double? = guarded { MPVLib.getPropertyDouble(name) }
  fun getPropertyBoolean(name: String): Boolean? = guarded { MPVLib.getPropertyBoolean(name) }
}
