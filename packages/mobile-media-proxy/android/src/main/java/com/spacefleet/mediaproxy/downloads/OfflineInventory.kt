package com.spacefleet.mediaproxy.downloads

import org.json.JSONArray
import org.json.JSONObject

/** One complete download as Settings › "Manage offline content" lists it (OFFL-MANAGE-01). */
data class OfflineInventoryItem(
  val itemId: String,
  /** Bytes on disk of every object this item lists (shared objects counted in each item that holds them). */
  val bytes: Long,
  val objectCount: Int,
  /** When the download completed (epoch ms); null when unknown. */
  val savedAt: Long?,
)

/** The complete downloads and the space they take; an object shared by several items counts once in [totalBytes]. */
data class OfflineInventory(val items: List<OfflineInventoryItem>, val totalBytes: Long) {
  fun toJson(): JSONObject = JSONObject().apply {
    put("items", JSONArray().also { arr ->
      items.forEach {
        arr.put(JSONObject().apply {
          put("itemId", it.itemId)
          put("bytes", it.bytes)
          put("objectCount", it.objectCount)
          put("savedAt", it.savedAt ?: JSONObject.NULL)
        })
      }
    })
    put("totalBytes", totalBytes)
  }

  companion object {
    /**
     * Pure inventory of [completed] items `(id, completedAt)`: [objectsOf] is the item's object list (null when the list
     * file is gone: the item is then listed with 0 bytes), [sizeOf] the on-disk size of an object (0 when missing).
     * Sizes come from disk, not from the enqueue-time estimates, so the screen shows what removing frees.
     */
    fun compute(
      completed: List<Pair<String, Long>>,
      objectsOf: (String) -> List<DownloadObject>?,
      sizeOf: (String) -> Long,
    ): OfflineInventory {
      val sizes = HashMap<String, Long>()
      fun size(key: String) = sizes.getOrPut(key) { sizeOf(key) }
      val rows = completed.map { (id, completedAt) ->
        val keys = objectsOf(id).orEmpty().mapTo(LinkedHashSet()) { it.key }
        OfflineInventoryItem(
          itemId = id,
          bytes = keys.sumOf { size(it) },
          objectCount = keys.size,
          savedAt = completedAt.takeIf { it > 0L },
        )
      }
      return OfflineInventory(rows, sizes.values.sum())
    }

    /** Keys of [removing] that no object list in [others] still holds: what removing that item frees on disk. */
    fun keysToDelete(removing: List<DownloadObject>, others: Iterable<List<DownloadObject>>): List<String> {
      val inUse = HashSet<String>()
      for (list in others) for (o in list) inUse.add(o.key)
      return removing.map { it.key }.distinct().filter { it !in inUse }
    }
  }
}
