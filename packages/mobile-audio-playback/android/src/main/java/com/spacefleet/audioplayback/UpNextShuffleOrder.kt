package com.spacefleet.audioplayback

import androidx.media3.exoplayer.source.ShuffleOrder
import kotlin.random.Random

/**
 * The shuffled play order, kept so songs added to a playing queue land where the user asked even with shuffle on
 * (PAR-CARD-01), as they do with shuffle off: a queue filled from empty is drawn at random; songs added with
 * "Play next" play right after the song before them in the list (the current song); songs added with "Add to queue"
 * play last. Media3's own `DefaultShuffleOrder` scatters inserted songs at random, so "Play next" would not play next.
 *
 * "Play next" on the list's last song and "Add to queue" insert at the same list index, so `AudioPlaybackModule`
 * says which one it is ([insertAtEnd]) just before it adds them; the player service runs in the app's process, and
 * only the module adds songs to a playing queue.
 */
class UpNextShuffleOrder(private val order: IntArray, private val random: Random = Random.Default) : ShuffleOrder {
    private val position = IntArray(order.size).also { positions -> order.forEachIndexed { at, index -> positions[index] = at } }

    override fun getLength() = order.size

    override fun getNextIndex(index: Int): Int = position[index].let { at -> if (at + 1 < order.size) order[at + 1] else -1 }

    override fun getPreviousIndex(index: Int): Int = position[index].let { at -> if (at > 0) order[at - 1] else -1 }

    override fun getLastIndex(): Int = if (order.isEmpty()) -1 else order[order.size - 1]

    override fun getFirstIndex(): Int = if (order.isEmpty()) -1 else order[0]

    override fun cloneAndInsert(insertionIndex: Int, insertionCount: Int): ShuffleOrder {
        val atEnd = insertAtEnd
        insertAtEnd = false
        val added = IntArray(insertionCount) { insertionIndex + it }
        if (order.isEmpty()) return UpNextShuffleOrder(added.also { it.shuffle(random) }, random)
        // Songs at or after the insertion point move up by the inserted count.
        val shifted = IntArray(order.size) { at -> order[at].let { if (it >= insertionIndex) it + insertionCount else it } }
        val at = when {
            atEnd -> shifted.size
            insertionIndex == 0 -> 0
            else -> position[insertionIndex - 1] + 1
        }
        return UpNextShuffleOrder(shifted.copyOfRange(0, at) + added + shifted.copyOfRange(at, shifted.size), random)
    }

    override fun cloneAndRemove(indexFrom: Int, indexToExclusive: Int): ShuffleOrder {
        val count = indexToExclusive - indexFrom
        val kept = order.filter { it < indexFrom || it >= indexToExclusive }.map { if (it >= indexToExclusive) it - count else it }
        return UpNextShuffleOrder(kept.toIntArray(), random)
    }

    override fun cloneAndClear(): ShuffleOrder = UpNextShuffleOrder(IntArray(0), random)

    companion object {
        /** Set (on the main thread) right before "Add to queue" adds songs; the next insert reads and clears it. */
        @Volatile
        var insertAtEnd = false
    }
}
