package com.spacebadger.mobile.library

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * @test-id MOBILE-LIB-CHUNK-LISTS-NATIVE-001
 * @level unit
 * @req LIB-FMT-11
 * @req LIB-FMT-13
 *
 * @why The phone converts its chunk tables to packed lists natively (LIB-FMT-12) and reads op-stream-4 lists that the
 *   TS, Swift and Python codecs wrote. A single byte of drift makes another client derive wrong chunk keys (a title
 *   that will not play) or refuse the list. The shared vectors (`packages/library-db-definition/test-vectors/
 *   chunk-lists.json`, generated from `chunkLists.ts`) are the contract: every key mode incl. seed HMAC-SHA256 keys,
 *   null sizes/starts, a start going backwards, non-ASCII key texts, and the lists a reader must refuse.
 */
class ChunkListCodecTest {
  private val tag = "[MOBILE-LIB-CHUNK-LISTS-NATIVE-001]"

  private fun log(phase: String, data: String = "") = println("$tag $phase $data")

  private val vectors: JSONObject by lazy {
    val stream = javaClass.classLoader!!.getResourceAsStream("chunk-lists.json") ?: error("missing chunk-lists.json on the test classpath")
    JSONObject(stream.use { it.readBytes().toString(Charsets.UTF_8) })
  }

  private fun hex(bytes: ByteArray?): String? = bytes?.joinToString("") { "%02x".format(it) }

  private fun unhex(text: String): ByteArray = ByteArray(text.length / 2) { i -> text.substring(i * 2, i * 2 + 2).toInt(16).toByte() }

  private fun JSONObject.nullableString(name: String): String? = if (isNull(name)) null else getString(name)

  private fun sizesOf(array: JSONArray): List<Long?> = List(array.length()) { i -> if (array.isNull(i)) null else array.getLong(i) }

  private fun startsOf(array: JSONArray): List<Double?> = List(array.length()) { i -> if (array.isNull(i)) null else array.getDouble(i) }

  private fun stringsOf(array: JSONArray): List<String> = List(array.length()) { i -> array.getString(i) }

  private fun fromJson(json: JSONObject): ChunkListCodec.Packed = ChunkListCodec.fromJsonFields(
    json.getString("placementId"),
    json.getInt("keyMode"),
    json.getString("keyData"),
    json.getLong("count"),
    json.getString("sizes"),
    json.nullableString("starts")
  )

  /** Checks a packed list against `expected`, then decodes the expected JSON and checks keys, sizes and starts. */
  private fun assertMatches(name: String, packed: ChunkListCodec.Packed, expected: JSONObject, sizes: List<Long?>) {
    log("check", "name=$name keyMode=${packed.keyMode} count=${packed.count} placement=${packed.placementId}")
    log("bytes", "name=$name keyData=${hex(packed.keyData)} sizes=${hex(packed.sizes)} starts=${hex(packed.starts)}")
    assertEquals("$name placementId", expected.getString("placementId"), packed.placementId)
    assertEquals("$name keyMode", expected.getInt("keyMode"), packed.keyMode)
    assertEquals("$name count", expected.getInt("count"), packed.count)
    assertEquals("$name keyDataHex", expected.getString("keyDataHex"), hex(packed.keyData))
    assertEquals("$name sizesHex", expected.getString("sizesHex"), hex(packed.sizes))
    assertEquals("$name startsHex", expected.nullableString("startsHex"), hex(packed.starts))

    val json = expected.getJSONObject("json")
    assertEquals("$name json.keyData", json.getString("keyData"), ChunkListCodec.base64Text(packed.keyData))
    assertEquals("$name json.sizes", json.getString("sizes"), ChunkListCodec.base64Text(packed.sizes))
    assertEquals("$name json.starts", json.nullableString("starts"), packed.starts?.let { ChunkListCodec.base64Text(it) })

    val decoded = fromJson(json)
    assertArrayEquals("$name decoded keyData", packed.keyData, decoded.keyData)
    val chunks = ChunkListCodec.unpack(decoded)
    val keys = stringsOf(expected.getJSONArray("keys"))
    val starts = startsOf(expected.getJSONArray("decodedStarts"))
    log("decoded", "name=$name keys=${chunks.size} first=${chunks.firstOrNull()?.key}")
    assertEquals("$name keys", keys, chunks.map { it.key })
    assertEquals("$name decoded sizes", sizes, chunks.map { it.sizeBytes })
    assertEquals("$name decoded starts", starts, chunks.map { it.startSeconds })
  }

  @Test
  fun explicitKeyListsPackLikeTheTsCodec() {
    val cases = vectors.getJSONArray("explicit")
    log("explicit.start", "cases=${cases.length()}")
    assertTrue("vectors carry explicit cases", cases.length() > 0)
    for (i in 0 until cases.length()) {
      val case = cases.getJSONObject(i)
      val name = case.getString("name")
      val input = case.getJSONObject("input").getJSONArray("chunks")
      val chunks = List(input.length()) { j ->
        val c = input.getJSONObject(j)
        ChunkListCodec.Chunk(
          c.getString("key"),
          if (c.isNull("sizeBytes")) null else c.getLong("sizeBytes"),
          if (c.isNull("startSeconds")) null else c.getDouble("startSeconds")
        )
      }
      assertMatches(name, ChunkListCodec.pack(chunks), case.getJSONObject("expected"), chunks.map { it.sizeBytes })
    }
    log("explicit.done", "cases=${cases.length()}")
  }

  /**
   * `pack` checks key shape by hand (no regex per chunk row, the conversion runs it on every row of the phone), so the
   * edges of `^media/([^/]+)/([^/]+)$` + lowercase UUID from chunkLists.ts are pinned here: each must pick the same
   * key mode and placement as the TS codec.
   */
  @Test
  fun keyShapeEdgesPickTheTsKeyModeAndPlacement() {
    val u = "0f8c3a52-6b1e-4d7a-9c2e-1a2b3c4d5e6f"
    val cases = listOf(
      Triple("uuid keys", listOf("media/p1/$u", "media/p1/$u"), 1 to "p1"),
      Triple("uppercase uuid", listOf("media/p1/${u.uppercase()}"), 0 to "p1"),
      Triple("uuid plus a char", listOf("media/p1/${u}0"), 0 to "p1"),
      Triple("dash misplaced", listOf("media/p1/0f8c3a526-b1e-4d7a-9c2e-1a2b3c4d5e6f"), 0 to "p1"),
      Triple("empty placement", listOf("media//$u"), 0 to ""),
      Triple("empty tail", listOf("media/p1/"), 0 to ""),
      Triple("extra segment", listOf("media/p1/x/$u"), 0 to ""),
      Triple("other prefix", listOf("mediax/p1/$u"), 0 to ""),
      Triple("two placements", listOf("media/p1/$u", "media/p2/$u"), 0 to ""),
      Triple("placement prefix of other", listOf("media/p1/$u", "media/p11/$u"), 0 to ""),
      Triple("one non-uuid same placement", listOf("media/p1/$u", "media/p1/seg-1"), 0 to "p1"),
      Triple("unmatched then matched", listOf("legacy/a", "media/p1/$u"), 0 to "")
    )
    for ((name, keys, expected) in cases) {
      val packed = ChunkListCodec.pack(keys.map { ChunkListCodec.Chunk(it, 1L, null) })
      log("keyShape", "name=$name keyMode=${packed.keyMode} placement=${packed.placementId}")
      assertEquals("$name keyMode", expected.first, packed.keyMode)
      assertEquals("$name placementId", expected.second, packed.placementId)
    }
  }

  @Test
  fun seededListsDeriveTheSameKeys() {
    val cases = vectors.getJSONArray("seeded")
    log("seeded.start", "cases=${cases.length()}")
    assertTrue("vectors carry seeded cases", cases.length() > 0)
    for (i in 0 until cases.length()) {
      val case = cases.getJSONObject(i)
      val input = case.getJSONObject("input")
      val sizes = sizesOf(input.getJSONArray("sizes"))
      val packed = ChunkListCodec.packSeeded(
        input.getString("placementId"),
        unhex(input.getString("seedHex")),
        sizes,
        startsOf(input.getJSONArray("starts"))
      )
      assertMatches("seeded[$i]", packed, case.getJSONObject("expected"), sizes)
    }
  }

  @Test
  fun seedKeysMatchHmacSha256Vectors() {
    val cases = vectors.getJSONArray("seedKeys")
    log("seedKeys.start", "cases=${cases.length()}")
    assertTrue("vectors carry seed keys", cases.length() > 0)
    for (i in 0 until cases.length()) {
      val case = cases.getJSONObject(i)
      val key = ChunkListCodec.seedChunkKey(unhex(case.getString("seedHex")), case.getString("placementId"), case.getLong("index"))
      log("seedKeys.case", "index=${case.getLong("index")} key=$key")
      assertEquals("seedKeys[$i]", case.getString("key"), key)
    }
  }

  @Test
  fun invalidListsAreRefusedNeverSkipped() {
    val cases = vectors.getJSONArray("invalid")
    log("invalid.start", "cases=${cases.length()}")
    assertTrue("vectors carry invalid cases", cases.length() > 0)
    for (i in 0 until cases.length()) {
      val case = cases.getJSONObject(i)
      val name = case.getString("name")
      try {
        val chunks = ChunkListCodec.unpack(fromJson(case.getJSONObject("json")))
        fail("$name decoded to ${chunks.size} chunks; must be refused (${case.getString("note")})")
      } catch (error: ChunkListCodec.FormatException) {
        log("invalid.refused", "name=$name message=${error.message}")
        assertTrue("$name message prefix", error.message!!.startsWith("CHUNK_LIST_FORMAT: "))
      }
    }
  }
}
