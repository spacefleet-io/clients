package com.spacefleet.mpvplayback.mpv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

/**
 * @req PLAY-OSMEDIA-01[badger-mobile]
 * @bugfix @regression-proof
 *
 * Found on a OnePlus 9 (2026-11-11, PR #1762): locked at E02, Next on the lock screen dropped the old player view
 * (`MpvEngine destroyed`) while React Native held the new view's mount until the app came back, so nothing played E03;
 * Previous then waited on a card that never got a player and the notification went away after 30 s.
 */
class PlayerCoresTest {
  private class View(val name: String, var playing: String) {
    override fun toString() = name
  }

  private class Engine(val name: String) {
    var destroyed = false
  }

  private val log = mutableListOf<String>()
  private val cores = PlayerCores<View, Engine, String>(
    destroy = { it.destroyed = true },
    carryOver = { it.playing },
    log = { log.add(it) },
  )

  @Test
  fun `a player dropped by an episode switch while the app is hidden keeps its core for the next episode`() {
    val e02 = View("e02", "E02")
    val engine = Engine("core")
    cores.mount(e02, appInForeground = true) { engine }

    cores.switchPending()
    cores.drop(e02, appInForeground = false)
    println("log=$log live=${cores.live} destroyed=${engine.destroyed}")

    assertEquals("the core keeps playing, no new one can be created until the app shows", false, engine.destroyed)
    assertSame("background loads (the next episode) reach the kept core", e02, cores.live)
    assertNull("a held source prop on the dropped view never loads", cores.engineOf(e02))
  }

  /**
   * OnePlus 9 test phone, 2026-11-11 (PR #1762): locked E02→E03→E02→E01 played, but on unlock the new view's mount freed the
   * kept core and built a new one; its reload of E01 timed out (`playback.failure startTimeout`) and the player sat
   * paused at 0. The mount in front now takes the kept core over as it is.
   */
  @Test
  fun `the view that mounts when the app returns takes the kept core over and frees nothing`() {
    val e02 = View("e02", "E02")
    val kept = Engine("kept")
    cores.mount(e02, appInForeground = true) { kept }
    cores.switchPending()
    cores.drop(e02, appInForeground = false)
    e02.playing = "E03" // loaded through MpvControl.loadInBackground while locked

    val e03 = View("e03", "E03")
    var created = 0
    val mounted = cores.mount(e03, appInForeground = true) { created++; Engine("new") }
    println("log=$log mounted=$mounted")

    assertEquals("the kept core plays on", false, kept.destroyed)
    assertEquals("no second core is created", 0, created)
    assertSame(kept, mounted.engine)
    assertEquals(true, mounted.reused)
    assertEquals("E03", mounted.carried)
    assertSame(e03, cores.live)
    assertSame("the new view's source prop reaches the kept core", kept, cores.engineOf(e03))
  }

  @Test
  fun `leaving the player frees its core, in front or hidden`() {
    val front = View("front", "E01")
    val frontEngine = Engine("front")
    cores.mount(front, appInForeground = true) { frontEngine }
    cores.drop(front, appInForeground = true)
    assertEquals(true, frontEngine.destroyed)
    assertNull(cores.live)

    val hidden = View("hidden", "E01")
    val hiddenEngine = Engine("hidden")
    cores.mount(hidden, appInForeground = true) { hiddenEngine }
    cores.drop(hidden, appInForeground = false)
    println("log=$log")
    assertEquals("no switch pending: a stop from the notification closes the player", true, hiddenEngine.destroyed)
    assertNull(cores.live)
  }

  @Test
  fun `an episode switch in front hands the one core to the new view`() {
    val e02 = View("e02", "E02")
    val core = Engine("core")
    cores.mount(e02, appInForeground = true) { core }
    cores.switchPending()
    val e03 = View("e03", "E03")
    var created = 0
    val mounted = cores.mount(e03, appInForeground = true) { created++; Engine("new") }
    cores.drop(e02, appInForeground = true)
    println("log=$log")
    assertSame(core, mounted.engine)
    assertEquals(true, mounted.reused)
    assertEquals("E02", mounted.carried)
    assertEquals("no second core is created", 0, created)
    assertEquals("the old view's drop frees nothing", false, core.destroyed)
    assertNull("a held source prop on the old view never loads", cores.engineOf(e02))
    assertSame(core, cores.engineOf(e03))
    assertSame(e03, cores.live)
  }

  /**
   * OnePlus 9 test phone, 2026-11-11 (PR #1762): locked E02→E03→E02→E01 played, then on unlock React ran three held mounts
   * before their drops. The first took the kept core over, but the second and third freed the core of the view before
   * them and built a new one; JS saw a fresh start and failed it (`playback.failure startTimeout`). Each mount now takes
   * the one core over from the view before it.
   */
  @Test
  fun `held mounts run on unlock before their drops pass the kept core along`() {
    val e02 = View("e02", "E02")
    val core = Engine("core")
    cores.mount(e02, appInForeground = true) { core }
    cores.switchPending()
    cores.drop(e02, appInForeground = false)
    e02.playing = "E01"

    var created = 0
    val create = { created++; Engine("extra") }
    val e03 = View("e03", "E01")
    val e02Again = View("e02-again", "E01")
    val e01 = View("e01", "E01")
    cores.mount(e03, appInForeground = true, create)
    cores.mount(e02Again, appInForeground = true, create)
    val mounted = cores.mount(e01, appInForeground = true, create)
    cores.drop(e03, appInForeground = true)
    cores.drop(e02Again, appInForeground = true)
    println("log=$log")

    assertSame(core, mounted.engine)
    assertEquals("E01", mounted.carried)
    assertEquals("no core was created", 0, created)
    assertEquals("the kept core plays on", false, core.destroyed)
    assertSame(e01, cores.live)
    assertSame(core, cores.engineOf(e01))
  }

  @Test
  fun `a switch whose drop runs in front frees the old core at once`() {
    val e02 = View("e02", "E02")
    val old = Engine("old")
    cores.mount(e02, appInForeground = true) { old }
    cores.switchPending()
    cores.drop(e02, appInForeground = true)
    assertEquals(true, old.destroyed)
    assertNull(cores.live)
  }

  @Test
  fun `a pending switch is used once`() {
    val first = View("first", "E02")
    val core = Engine("first")
    cores.mount(first, appInForeground = true) { core }
    cores.switchPending()
    cores.drop(first, appInForeground = false)
    val second = View("second", "E03")
    val mounted = cores.mount(second, appInForeground = false) { Engine("second") }
    cores.drop(second, appInForeground = false)
    println("log=$log")
    assertSame("the hidden mount takes the kept core over", core, mounted.engine)
    assertEquals("the next hidden drop without a new switch closes the player", true, core.destroyed)
    assertNull(cores.live)
  }

  /**
   * OnePlus 9 test phone, 2026-11-11: Next, Previous, Previous while locked. React held every mount and drop of the first two switches and
   * ran them all at the third press, while still hidden: drop E02, mount E03, drop E03, mount E02, drop E02. Each mount
   * used to clear the pending switch, so the later drops freed the core and the third episode never loaded. Each held
   * mount now takes the one core over, and the view that mounts on unlock takes it over again.
   */
  @Test
  fun `held mounts and drops of several hidden switches run in one batch and keep the one core to the end`() {
    val e02 = View("e02", "E02")
    val core = Engine("e02")
    cores.mount(e02, appInForeground = true) { core }
    repeat(3) { cores.switchPending() }
    var created = 0
    val create = { created++; Engine("extra") }

    cores.drop(e02, appInForeground = false)
    val e03 = View("e03", "E03")
    assertSame(core, cores.mount(e03, appInForeground = false, create).engine)
    cores.drop(e03, appInForeground = false)
    val e02Again = View("e02-again", "E02")
    assertSame(core, cores.mount(e02Again, appInForeground = false, create).engine)
    cores.drop(e02Again, appInForeground = false)
    println("log=$log live=${cores.live}")

    assertEquals("the core stays to play E01 in the background", false, core.destroyed)
    assertSame(e02Again, cores.live)

    e02Again.playing = "E01" // MpvControl.loadInBackground
    val e01 = View("e01", "E01")
    val mounted = cores.mount(e01, appInForeground = true, create)
    assertSame(core, mounted.engine)
    assertEquals(true, mounted.reused)
    assertEquals("E01", mounted.carried)
    assertEquals("no core was ever created or freed", 0, created)
    assertEquals(false, core.destroyed)
    assertSame(e01, cores.live)

    cores.drop(e01, appInForeground = true)
    assertEquals("leaving the player afterwards frees the core", true, core.destroyed)
  }
}
