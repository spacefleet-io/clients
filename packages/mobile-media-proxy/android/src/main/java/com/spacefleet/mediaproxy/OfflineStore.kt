package com.spacefleet.mediaproxy

import android.content.Context
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

/**
 * App-private, content-addressed store of STILL-ENCRYPTED storage objects
 * (SFV1 envelopes exactly as the gateway returns them) used for offline
 * playback.
 *
 * Layout (under `noBackupFilesDir`, never backed up / never user-visible):
 *   offline/objects/<sha256-hex(objectKey)>      one complete object
 *   offline/objects/<sha256-hex(objectKey)>.part  in-flight write (ignored, swept)
 *   offline/queue.json                           persisted queue (see [DownloadQueueStore])
 *
 * Chunk-level resume falls out of the layout: an object either exists as a
 * complete file (written to `.part`, fsynced, atomically renamed) or it does
 * not exist, so "what is left to download" is always recomputed from disk.
 * Object keys are unique across media (`media/<id>/...`), so one flat store is
 * shared by every download and by [OfflineChunkFetcher].
 */
class OfflineStore(context: Context) {
  val rootDir: File = File(context.noBackupFilesDir, "offline").apply { mkdirs() }
  private val objectsDir: File = File(rootDir, "objects").apply { mkdirs() }

  fun file(key: String): File = File(objectsDir, hashKey(key))

  fun has(key: String): Boolean = file(key).isFile

  fun sizeOf(key: String): Long = file(key).let { if (it.isFile) it.length() else 0L }

  fun read(key: String): ByteArray {
    val f = file(key)
    if (!f.isFile) throw IllegalStateException("offline_object_missing: $key")
    return f.readBytes()
  }

  /** Atomically persists [bytes] as the complete object for [key]. */
  fun write(key: String, bytes: ByteArray) {
    val target = file(key)
    val part = File(objectsDir, hashKey(key) + ".part")
    FileOutputStream(part).use { out ->
      out.write(bytes)
      out.flush()
      out.fd.sync()
    }
    if (!part.renameTo(target)) {
      part.delete()
      throw IllegalStateException("offline_store_rename_failed: $key")
    }
  }

  fun delete(keys: Collection<String>) {
    for (key in keys) {
      val h = hashKey(key)
      File(objectsDir, h).delete()
      File(objectsDir, "$h.part").delete()
    }
  }

  /** Removes leftover `.part` files from interrupted writes (process death mid-write). */
  fun sweepPartials() {
    objectsDir.listFiles { f -> f.name.endsWith(".part") }?.forEach { it.delete() }
  }

  /** Usable bytes on the volume that holds the store. */
  fun freeBytes(): Long = rootDir.usableSpace

  companion object {
    fun hashKey(key: String): String {
      val digest = MessageDigest.getInstance("SHA-256").digest(key.toByteArray(Charsets.UTF_8))
      val sb = StringBuilder(digest.size * 2)
      for (b in digest) sb.append(String.format("%02x", b))
      return sb.toString()
    }
  }
}
