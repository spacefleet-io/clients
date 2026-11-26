package com.spacefleet.audioplayback

import androidx.media3.exoplayer.source.ShuffleOrder
import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * PAR-CARD-01 on the phone: with shuffle on, "Play next" songs play right after the current song and "Add to queue"
 * songs play last, as with shuffle off; a queue filled from empty is still drawn at random.
 *
 * @req PAR-CARD-01[parrot]
 */
class UpNextShuffleOrderTest {
    private fun played(order: ShuffleOrder): List<Int> {
        val out = mutableListOf<Int>()
        var index = order.firstIndex
        while (index != -1) {
            out += index
            index = order.getNextIndex(index)
        }
        return out
    }

    private fun filled(count: Int): ShuffleOrder = UpNextShuffleOrder(IntArray(0), Random(7)).cloneAndInsert(0, count)

    @Test
    fun fillDrawsEverySongOnce() {
        println("[PAR-CARD-01-SHUFFLE-FILL] phase=start")
        val order = filled(6)
        assertEquals((0 until 6).toList(), played(order).sorted())
        assertEquals(6, order.length)
        println("[PAR-CARD-01-SHUFFLE-FILL] phase=done order=${played(order)}")
    }

    @Test
    fun playNextGoesRightAfterTheSongBeforeIt() {
        println("[PAR-CARD-01-SHUFFLE-NEXT] phase=start")
        val order = filled(5)
        val before = played(order)
        // The current song is list index 2; "Play next" inserts 2 songs at list index 3.
        val after = played(order.cloneAndInsert(3, 2))
        val shifted = before.map { if (it >= 3) it + 2 else it }
        val at = shifted.indexOf(2) + 1
        assertEquals(shifted.take(at) + listOf(3, 4) + shifted.drop(at), after)
        println("[PAR-CARD-01-SHUFFLE-NEXT] phase=done order=$after")
    }

    @Test
    fun playNextOnTheLastListSongStillPlaysNext() {
        println("[PAR-CARD-01-SHUFFLE-NEXT-LAST] phase=start")
        // A drawn order where list song 3 is not last: [2, 3, 0, 1].
        val order = UpNextShuffleOrder(intArrayOf(2, 3, 0, 1))
        val before = played(order)
        val after = played(order.cloneAndInsert(4, 1))
        assertEquals(listOf(2, 3, 4, 0, 1), after)
        val at = before.indexOf(3) + 1
        assertEquals(before.take(at) + listOf(4) + before.drop(at), after)
        println("[PAR-CARD-01-SHUFFLE-NEXT-LAST] phase=done order=$after")
    }

    @Test
    fun addToQueuePlaysLast() {
        println("[PAR-CARD-01-SHUFFLE-END] phase=start")
        val order = UpNextShuffleOrder(intArrayOf(2, 3, 0, 1))
        val before = played(order)
        UpNextShuffleOrder.insertAtEnd = true
        val after = played(order.cloneAndInsert(4, 2))
        assertEquals(before + listOf(4, 5), after)
        assertEquals(false, UpNextShuffleOrder.insertAtEnd)
        println("[PAR-CARD-01-SHUFFLE-END] phase=done order=$after")
    }

    @Test
    fun removeKeepsTheRestInOrder() {
        println("[PAR-CARD-01-SHUFFLE-REMOVE] phase=start")
        val order = filled(5)
        val before = played(order)
        val after = played(order.cloneAndRemove(1, 3))
        assertEquals(before.filter { it !in 1..2 }.map { if (it >= 3) it - 2 else it }, after)
        assertEquals(0, order.cloneAndClear().length)
        println("[PAR-CARD-01-SHUFFLE-REMOVE] phase=done order=$after")
    }

    @Test
    fun previousWalksTheShuffledOrderBackwards() {
        println("[PAR-CARD-01-SHUFFLE-PREVIOUS] phase=start")
        val order = filled(6)
        val forward = played(order)
        val backward = mutableListOf<Int>()
        var index = order.lastIndex
        while (index != -1) {
            backward += index
            index = order.getPreviousIndex(index)
        }
        println("[PAR-CARD-01-SHUFFLE-PREVIOUS] forward=$forward backward=$backward first=${order.firstIndex} last=${order.lastIndex}")
        assertEquals(forward.reversed(), backward)
        assertEquals(forward.first(), order.firstIndex)
        assertEquals(forward.last(), order.lastIndex)
    }

    @Test
    fun anEmptyOrderHasNoFirstOrLastSong() {
        val order = filled(3).cloneAndClear()
        println("[PAR-CARD-01-SHUFFLE-EMPTY] length=${order.length} first=${order.firstIndex} last=${order.lastIndex}")
        assertEquals(-1, order.firstIndex)
        assertEquals(-1, order.lastIndex)
        // Filled again (a new album), every song is drawn once.
        assertEquals((0 until 4).toList(), played(order.cloneAndInsert(0, 4)).sorted())
    }

    @Test
    fun playNextAfterAnAddToQueueStillPlaysNext() {
        println("[PAR-CARD-01-SHUFFLE-END-THEN-NEXT] phase=start")
        val order = UpNextShuffleOrder(intArrayOf(2, 3, 0, 1))
        UpNextShuffleOrder.insertAtEnd = true
        val queued = order.cloneAndInsert(4, 1)
        // The current song is list index 0; "Play next" inserts at list index 1 with no Add to queue flag set.
        val after = played(queued.cloneAndInsert(1, 1))
        println("[PAR-CARD-01-SHUFFLE-END-THEN-NEXT] queued=${played(queued)} after=$after")
        assertEquals(listOf(3, 4, 0, 1, 2, 5), after)
    }
}
