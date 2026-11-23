package com.spacefleet.mediaproxy

/**
 * The [ChunkedFile]s the proxy serves, by id. A registered id's file can be swapped for another (Parrot settles which
 * copy of a queued song plays, PAR-PLAY-02) only until the player first asks for that id: from then on the id keeps its
 * file, so a song never changes copy midway (PAR-PLAY-04). Thread-safe.
 */
class ChunkedFileRegistry {
  private val files = HashMap<String, ChunkedFile>()
  /** Registered ids the player has asked for: their file no longer changes. */
  private val started = HashSet<String>()

  /** Serves [file] at its id; registering the same id again replaces it and opens it to [swap] again. */
  @Synchronized
  fun register(file: ChunkedFile) {
    files[file.id] = file
    started.remove(file.id)
  }

  /** Serves [file] at its already registered id instead, unless the player already asked for it. True when swapped. */
  @Synchronized
  fun swap(file: ChunkedFile): Boolean {
    if (file.id in started || !files.containsKey(file.id)) return false
    files[file.id] = file
    return true
  }

  /** The file the player gets at [id], null when none; from now on that id keeps this file. */
  @Synchronized
  fun serve(id: String): ChunkedFile? = files[id]?.also { started.add(id) }

  /** Forgets [id]; false when it was not registered. */
  @Synchronized
  fun unregister(id: String): Boolean {
    started.remove(id)
    return files.remove(id) != null
  }

  @Synchronized
  fun clear() {
    files.clear()
    started.clear()
  }
}
