package com.spacefleet.mediaproxy.downloads

import android.util.Log
import com.spacefleet.mediaproxy.OfflineStore
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

object DownloadStatus {
  const val QUEUED = "queued"
  const val DOWNLOADING = "downloading"
  const val WAITING_NETWORK = "waiting_network"
  const val COMPLETED = "completed"
  const val FAILED = "failed"
}

object DownloadErrorCode {
  const val AUTH = "auth"
  const val NETWORK = "network"
  const val INSUFFICIENT_SPACE = "insufficient_space"
  const val STORAGE = "storage"
}

class DownloadObject(val key: String, val size: Long)

/**
 * One downloadable media file (a movie or one episode). `id` is the library
 * `media_files.id` (same key the desktop `media_local_downloads.file_id` uses),
 * so there is at most one download per file.
 *
 * The (potentially thousands of keys long) object list lives in its own file
 * ([DownloadQueueStore.objectsFile]) so the hot queue file stays tiny.
 */
class DownloadItem(
  val id: String,
  val mediaId: String,
  val title: String,
  val subtitle: String?,
  val kind: String,
  val seasonNumber: Int?,
  val episodeNumber: Int?,
  val quality: String,
  val formatId: String,
  val codec: String,
  val estimatedBytes: Long,
  val totalObjects: Int,
  var gatewayCandidates: List<String>,
  val createdAt: Long,
) {
  @Volatile var status: String = DownloadStatus.QUEUED
  @Volatile var errorCode: String? = null
  @Volatile var errorMessage: String? = null
  @Volatile var doneBytes: Long = 0L
  @Volatile var doneObjects: Int = 0
  @Volatile var storedBytes: Long = 0L
  @Volatile var completedAt: Long = 0L
  @Volatile var removed: Boolean = false

  /** Lazily loaded; null until [DownloadEngine] needs it. */
  @Volatile var objects: List<DownloadObject>? = null

  val isActive: Boolean
    get() = status == DownloadStatus.QUEUED ||
      status == DownloadStatus.DOWNLOADING ||
      status == DownloadStatus.WAITING_NETWORK

  /** Light JSON (no object list): persisted in queue.json and sent to JS. */
  fun toJson(): JSONObject = JSONObject().apply {
    put("id", id)
    put("mediaId", mediaId)
    put("title", title)
    put("subtitle", subtitle ?: JSONObject.NULL)
    put("kind", kind)
    put("seasonNumber", seasonNumber ?: JSONObject.NULL)
    put("episodeNumber", episodeNumber ?: JSONObject.NULL)
    put("quality", quality)
    put("formatId", formatId)
    put("codec", codec)
    put("estimatedBytes", estimatedBytes)
    put("totalObjects", totalObjects)
    put("gatewayCandidates", JSONArray(gatewayCandidates))
    put("createdAt", createdAt)
    put("status", status)
    put("errorCode", errorCode ?: JSONObject.NULL)
    put("errorMessage", errorMessage ?: JSONObject.NULL)
    put("doneBytes", doneBytes)
    put("doneObjects", doneObjects)
    put("storedBytes", storedBytes)
    put("completedAt", completedAt)
  }

  companion object {
    fun fromJson(o: JSONObject): DownloadItem {
      val candidates = o.optJSONArray("gatewayCandidates") ?: JSONArray()
      val item = DownloadItem(
        id = o.getString("id"),
        mediaId = o.getString("mediaId"),
        title = o.optString("title", ""),
        subtitle = if (o.isNull("subtitle")) null else o.optString("subtitle"),
        kind = o.optString("kind", "movie"),
        seasonNumber = if (o.isNull("seasonNumber")) null else o.optInt("seasonNumber"),
        episodeNumber = if (o.isNull("episodeNumber")) null else o.optInt("episodeNumber"),
        quality = o.optString("quality", ""),
        formatId = o.optString("formatId", ""),
        codec = o.optString("codec", ""),
        estimatedBytes = o.optLong("estimatedBytes", 0L),
        totalObjects = o.optInt("totalObjects", 0),
        gatewayCandidates = List(candidates.length()) { candidates.getString(it) },
        createdAt = o.optLong("createdAt", System.currentTimeMillis()),
      )
      item.status = o.optString("status", DownloadStatus.QUEUED)
      item.errorCode = if (o.isNull("errorCode")) null else o.optString("errorCode")
      item.errorMessage = if (o.isNull("errorMessage")) null else o.optString("errorMessage")
      item.doneBytes = o.optLong("doneBytes", 0L)
      item.doneObjects = o.optInt("doneObjects", 0)
      item.storedBytes = o.optLong("storedBytes", 0L)
      item.completedAt = o.optLong("completedAt", 0L)
      return item
    }
  }
}

/**
 * Texts of the download notification and its channel, translated by JS in the app language and passed through
 * `configure` (persisted in queue.json for runs without JS). A missing or blank key is null: the notification then
 * uses the module's string resources (`res/values/strings.xml` and its translations), in the phone's language.
 * `activeItems` carries the literal token `{count}`, replaced by the active item count, and `percent` the token
 * `{percent}`, replaced by the current item's progress. The iOS-only keys JS also sends are ignored.
 */
data class DownloadLabels(
  val title: String? = null,
  val channelDescription: String? = null,
  val activeItems: String? = null,
  val waitingWifi: String? = null,
  val waitingNetwork: String? = null,
  val percent: String? = null,
) {
  fun activeItemsText(count: Int): String? = activeItems?.replace("{count}", count.toString())

  fun percentText(percent: Int): String? = this.percent?.replace("{percent}", percent.toString())

  /** `put` with a null value leaves the key out. */
  fun toJson(): JSONObject = JSONObject().apply {
    put("title", title)
    put("channelDescription", channelDescription)
    put("activeItems", activeItems)
    put("waitingWifi", waitingWifi)
    put("waitingNetwork", waitingNetwork)
    put("percent", percent)
  }

  companion object {
    private const val TAG = "DownloadLabels"

    /** Tolerant parse: null/blank/unparseable input yields no labels, a blank key stays null. */
    fun fromJson(json: String?): DownloadLabels {
      if (json.isNullOrBlank()) return DownloadLabels()
      val o = try {
        JSONObject(json)
      } catch (e: Throwable) {
        Log.w(TAG, "labels.parse_failed: ${e.message}")
        return DownloadLabels()
      }
      val missing = ArrayList<String>()
      fun pick(key: String): String? {
        val v = if (o.isNull(key)) "" else o.optString(key, "")
        if (v.isBlank()) {
          missing.add(key)
          return null
        }
        return v
      }
      val labels = DownloadLabels(
        title = pick("title"),
        channelDescription = pick("channelDescription"),
        activeItems = pick("activeItems"),
        waitingWifi = pick("waitingWifi"),
        waitingNetwork = pick("waitingNetwork"),
        percent = pick("percent"),
      )
      if (missing.isNotEmpty()) Log.w(TAG, "labels.missing_keys: ${missing.joinToString(",")}")
      return labels
    }
  }
}

class DownloadConfig(
  val authToken: String,
  val appId: String,
  val wifiOnly: Boolean,
  val labels: DownloadLabels = DownloadLabels(),
) {
  fun toJson(): JSONObject = JSONObject().apply {
    put("authToken", authToken)
    put("appId", appId)
    put("wifiOnly", wifiOnly)
    put("labels", labels.toJson())
  }

  companion object {
    fun fromJson(o: JSONObject) = DownloadConfig(
      authToken = o.optString("authToken", ""),
      appId = o.optString("appId", "badger"),
      wifiOnly = o.optBoolean("wifiOnly", true),
      // Absent in queue.json written before labels existed: defaults.
      labels = DownloadLabels.fromJson(o.optJSONObject("labels")?.toString()),
    )
  }
}

/** Atomic JSON persistence for the queue (`queue.json`) and per-item object lists. */
class DownloadQueueStore(private val rootDir: File) {
  private val queueFile = File(rootDir, "queue.json")
  private val itemsDir = File(rootDir, "items").apply { mkdirs() }

  fun objectsFile(id: String): File = File(itemsDir, "${OfflineStore.hashKey(id)}.objects.json")

  fun load(): Pair<DownloadConfig?, List<DownloadItem>> {
    if (!queueFile.isFile) return null to emptyList()
    return try {
      val root = JSONObject(queueFile.readText())
      val config = root.optJSONObject("config")?.let { DownloadConfig.fromJson(it) }
      val arr = root.optJSONArray("items") ?: JSONArray()
      val items = List(arr.length()) { DownloadItem.fromJson(arr.getJSONObject(it)) }
      config to items
    } catch (_: Throwable) {
      // A corrupt queue must never brick the app: start empty, files on disk
      // are then orphans that [DownloadEngine] sweeps.
      null to emptyList()
    }
  }

  fun save(config: DownloadConfig?, items: Collection<DownloadItem>) {
    val root = JSONObject()
    if (config != null) root.put("config", config.toJson())
    val arr = JSONArray()
    items.forEach { arr.put(it.toJson()) }
    root.put("items", arr)
    atomicWrite(queueFile, root.toString())
  }

  fun saveObjects(id: String, objects: List<DownloadObject>) {
    val arr = JSONArray()
    objects.forEach { arr.put(JSONArray().put(it.key).put(it.size)) }
    atomicWrite(objectsFile(id), arr.toString())
  }

  fun loadObjects(id: String): List<DownloadObject>? {
    val f = objectsFile(id)
    if (!f.isFile) return null
    return try {
      val arr = JSONArray(f.readText())
      List(arr.length()) {
        val pair = arr.getJSONArray(it)
        DownloadObject(pair.getString(0), pair.getLong(1))
      }
    } catch (_: Throwable) {
      null
    }
  }

  fun deleteObjects(id: String) {
    objectsFile(id).delete()
  }

  private fun atomicWrite(target: File, text: String) {
    val tmp = File(target.parentFile, target.name + ".tmp")
    tmp.writeText(text)
    if (!tmp.renameTo(target)) {
      target.delete()
      if (!tmp.renameTo(target)) throw IllegalStateException("queue_write_failed: ${target.name}")
    }
  }
}
