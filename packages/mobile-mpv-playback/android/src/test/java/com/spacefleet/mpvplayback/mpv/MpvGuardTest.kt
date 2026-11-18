package com.spacefleet.mpvplayback.mpv

import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * @bugfix @regression-proof
 *
 * Found on a OnePlus 6 test phone (2026-11-13, phone case abr-decode-bound): the harness's `SETOPT hwdec` probe broadcast reached a player
 * whose core was never created; the probe called libmpv directly, `CHECK_MPV_INIT` hit `die("libmpv is not initialized")`
 * and the process exited. The probe now goes through [MpvGuard], which refuses (a catchable exception) while no core is
 * live, before it touches libmpv.
 */
class MpvGuardTest {
  @Test
  fun `an option write with no live core is refused before reaching libmpv`() {
    assertThrows(IllegalStateException::class.java) { MpvGuard.setPropertyString("options/hwdec", "no") }
  }
}
