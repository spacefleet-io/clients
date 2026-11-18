package com.spacefleet.mpvplayback.mpv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.fail
import org.junit.Test

/**
 * The harness probe (src/debug: player state, UI dump, SETTEXT text entry) is compiled into debug and profile builds
 * only. A release build compiles src/release instead: a no-op `MpvProbe` with no broadcast actions and no
 * `MpvProbeUi`, so no app on a user's phone answers `...probe.UI` or lets another app type into its fields.
 * Runs against the release variant (AGP creates host tests for the tested build type only unless told otherwise):
 * `./gradlew :space_mobile-mpv-playback:testReleaseUnitTest -Pandroid.onlyEnableUnitTestForTheTestedBuildType=false
 * -PreactNativeArchitectures=arm64-v8a` (the ABI whose libmpv bundle is fetched).
 */
class ProbeAbsentInReleaseTest {
  private val pkg = "com.spacefleet.mpvplayback.mpv"

  @Test
  fun releaseHasNoUiDumpOrTextEntry() {
    try {
      Class.forName("$pkg.MpvProbeUi", false, javaClass.classLoader)
      fail("MpvProbeUi (UI dump + SETTEXT) is compiled into the release variant")
    } catch (e: ClassNotFoundException) {
      println("[probe-release] MpvProbeUi absent from release: ok")
    }
  }

  @Test
  fun releaseProbeIsTheNoOpStub() {
    val probe = Class.forName("$pkg.MpvProbe", false, javaClass.classLoader)
    val fields = probe.declaredFields.map { it.name }
    println("[probe-release] MpvProbe fields: $fields")
    assertFalse("release MpvProbe declares broadcast actions: $fields", fields.any { it.startsWith("ACTION_") })
    val methods = probe.declaredMethods.filter { java.lang.reflect.Modifier.isPublic(it.modifiers) }.map { it.name }.sorted()
    println("[probe-release] MpvProbe public methods: $methods")
    assertEquals(listOf("attach", "detach"), methods)
  }
}
