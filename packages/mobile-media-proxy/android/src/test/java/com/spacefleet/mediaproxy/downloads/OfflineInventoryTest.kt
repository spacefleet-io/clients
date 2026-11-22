package com.spacefleet.mediaproxy.downloads

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * @req OFFL-MANAGE-01[badger-mobile]
 * @req OFFL-MANAGE-01[parrot]
 *
 * Settings › "Manage offline content" on the phones lists each complete download with the space it takes on disk and the
 * total at the top; an object two downloads share (a show's audio/subtitle objects, a song kept twice) counts once in the
 * total. "Remove all" deletes every object; removing one item keeps the objects another item still needs.
 */
class OfflineInventoryTest {
  private fun log(msg: String) = println("[offline-inventory-test] $msg")

  private fun obj(key: String) = DownloadObject(key, 0L)

  private val disk = mapOf(
    "media/ep1/init" to 100L,
    "media/ep1/c0" to 1_000L,
    "media/ep2/init" to 200L,
    "media/ep2/c0" to 2_000L,
    "media/show/audio-fr" to 500L,
    "media/show/subs-en" to 50L,
  )
  private val lists = mapOf(
    "ep1" to listOf(obj("media/ep1/init"), obj("media/ep1/c0"), obj("media/show/audio-fr"), obj("media/show/subs-en")),
    "ep2" to listOf(obj("media/ep2/init"), obj("media/ep2/c0"), obj("media/show/audio-fr"), obj("media/show/subs-en")),
  )

  private fun inventory(completed: List<Pair<String, Long>>, objects: Map<String, List<DownloadObject>> = lists): OfflineInventory {
    val inv = OfflineInventory.compute(completed, { objects[it] }, { disk[it] ?: 0L })
    log("inventory completed=${completed.map { it.first }} -> ${inv.toJson()}")
    return inv
  }

  @Test
  fun itemSizesComeFromDiskAndSharedObjectsCountOnceInTheTotal() {
    val inv = inventory(listOf("ep1" to 1_700_000_000_000L, "ep2" to 1_700_000_100_000L))
    assertEquals(listOf("ep1", "ep2"), inv.items.map { it.itemId })
    assertEquals(1_650L, inv.items[0].bytes)
    assertEquals(2_750L, inv.items[1].bytes)
    assertEquals(4, inv.items[0].objectCount)
    assertEquals(1_700_000_000_000L, inv.items[0].savedAt)
    // 100 + 1000 + 200 + 2000 + 500 + 50: audio and subtitles once, not twice (4400).
    assertEquals(3_850L, inv.totalBytes)
  }

  @Test
  fun aDuplicateKeyInOneListCountsOnceAndMissingObjectsCountZero() {
    val objects = mapOf("song" to listOf(obj("library/chunks/a"), obj("library/chunks/a"), obj("library/chunks/gone")))
    val inv = OfflineInventory.compute(listOf("song" to 0L), { objects[it] }, { if (it == "library/chunks/a") 70L else 0L })
    log("dup/missing -> ${inv.toJson()}")
    assertEquals(70L, inv.items.single().bytes)
    assertEquals(2, inv.items.single().objectCount)
    assertNull(inv.items.single().savedAt)
    assertEquals(70L, inv.totalBytes)
  }

  @Test
  fun anItemWhoseObjectListIsGoneIsListedEmpty() {
    val inv = inventory(listOf("lost" to 5L))
    assertEquals(0L, inv.items.single().bytes)
    assertEquals(0, inv.items.single().objectCount)
    assertEquals(0L, inv.totalBytes)
  }

  @Test
  fun nothingKeptIsAnEmptyListWithZeroTotal() {
    val json = inventory(emptyList()).toJson()
    assertEquals(0, json.getJSONArray("items").length())
    assertEquals(0L, json.getLong("totalBytes"))
  }

  @Test
  fun jsonCarriesWhatTheBridgeReturns() {
    val json = inventory(listOf("ep1" to 42L)).toJson()
    val row: JSONObject = json.getJSONArray("items").getJSONObject(0)
    assertEquals("ep1", row.getString("itemId"))
    assertEquals(1_650L, row.getLong("bytes"))
    assertEquals(4, row.getInt("objectCount"))
    assertEquals(42L, row.getLong("savedAt"))
    assertEquals(1_650L, json.getLong("totalBytes"))
  }

  @Test
  fun removingOneKeepsWhatAnotherItemStillNeeds() {
    val doomed = OfflineInventory.keysToDelete(lists.getValue("ep1"), listOf(lists.getValue("ep2")))
    log("remove ep1 with ep2 kept -> $doomed")
    assertEquals(listOf("media/ep1/init", "media/ep1/c0"), doomed)
  }

  @Test
  fun removeAllDeletesEveryObject() {
    // DownloadEngine.removeAll removes the ids one by one; each sees only the items not yet removed.
    val remaining = lists.toMutableMap()
    val deleted = mutableListOf<String>()
    for (id in lists.keys.toList()) {
      val removing = remaining.remove(id)!!
      val doomed = OfflineInventory.keysToDelete(removing, remaining.values)
      log("remove-all step id=$id deletes=$doomed")
      deleted += doomed
    }
    assertEquals(disk.keys.sorted(), deleted.sorted())
    assertTrue(remaining.isEmpty())
  }
}
