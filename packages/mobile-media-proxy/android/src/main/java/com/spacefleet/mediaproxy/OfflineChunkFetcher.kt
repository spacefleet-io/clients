package com.spacefleet.mediaproxy

import android.util.Log
import java.io.BufferedInputStream
import java.io.FileInputStream

/**
 * [ChunkFetcher] that serves objects from the offline [OfflineStore] and runs
 * them through the exact same [MediaCrypto] decrypt the tunnel client uses,
 * so [PlaybackHttpServer]
 * (and everything mpv sees) is identical online and offline. Stored objects
 * above [ChunkFetcher.SPOOL_THRESHOLD_BYTES] (subtitle sidecars) are decrypted
 * file-to-file through [spool] instead of being read whole into the heap.
 *
 * Objects missing from the store are delegated to [fallback] (the live
 * tunnel client) when one is supplied; with no fallback (airplane mode, or
 * `clientKind: "offline"`) a missing object is a hard error that the HTTP
 * server turns into a 502.
 */
class OfflineChunkFetcher(
  private val store: OfflineStore,
  private val masterKey: ByteArray,
  private val spool: PlaintextSpool,
  private val fallback: ChunkFetcher? = null,
) : ChunkFetcher {
  override fun openObject(key: String): ObjectBody {
    if (store.has(key)) {
      val start = System.currentTimeMillis()
      val file = store.file(key)
      val storedBytes = file.length()
      if (storedBytes > ChunkFetcher.SPOOL_THRESHOLD_BYTES) {
        spool.open(key)?.let { return it }
        val body = BufferedInputStream(FileInputStream(file), MediaCrypto.STREAM_PIECE_BYTES).use {
          spool.spool(key, masterKey, it)
        }
        Log.i(
          TAG,
          "object.offline_spool key=$key storedBytes=$storedBytes plaintextBytes=${body.length} ms=${System.currentTimeMillis() - start}"
        )
        return body
      }
      val plaintext = MediaCrypto.decryptSegment(masterKey, store.read(key))
      Log.i(
        TAG,
        "object.offline_hit key=$key plaintextBytes=${plaintext.length} ms=${System.currentTimeMillis() - start}"
      )
      return ObjectBody.InMemory(plaintext)
    }
    val network = fallback
      ?: throw IllegalStateException("offline_object_missing: $key")
    Log.i(TAG, "object.offline_miss_fallback key=$key")
    return network.openObject(key)
  }

  /** Stored objects are a cheap local read and this fetcher has no cache to warm: only forward misses to the live fetcher. */
  override fun prefetch(key: String) {
    if (!store.has(key)) fallback?.prefetch(key)
  }

  /** Only the live fetcher has network fetches to abort. */
  override fun cancelInFlight(matches: (String) -> Boolean): Int = fallback?.cancelInFlight(matches) ?: 0

  /** Stored objects are read from disk anyway: only the live fetcher's cache keeps pinned objects. */
  override fun pin(keys: Set<String>) {
    fallback?.pin(keys)
  }

  override fun shutdown() {
    fallback?.shutdown()
    spool.clear()
  }

  companion object {
    private const val TAG = "OfflineChunkFetcher"
  }
}
