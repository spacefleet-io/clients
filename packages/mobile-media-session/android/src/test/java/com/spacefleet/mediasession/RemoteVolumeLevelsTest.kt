package com.spacefleet.mediasession

import org.junit.Assert.assertEquals
import org.junit.Test

/** The phone's volume keys on a cast device (UX-TV-03): 20 steps of 5 %, clamped at both ends. */
class RemoteVolumeLevelsTest {
    @Test
    fun fractionBecomesTheNearestStep() {
        assertEquals(0, RemoteVolumeLevels.fromFraction(0.0, 20))
        assertEquals(11, RemoteVolumeLevels.fromFraction(0.533, 20))
        assertEquals(20, RemoteVolumeLevels.fromFraction(1.0, 20))
        assertEquals(20, RemoteVolumeLevels.fromFraction(1.2, 20))
        assertEquals(0, RemoteVolumeLevels.fromFraction(-0.1, 20))
    }

    @Test
    fun stepBecomesTheDeviceFraction() {
        assertEquals(0.55, RemoteVolumeLevels.toFraction(11, 20), 1e-9)
        assertEquals(1.0, RemoteVolumeLevels.toFraction(25, 20), 1e-9)
        assertEquals(0.0, RemoteVolumeLevels.toFraction(-3, 20), 1e-9)
    }

    @Test
    fun keyPressMovesOneStepWithinRange() {
        assertEquals(12, RemoteVolumeLevels.step(11, 1, 20))
        assertEquals(10, RemoteVolumeLevels.step(11, -1, 20))
        assertEquals(20, RemoteVolumeLevels.step(20, 1, 20))
        assertEquals(0, RemoteVolumeLevels.step(0, -1, 20))
    }
}
