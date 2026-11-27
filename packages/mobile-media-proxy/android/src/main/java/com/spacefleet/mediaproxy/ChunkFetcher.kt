package com.spacefleet.mediaproxy

import java.io.EOFException
import java.io.OutputStream
import java.io.RandomAccessFile

/**
 * Abstraction over "given an object key, return the decrypted plaintext."
 *
 * Implementation (lifecycle: created in [PlaybackBridge.startProxy], owned by
 * [PlaybackHttpServer], shut down in [PlaybackHttpServer.stop]):
 *
 *  - [StorageTunnelClient]: the only backend. Hits the SpaceBadger storage
 *    gateway over HTTPS with a bearer token, using the session-scoped
 *    `/storage/tunnel/...` endpoints. The library encryption key is held in
 *    process memory and used to derive per-object keys via HKDF; AES-GCM
 *    decrypt is local.
 *
 * Contract:
 *  - [openObject] returns the plaintext ready for HLS consumption (the
 *    SFV1 envelope is unwrapped, the length-prefix header is stripped, the
 *    GCM tag is verified). VTT subs upload plaintext and round-trip via the
 *    SFV1-magic-passthrough in [MediaCrypto.decryptSegment].
 *  - Objects up to [SPOOL_THRESHOLD_BYTES] (HLS segments) come back in memory and are LRU-cached; larger ones (subtitle
 *    sidecars: a PGS track runs to tens of MB) are decrypted in pieces into a [PlaintextSpool] file and streamed from
 *    disk, so no object is ever held whole in the heap next to the segment cache.
 *  - The same [openObject] call may be made concurrently from multiple
 *    threads (the [PlaybackHttpServer] thread pool) for the same key. Impls
 *    must dedupe in-flight fetches AND maintain an LRU cache so repeated
 *    requests don't re-pay the network + decrypt cost.
 *  - Throws on fetch failure (4xx/5xx / network error) or crypto failure.
 *    The HTTP server translates throws into 502 responses to the player.
 */
interface ChunkFetcher {
  /**
   * Returns the decrypted plaintext for [key]; the caller must [ObjectBody.release] it once served.
   * Cached, deduplicated, thread-safe.
   * Throws on fetch / crypto failure.
   */
  fun openObject(key: String): ObjectBody

  /**
   * Warms the cache for [key] ahead of the player's own request (see [SegmentPrefetcher]). The default is a plain
   * [openObject] whose result is dropped, which only makes sense for implementations that cache and dedupe in-flight
   * fetches; those without a cache override it. Failures surface to the caller, which ignores them.
   */
  fun prefetch(key: String) {
    openObject(key).release()
  }

  /**
   * Aborts the network fetches in flight for the keys [matches] accepts (a rung switch drops the variant it leaves, so its
   * read-ahead stops taking the link from the segment the switch needs, PLAY-ABR-04), including one that has not reached
   * the wire yet (still opening the session), which is aborted as it starts. Only loads ahead ([prefetch]) are aborted: a
   * fetch the player's own read ([openObject]) owns or joined is skipped, since aborting it fails that read with a 502
   * (PAR-PLAY-12), and a player read joining a fetch after it was aborted fetches the object again. Returns how many
   * fetches were aborted; the default (no network of its own) aborts nothing.
   */
  fun cancelInFlight(matches: (String) -> Boolean): Int = 0

  /**
   * Keeps the objects [keys] in the cache however much else is fetched, replacing the previous set (the openings of the
   * playing, next and previous songs, PAR-PLAY-07). The default (no cache of its own) keeps nothing.
   */
  fun pin(keys: Set<String>) {}

  /** Release any pooled resources (HTTP client, cache memory, in-flight tasks). */
  fun shutdown()

  companion object {
    /** Above this size an object is streamed through a [PlaintextSpool] file instead of decrypted in memory. */
    const val SPOOL_THRESHOLD_BYTES = 8L * 1024L * 1024L
  }
}

/** One decrypted object as the proxy serves it. */
sealed class ObjectBody {
  abstract val length: Long

  /** Writes [count] bytes of the object, starting at [offset], to [out]. */
  abstract fun writeTo(out: OutputStream, offset: Long, count: Long)

  /** Closes what the body holds open (the spool file handle); a no-op for in-memory bodies. */
  open fun release() {}

  /** A decrypted object held in memory: the [MediaCrypto.Plaintext] slice of the cipher's output, never copied. */
  class InMemory(val plaintext: MediaCrypto.Plaintext) : ObjectBody() {
    override val length: Long get() = plaintext.length.toLong()

    override fun writeTo(out: OutputStream, offset: Long, count: Long) {
      out.write(plaintext.bytes, plaintext.offset + offset.toInt(), count.toInt())
    }
  }

  /**
   * A [PlaintextSpool] entry, read through its own open handle: the spool may evict (unlink) the file meanwhile and
   * this body keeps reading it.
   */
  class Spooled(
    private val file: RandomAccessFile,
    private val dataOffset: Long,
    override val length: Long,
  ) : ObjectBody() {
    override fun writeTo(out: OutputStream, offset: Long, count: Long) {
      val buf = ByteArray(MediaCrypto.STREAM_PIECE_BYTES)
      file.seek(dataOffset + offset)
      var left = count
      while (left > 0) {
        val n = file.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
        if (n < 0) throw EOFException("spool_truncated: wanted $left more bytes")
        out.write(buf, 0, n)
        left -= n
      }
    }

    override fun release() {
      file.close()
    }
  }
}
