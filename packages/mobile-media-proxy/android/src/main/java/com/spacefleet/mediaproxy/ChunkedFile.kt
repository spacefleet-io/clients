package com.spacefleet.mediaproxy

import org.json.JSONObject

/** One stored piece of a [ChunkedFile]: the SFV1 object [objectKey] decrypts to the plaintext bytes `[plainOffset, plainOffset + plainSize)`. */
data class ChunkRef(val objectKey: String, val plainOffset: Long, val plainSize: Long)

/** The part of one chunk a byte range covers: [length] bytes from [offsetInChunk] of chunk [index]. */
data class ChunkSlice(val index: Int, val offsetInChunk: Long, val length: Long)

/**
 * A file stored whole but cut into plaintext chunks, each its own encrypted object (Parrot track files, PAR-FMT-01: fixed
 * 1 MiB pieces of the original audio file, the last one shorter). The proxy serves it at `/playback/chunked/{id}` and maps
 * every `Range:` request onto the chunks it covers ([slices]), so a player seeking in a long FLAC fetches and decrypts only
 * the 1 MiB pieces around the new position.
 *
 * The chunk list must tile the file exactly: sorted by offset (the constructor sorts), starting at 0, no gap and no
 * overlap, ending at [sizeBytes]. Anything else is refused at registration, never discovered mid-playback.
 */
class ChunkedFile(
  val id: String,
  val mime: String,
  val sizeBytes: Long,
  chunks: List<ChunkRef>,
) {
  val chunks: List<ChunkRef> = chunks.sortedBy { it.plainOffset }

  init {
    require(id.isNotEmpty()) { "chunked_file_invalid: empty id" }
    require(sizeBytes > 0) { "chunked_file_invalid: sizeBytes=$sizeBytes id=$id" }
    require(this.chunks.isNotEmpty()) { "chunked_file_invalid: no chunks id=$id" }
    var expected = 0L
    for ((i, c) in this.chunks.withIndex()) {
      require(c.plainSize > 0) { "chunked_file_invalid: chunk $i plainSize=${c.plainSize} id=$id" }
      require(c.plainOffset == expected) { "chunked_file_invalid: chunk $i plainOffset=${c.plainOffset} expected=$expected id=$id" }
      expected += c.plainSize
    }
    require(expected == sizeBytes) { "chunked_file_invalid: chunks end at $expected, sizeBytes=$sizeBytes id=$id" }
  }

  /**
   * The chunk slices covering the inclusive byte range [start]..[endInclusive], in file order; their lengths add up to
   * `endInclusive - start + 1`. The range must lie inside the file (the HTTP layer clamps it first).
   */
  fun slices(start: Long, endInclusive: Long): List<ChunkSlice> {
    require(start in 0..endInclusive && endInclusive < sizeBytes) { "range_outside_file: $start-$endInclusive/$sizeBytes" }
    val out = ArrayList<ChunkSlice>()
    var i = indexOf(start)
    var pos = start
    while (pos <= endInclusive) {
      val c = chunks[i]
      val from = pos - c.plainOffset
      val until = minOf(c.plainSize, endInclusive - c.plainOffset + 1)
      out.add(ChunkSlice(i, from, until - from))
      pos = c.plainOffset + until
      i++
    }
    return out
  }

  /** Index of the chunk holding byte [offset] (binary search over the sorted, contiguous offsets). */
  fun indexOf(offset: Long): Int {
    var lo = 0
    var hi = chunks.size - 1
    while (lo < hi) {
      val mid = (lo + hi + 1) ushr 1
      if (chunks[mid].plainOffset <= offset) lo = mid else hi = mid - 1
    }
    return lo
  }

  companion object {
    /** `{ id, mime, sizeBytes, chunks: [{ objectKey, plainOffset, plainSize }] }`, as JS `MediaProxy.registerChunkedFile` sends it. */
    fun fromJson(o: JSONObject): ChunkedFile {
      val arr = o.getJSONArray("chunks")
      val chunks = List(arr.length()) { i ->
        val c = arr.getJSONObject(i)
        ChunkRef(c.getString("objectKey"), c.getLong("plainOffset"), c.getLong("plainSize"))
      }
      return ChunkedFile(o.getString("id"), o.optString("mime", "application/octet-stream"), o.getLong("sizeBytes"), chunks)
    }
  }
}

/** A parsed `Range:` header against an object of a known length: [start]..[end] inclusive. */
data class ByteRange(val start: Long, val end: Long, val isRange: Boolean, val invalid: Boolean = false)

object HttpRange {
  private val RANGE = Regex("""bytes=(\d*)-(\d*)""")

  /**
   * `bytes=N-M`, `bytes=N-` and the suffix form `bytes=-K` (the last K bytes). No header or an unparseable one serves the
   * whole object (200); a start at or past the end, or an end before the start, is 416 ([ByteRange.invalid]). An end past
   * the object is clamped to its last byte.
   */
  fun parse(header: String?, total: Long): ByteRange {
    val whole = ByteRange(0, total - 1, false)
    if (header.isNullOrEmpty()) return whole
    val m = RANGE.find(header) ?: return whole
    val (startStr, endStr) = m.destructured
    if (startStr.isEmpty()) {
      val suffix = endStr.toLongOrNull() ?: return whole
      if (suffix <= 0 || total <= 0) return ByteRange(0, -1, false, invalid = true)
      return ByteRange(maxOf(0, total - suffix), total - 1, true)
    }
    val start = startStr.toLongOrNull() ?: return ByteRange(0, total - 1, false, invalid = true)
    var end = if (endStr.isEmpty()) total - 1 else endStr.toLongOrNull() ?: (total - 1)
    if (start > end || start >= total) return ByteRange(start, end, false, invalid = true)
    if (end >= total) end = total - 1
    return ByteRange(start, end, true)
  }
}
