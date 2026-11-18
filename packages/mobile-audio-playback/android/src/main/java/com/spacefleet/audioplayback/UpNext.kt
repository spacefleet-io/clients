package com.spacefleet.audioplayback

/**
 * The queue positions that play after `current`, in the order the player plays them (PAR-PLAY-06's Queue): `next`
 * is Media3's step (the shuffled order when shuffle is on, wrapping to the start with repeat all) and returns a
 * negative index after the last song. Stops before coming back to `current`, so repeat all lists each song once.
 */
fun upNextIndices(current: Int, count: Int, next: (Int) -> Int): List<Int> {
    if (current < 0 || current >= count) return emptyList()
    val out = ArrayList<Int>()
    var at = next(current)
    while (at >= 0 && at != current && out.size < count) {
        out.add(at)
        at = next(at)
    }
    return out
}
