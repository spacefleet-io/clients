package com.spacefleet.mediaproxy

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * PAR-FMT-01: a Parrot track file is stored whole, cut into 1 MiB plaintext chunks, and the proxy serves it at
 * `/playback/chunked/{id}` by mapping each `Range:` request onto the chunks it covers. A wrong slice would hand the player
 * bytes from the wrong place in the FLAC (garbage audio, or a decoder crash after a seek); a wrong range answer would make
 * Media3 refuse the stream. Every case reassembles the slices against a reference byte array, so an off-by-one shows up as
 * a content mismatch, not just a count.
 */
class ChunkedFileTest {
  private val mib = 1L shl 20

  private fun log(msg: String) = println("[chunked-file-test] $msg")

  /** A file of [size] bytes cut into [chunkSize] pieces (the last one shorter), keys `library/chunks/c<i>`. */
  private fun file(size: Long, chunkSize: Long = mib, shuffle: Boolean = false): ChunkedFile {
    val refs = ArrayList<ChunkRef>()
    var off = 0L
    var i = 0
    while (off < size) {
      val n = minOf(chunkSize, size - off)
      refs.add(ChunkRef("library/chunks/c$i", off, n))
      off += n
      i++
    }
    val input = if (shuffle) refs.reversed() else refs
    return ChunkedFile("tf-1", "audio/flac", size, input)
  }

  /** Walks `[start, end]` through [file]'s slices as the server writes them: each served byte must be the next file byte. */
  private fun assertCovers(file: ChunkedFile, start: Long, end: Long) {
    val slices = file.slices(start, end)
    log("range $start-$end/${file.sizeBytes} -> ${slices.size} slice(s): $slices")
    assertEquals("total length", end - start + 1, slices.sumOf { it.length })
    var pos = start
    var lastIndex = -1
    for (s in slices) {
      assertTrue("slices in file order: $slices", s.index > lastIndex)
      lastIndex = s.index
      val chunk = file.chunks[s.index]
      assertTrue("slice inside its chunk: $s chunk=$chunk", s.offsetInChunk >= 0 && s.offsetInChunk + s.length <= chunk.plainSize)
      assertTrue("non-empty slice: $s", s.length > 0)
      for (k in 0 until s.length) {
        val abs = chunk.plainOffset + s.offsetInChunk + k
        assertEquals("file offset served at range position $pos (slice $s)", pos, abs)
        pos++
      }
    }
    assertEquals("reassembly ends at the range end", end + 1, pos)
  }

  @Test
  fun slicesSpanChunkBoundaries() {
    log("phase: 3.5 MiB file, ranges across boundaries")
    val f = file(3 * mib + mib / 2)
    log("chunks=${f.chunks}")
    assertCovers(f, 0, f.sizeBytes - 1) // whole file: 4 slices
    assertEquals(4, f.slices(0, f.sizeBytes - 1).size)
    assertCovers(f, mib - 10, mib + 9) // straddles chunk 0/1
    assertEquals(listOf(ChunkSlice(0, mib - 10, 10), ChunkSlice(1, 0, 10)), f.slices(mib - 10, mib + 9))
    assertCovers(f, mib / 2, 3 * mib + 100) // starts mid-chunk 0, ends in the short last chunk
  }

  @Test
  fun firstAndLastBytesAndExactBoundaries() {
    log("phase: single-byte and boundary ranges")
    val f = file(2 * mib + 1)
    assertEquals(listOf(ChunkSlice(0, 0, 1)), f.slices(0, 0)) // Media3 / SubWarm probe `bytes=0-0`
    assertEquals(listOf(ChunkSlice(2, 0, 1)), f.slices(f.sizeBytes - 1, f.sizeBytes - 1)) // a 1-byte last chunk
    assertEquals(listOf(ChunkSlice(1, 0, mib)), f.slices(mib, 2 * mib - 1)) // exactly chunk 1
    assertEquals(listOf(ChunkSlice(0, mib - 1, 1), ChunkSlice(1, 0, 1)), f.slices(mib - 1, mib))
    assertCovers(f, mib - 1, mib)
  }

  @Test
  fun rangeInsideOneChunk() {
    log("phase: range within chunk 2")
    val f = file(5 * mib)
    assertEquals(listOf(ChunkSlice(2, 1000, 4096)), f.slices(2 * mib + 1000, 2 * mib + 1000 + 4095))
    assertCovers(f, 2 * mib + 1000, 2 * mib + 5095)
  }

  @Test
  fun smallChunksAndSingleChunkFile() {
    log("phase: odd chunk size and a file smaller than one chunk")
    val odd = file(1000, chunkSize = 7)
    for ((s, e) in listOf(0L to 999L, 6L to 7L, 13L to 14L, 500L to 523L, 993L to 999L)) assertCovers(odd, s, e)
    val tiny = file(10)
    assertEquals(1, tiny.chunks.size)
    assertEquals(listOf(ChunkSlice(0, 3, 4)), tiny.slices(3, 6))
  }

  @Test
  fun unsortedChunksAreSorted() {
    log("phase: chunks registered in reverse order")
    val f = file(3 * mib, shuffle = true)
    log("sorted=${f.chunks.map { it.plainOffset }}")
    assertEquals(listOf(0L, mib, 2 * mib), f.chunks.map { it.plainOffset })
    assertEquals("library/chunks/c0", f.chunks[0].objectKey)
    assertCovers(f, mib - 5, 2 * mib + 5)
  }

  @Test
  fun indexOfFindsTheHoldingChunk() {
    log("phase: indexOf at every boundary of a 4-chunk file")
    val f = file(4 * mib)
    for (i in 0 until 4) {
      val start = i * mib
      assertEquals("start of chunk $i", i, f.indexOf(start))
      assertEquals("end of chunk $i", i, f.indexOf(start + mib - 1))
    }
  }

  @Test
  fun rangesOutsideTheFileAreRefused() {
    val f = file(mib)
    for ((s, e) in listOf(-1L to 10L, 10L to 9L, 0L to mib)) {
      try {
        f.slices(s, e)
        fail("expected refusal for $s-$e")
      } catch (err: IllegalArgumentException) {
        log("refused $s-$e: ${err.message}")
      }
    }
  }

  private fun assertInvalid(label: String, build: () -> ChunkedFile) {
    try {
      val f = build()
      fail("$label: expected chunked_file_invalid, got chunks=${f.chunks}")
    } catch (err: IllegalArgumentException) {
      log("$label refused: ${err.message}")
      assertTrue("$label message: ${err.message}", err.message!!.startsWith("chunked_file_invalid"))
    }
  }

  @Test
  fun badTilingIsRefusedAtRegistration() {
    log("phase: gap, overlap, size mismatch, empty")
    assertInvalid("gap") { ChunkedFile("x", "audio/flac", 30, listOf(ChunkRef("a", 0, 10), ChunkRef("b", 15, 15))) }
    assertInvalid("overlap") { ChunkedFile("x", "audio/flac", 20, listOf(ChunkRef("a", 0, 10), ChunkRef("b", 5, 15))) }
    assertInvalid("not from 0") { ChunkedFile("x", "audio/flac", 10, listOf(ChunkRef("a", 2, 8))) }
    assertInvalid("short of size") { ChunkedFile("x", "audio/flac", 30, listOf(ChunkRef("a", 0, 10), ChunkRef("b", 10, 10))) }
    assertInvalid("past size") { ChunkedFile("x", "audio/flac", 15, listOf(ChunkRef("a", 0, 10), ChunkRef("b", 10, 10))) }
    assertInvalid("empty chunk") { ChunkedFile("x", "audio/flac", 10, listOf(ChunkRef("a", 0, 0), ChunkRef("b", 0, 10))) }
    assertInvalid("no chunks") { ChunkedFile("x", "audio/flac", 10, emptyList()) }
    assertInvalid("empty id") { ChunkedFile("", "audio/flac", 10, listOf(ChunkRef("a", 0, 10))) }
  }

  @Test
  fun fromJsonReadsWhatTheJsBridgeSends() {
    log("phase: JSON from MediaProxy.registerChunkedFile")
    val json = JSONObject()
      .put("id", "tf/Nook 01")
      .put("mime", "audio/mpeg")
      .put("sizeBytes", mib + 3)
      .put(
        "chunks",
        JSONArray()
          .put(JSONObject().put("objectKey", "library/chunks/b").put("plainOffset", mib).put("plainSize", 3))
          .put(JSONObject().put("objectKey", "library/chunks/a").put("plainOffset", 0).put("plainSize", mib)),
      )
    log("json=$json")
    val f = ChunkedFile.fromJson(json)
    assertEquals("tf/Nook 01", f.id)
    assertEquals("audio/mpeg", f.mime)
    assertEquals(mib + 3, f.sizeBytes)
    assertEquals(listOf("library/chunks/a", "library/chunks/b"), f.chunks.map { it.objectKey })
  }

  @Test
  fun httpRangeForms() {
    val total = 3 * mib
    val cases = listOf(
      null to ByteRange(0, total - 1, false),
      "" to ByteRange(0, total - 1, false),
      "items=1-2" to ByteRange(0, total - 1, false),
      "bytes=0-0" to ByteRange(0, 0, true),
      "bytes=100-199" to ByteRange(100, 199, true),
      "bytes=100-" to ByteRange(100, total - 1, true),
      "bytes=-500" to ByteRange(total - 500, total - 1, true),
      "bytes=-${total + 10}" to ByteRange(0, total - 1, true),
      "bytes=100-${total + 999}" to ByteRange(100, total - 1, true),
    )
    for ((header, want) in cases) {
      val got = HttpRange.parse(header, total)
      log("parse($header, $total) = $got")
      assertEquals("header=$header", want, got)
    }
  }

  @Test
  fun unsatisfiableRangesAre416() {
    val total = 1000L
    for (header in listOf("bytes=1000-", "bytes=1000-1100", "bytes=5-3", "bytes=-0")) {
      val got = HttpRange.parse(header, total)
      log("parse($header, $total) = $got")
      assertTrue("header=$header must be invalid", got.invalid)
      assertFalse("header=$header is not a servable range", got.isRange)
    }
  }
}
