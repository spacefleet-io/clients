package com.spacefleet.audioplayback

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * @req PAR-PLAY-06[parrot]
 *
 * The full player's Queue lists the songs in the order the player will play them: in order, wrapping once with repeat
 * all, and the drawn order with shuffle on. Shown on a headless emulator with the release APK (2026-11-10).
 */
class UpNextTest {
    @Test
    fun inOrderListsTheSongsAfterTheCurrentOne() {
        val step = { i: Int -> if (i + 1 < 4) i + 1 else -1 }
        assertEquals(listOf(2, 3), upNextIndices(1, 4, step))
        assertEquals(emptyList<Int>(), upNextIndices(3, 4, step))
    }

    @Test
    fun repeatAllWrapsOnceAndStopsBeforeTheCurrentSong() {
        assertEquals(listOf(2, 3, 0), upNextIndices(1, 4) { i -> (i + 1) % 4 })
    }

    @Test
    fun shuffleFollowsTheDrawnOrder() {
        val order = intArrayOf(2, 0, 3, 1)
        val step = { i: Int -> order.indexOf(i).let { at -> if (at + 1 < order.size) order[at + 1] else -1 } }
        assertEquals(listOf(3, 1), upNextIndices(0, 4, step))
    }

    @Test
    fun anEmptyQueueHasNothingNext() {
        assertEquals(emptyList<Int>(), upNextIndices(-1, 0) { -1 })
    }
}
