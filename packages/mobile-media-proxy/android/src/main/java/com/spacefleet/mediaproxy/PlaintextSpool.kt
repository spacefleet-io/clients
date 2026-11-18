package com.spacefleet.mediaproxy

import android.util.Log
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.RandomAccessFile
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Disk-backed cache of decrypted objects too large for the in-memory segment LRU (subtitle sidecars). Each object is
 * decrypted straight from its source stream into a file under [dir] by [MediaCrypto.decryptStream], so a 29.5 MB PGS
 * track costs a 64 KB buffer of heap instead of several whole-object copies. Files live in the app cache directory,
 * are only ever plaintext of the current proxy, and are wiped when the proxy starts and stops.
 */
class PlaintextSpool(private val dir: File) {
  private class Entry(val file: File, val dataOffset: Long, val length: Long)

  private val lock = ReentrantLock()
  private val entries = LinkedHashMap<String, Entry>(8, 0.75f, true)
  private var diskBytes = 0L

  init {
    // A killed process leaves its spool behind; nothing in it is reusable without the index.
    dir.deleteRecursively()
    dir.mkdirs()
  }

  /** The spooled object for [key], or null when it is not (or no longer) on disk. */
  fun open(key: String): ObjectBody? = lock.withLock {
    val entry = entries[key] ?: return null
    ObjectBody.Spooled(RandomAccessFile(entry.file, "r"), entry.dataOffset, entry.length)
  }

  /** Decrypts [source] (an SFV1 envelope, or plaintext passed through) to disk as [key] and opens it. */
  fun spool(key: String, masterKey: ByteArray, source: InputStream): ObjectBody {
    dir.mkdirs()
    val start = System.currentTimeMillis()
    val file = File.createTempFile("object-", ".plain", dir)
    val payload = try {
      BufferedOutputStream(FileOutputStream(file), MediaCrypto.STREAM_PIECE_BYTES).use {
        MediaCrypto.decryptStream(masterKey, source, it)
      }
    } catch (e: Throwable) {
      file.delete()
      throw e
    }
    Log.i(
      TAG,
      "spool.write key=$key plaintextBytes=${payload.length} fileBytes=${file.length()} ms=${System.currentTimeMillis() - start}"
    )
    return lock.withLock {
      entries.remove(key)?.let { dropLocked(key, it, "replaced") }
      entries[key] = Entry(file, payload.offset, payload.length)
      diskBytes += file.length()
      evictLocked(keep = key)
      ObjectBody.Spooled(RandomAccessFile(file, "r"), payload.offset, payload.length)
    }
  }

  /** Deletes every spooled file (proxy shutdown). Bodies still being served keep their open handles. */
  fun clear() {
    lock.withLock {
      entries.clear()
      diskBytes = 0L
      dir.deleteRecursively()
    }
  }

  private fun evictLocked(keep: String) {
    val it = entries.entries.iterator()
    while (diskBytes > MAX_DISK_BYTES && it.hasNext()) {
      val (k, entry) = it.next()
      if (k == keep) continue
      it.remove()
      dropLocked(k, entry, "evict")
    }
  }

  private fun dropLocked(key: String, entry: Entry, reason: String) {
    diskBytes -= entry.file.length()
    entry.file.delete()
    Log.d(TAG, "spool.$reason key=$key diskBytes=$diskBytes")
  }

  companion object {
    private const val TAG = "PlaybackHttp"

    /** Disk budget of the spool: a handful of sidecars (a PGS track is up to ~50 MB). */
    private const val MAX_DISK_BYTES = 256L * 1024L * 1024L
  }
}
