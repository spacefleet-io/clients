package com.spacebadger.mobile.library

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Packed chunk lists (LIB-FMT-11): one format's or one audio track's whole list of chunks as one `media_chunk_lists`
 * row and one JSON object in op stream 4. Kotlin port of `packages/library-db-definition/src/chunkLists.ts`; the
 * contract is `packages/library-db-definition/test-vectors/chunk-lists.json` (ChunkListCodecTest runs it). Byte
 * layout:
 *   - `sizes`: one unsigned LEB128 varint per chunk holding `sizeBytes + 1`; `0` = size unknown (null).
 *   - `starts`: null when no chunk has a start. Else one varint per chunk: `0` = no start, else
 *     `zigzag(ms - previousMs) + 1`, `ms` = start rounded to whole ms, `previousMs` = last chunk WITH a start (0 first).
 *   - key mode 0: UTF-8 key texts joined by `\n`. Key mode 1: 16 raw UUID bytes per chunk, key i =
 *     `media/<placementId>/<uuid i>`. Key mode 2: a 16-byte seed, key i = `media/<placementId>/` + UUID text of the
 *     first 16 bytes of HMAC-SHA256(seed, "chunk:" || u32be(i)).
 */
object ChunkListCodec {
  const val KEY_MODE_TEXTS = 0
  const val KEY_MODE_UUID_BYTES = 1
  const val KEY_MODE_SEED = 2

  /** `media_chunk_lists.owner_kind`. */
  const val OWNER_KIND_FORMAT = 1
  const val OWNER_KIND_AUDIO_TRACK = 2

  const val SEED_BYTES = 16

  /** Largest value a JS reader holds exactly (`Number.MAX_SAFE_INTEGER`): the TS writer refuses anything above it. */
  private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

  /** One chunk as players see it (`MediaDetails` `format.chunks`, unchanged by LIB-FMT-11). */
  data class Chunk(val key: String, val sizeBytes: Long?, val startSeconds: Double?)

  /** One packed list (a `media_chunk_lists` row minus owner columns and `updated_at`). */
  class Packed(
    val placementId: String,
    val keyMode: Int,
    val keyData: ByteArray,
    val count: Int,
    val sizes: ByteArray,
    val starts: ByteArray?
  )

  /** A list that does not decode: corrupt bytes or a writer bug. Never skipped (LIB-OPS-01). */
  class FormatException(message: String) : IllegalArgumentException("CHUNK_LIST_FORMAT: $message")

  private const val MEDIA_PREFIX = "media/"
  private val HEX = "0123456789abcdef".toCharArray()
  private val CHUNK_PREFIX = "chunk:".toByteArray(Charsets.US_ASCII)

  // --- varints -------------------------------------------------------------------------------------------------------

  private fun writeVarint(out: ByteArrayOutputStream, value: Long) {
    if (value < 0 || value > MAX_SAFE_INTEGER) throw FormatException("varint out of range: $value")
    var v = value
    while (v >= 0x80) {
      out.write(((v and 0x7f) or 0x80).toInt())
      v = v ushr 7
    }
    out.write(v.toInt())
  }

  /** Reads exactly [count] varints covering every byte; calls [each] with (index, value). */
  private inline fun readVarints(bytes: ByteArray, count: Int, field: String, each: (Int, Long) -> Unit) {
    var offset = 0
    for (i in 0 until count) {
      var value = 0L
      var shift = 0
      while (true) {
        if (offset >= bytes.size) throw FormatException("$field: $i of $count values, bytes ran out")
        val byte = bytes[offset++].toInt() and 0xff
        value = value or ((byte and 0x7f).toLong() shl shift)
        if (byte < 0x80) break
        shift += 7
        if (shift > 56) throw FormatException("$field: varint $i too long")
      }
      each(i, value)
    }
    if (offset != bytes.size) throw FormatException("$field: ${bytes.size - offset} bytes left after $count values")
  }

  private fun zigzag(n: Long) = if (n >= 0) n * 2 else -n * 2 - 1
  private fun unzigzag(z: Long) = if (z % 2 == 0L) z / 2 else -(z + 1) / 2

  fun encodeSizes(sizes: List<Long?>): ByteArray {
    val out = ByteArrayOutputStream(sizes.size * 3)
    for (size in sizes) writeVarint(out, if (size == null) 0 else size + 1)
    return out.toByteArray()
  }

  fun decodeSizes(bytes: ByteArray, count: Int): Array<Long?> {
    val out = arrayOfNulls<Long>(count)
    readVarints(bytes, count, "sizes") { i, v -> out[i] = if (v == 0L) null else v - 1 }
    return out
  }

  /** Same rounding as JS `Math.round` (half up): `Math.floor(x + 0.5)`. */
  private fun roundMs(startSeconds: Double): Long {
    if (!startSeconds.isFinite()) throw FormatException("start not finite: $startSeconds")
    return Math.floor(startSeconds * 1000 + 0.5).toLong()
  }

  fun encodeStarts(starts: List<Double?>): ByteArray? {
    if (starts.all { it == null }) return null
    val out = ByteArrayOutputStream(starts.size * 2)
    var previousMs = 0L
    for (start in starts) {
      if (start == null) {
        out.write(0)
        continue
      }
      val ms = roundMs(start)
      writeVarint(out, zigzag(ms - previousMs) + 1)
      previousMs = ms
    }
    return out.toByteArray()
  }

  fun decodeStarts(bytes: ByteArray?, count: Int): Array<Double?> {
    val out = arrayOfNulls<Double>(count)
    if (bytes == null) return out
    var previousMs = 0L
    readVarints(bytes, count, "starts") { i, v ->
      if (v != 0L) {
        previousMs += unzigzag(v - 1)
        out[i] = previousMs / 1000.0
      }
    }
    return out
  }

  // --- keys ----------------------------------------------------------------------------------------------------------

  private fun uuidToBytes(uuid: String, out: ByteArray, offset: Int) {
    var j = 0
    for (i in 0 until 16) {
      if (uuid[j] == '-') j += 1
      out[offset + i] = ((Character.digit(uuid[j], 16) shl 4) or Character.digit(uuid[j + 1], 16)).toByte()
      j += 2
    }
  }

  /** `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` on `key` from [start] to its end. */
  private fun isLowerUuid(key: String, start: Int): Boolean {
    if (key.length - start != 36) return false
    for (i in 0 until 36) {
      val c = key[start + i]
      val ok = if (i == 8 || i == 13 || i == 18 || i == 23) c == '-' else (c in '0'..'9' || c in 'a'..'f')
      if (!ok) return false
    }
    return true
  }

  private fun appendUuid(sb: StringBuilder, bytes: ByteArray, offset: Int) {
    for (i in 0 until 16) {
      if (i == 4 || i == 6 || i == 8 || i == 10) sb.append('-')
      val b = bytes[offset + i].toInt() and 0xff
      sb.append(HEX[b ushr 4]).append(HEX[b and 15])
    }
  }

  private fun seedMac(seed: ByteArray): Mac {
    if (seed.size != SEED_BYTES) throw FormatException("seed must be 16 bytes, got ${seed.size}")
    return Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(seed, "HmacSHA256")) }
  }

  private fun seedKey(mac: Mac, placementId: String, index: Long): String {
    if (index < 0 || index > 0xffffffffL) throw FormatException("chunk index out of range: $index")
    mac.update(CHUNK_PREFIX)
    mac.update(ByteBuffer.allocate(4).putInt(index.toInt()).array())
    val digest = mac.doFinal()
    val sb = StringBuilder(6 + placementId.length + 1 + 36).append("media/").append(placementId).append('/')
    appendUuid(sb, digest, 0)
    return sb.toString()
  }

  /** Key of chunk [index] of a key-mode-2 list. */
  fun seedChunkKey(seed: ByteArray, placementId: String, index: Long): String = seedKey(seedMac(seed), placementId, index)

  /** Every key of a list, in chunk order. */
  fun keys(list: Packed): List<String> {
    val count = list.count
    if (count < 0) throw FormatException("bad count $count")
    return when (list.keyMode) {
      KEY_MODE_TEXTS -> {
        if (count == 0) {
          if (list.keyData.isNotEmpty()) throw FormatException("key texts present for an empty list")
          return emptyList()
        }
        val text = try {
          Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(list.keyData))
            .toString()
        } catch (error: CharacterCodingException) {
          throw FormatException("key texts are not UTF-8")
        }
        val keys = text.split('\n')
        if (keys.size != count) throw FormatException("key texts: ${keys.size} keys for count $count")
        keys
      }
      KEY_MODE_UUID_BYTES -> {
        if (list.keyData.size.toLong() != count.toLong() * 16) {
          throw FormatException("uuid bytes: ${list.keyData.size} bytes for count $count")
        }
        val prefix = "media/${list.placementId}/"
        List(count) { i -> StringBuilder(prefix.length + 36).append(prefix).also { appendUuid(it, list.keyData, i * 16) }.toString() }
      }
      KEY_MODE_SEED -> {
        val mac = seedMac(list.keyData)
        List(count) { i -> seedKey(mac, list.placementId, i.toLong()) }
      }
      else -> throw FormatException("unknown key mode ${list.keyMode}")
    }
  }

  // --- pack / unpack -------------------------------------------------------------------------------------------------

  /**
   * Packs explicit keys (conversion of old rows): key mode 1 when every key is `media/<one placement>/<lowercase
   * uuid>`, so it round-trips byte for byte; key mode 0 otherwise.
   */
  fun pack(chunks: List<Chunk>): Packed {
    val sizes = encodeSizes(chunks.map { it.sizeBytes })
    val starts = encodeStarts(chunks.map { it.startSeconds })
    var placement: String? = null
    var onePlacement = true
    var allUuidKeys = chunks.isNotEmpty()
    for (chunk in chunks) {
      // `^media/([^/]+)/([^/]+)$` and a lowercase UUID tail, as in chunkLists.ts, without a regex per key: the
      // conversion runs it on every chunk row of the phone.
      val key = chunk.key
      val slash = if (key.startsWith(MEDIA_PREFIX)) key.indexOf('/', MEDIA_PREFIX.length) else -1
      val matched = slash > MEDIA_PREFIX.length && slash < key.length - 1 && key.indexOf('/', slash + 1) < 0
      val pLength = if (matched) slash - MEDIA_PREFIX.length else 0
      val first = placement
      if (first == null) {
        placement = key.substring(MEDIA_PREFIX.length, MEDIA_PREFIX.length + pLength)
      } else if (first.length != pLength || !key.regionMatches(MEDIA_PREFIX.length, first, 0, pLength)) {
        onePlacement = false
      }
      if (allUuidKeys && !(matched && isLowerUuid(key, slash + 1))) allUuidKeys = false
    }
    val placementId = if (onePlacement && placement != null) placement else ""
    if (allUuidKeys && placementId.isNotEmpty()) {
      val keyData = ByteArray(chunks.size * 16)
      chunks.forEachIndexed { i, chunk -> uuidToBytes(chunk.key.substring(chunk.key.lastIndexOf('/') + 1), keyData, i * 16) }
      return Packed(placementId, KEY_MODE_UUID_BYTES, keyData, chunks.size, sizes, starts)
    }
    val keyText = StringBuilder()
    chunks.forEachIndexed { i, chunk ->
      if (chunk.key.contains('\n')) throw FormatException("chunk key contains a line break: ${chunk.key}")
      if (i > 0) keyText.append('\n')
      keyText.append(chunk.key)
    }
    return Packed(placementId, KEY_MODE_TEXTS, keyText.toString().toByteArray(Charsets.UTF_8), chunks.size, sizes, starts)
  }

  /** Packs a list whose keys derive from a seed (key mode 2). */
  fun packSeeded(placementId: String, seed: ByteArray, sizes: List<Long?>, starts: List<Double?>): Packed {
    if (seed.size != SEED_BYTES) throw FormatException("seed must be 16 bytes, got ${seed.size}")
    if (placementId.isEmpty() || placementId.contains('/')) throw FormatException("bad placement id \"$placementId\"")
    if (sizes.size != starts.size) throw FormatException("sizes (${sizes.size}) and starts (${starts.size}) differ in length")
    return Packed(placementId, KEY_MODE_SEED, seed.copyOf(), sizes.size, encodeSizes(sizes), encodeStarts(starts))
  }

  fun unpack(list: Packed): List<Chunk> {
    val keys = keys(list)
    val sizes = decodeSizes(list.sizes, list.count)
    val starts = decodeStarts(list.starts, list.count)
    return List(keys.size) { i -> Chunk(keys[i], sizes[i], starts[i]) }
  }

  // --- JSON fields (op stream 4: standard padded base64) -------------------------------------------------------------

  private fun base64(field: String, value: String): ByteArray = try {
    Base64.getDecoder().decode(value)
  } catch (error: IllegalArgumentException) {
    throw FormatException("$field is not base64")
  }

  fun base64Text(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

  /** The op-stream-4 JSON object's fields -> a list, validated like `chunkListFromJson`. */
  fun fromJsonFields(placementId: String, keyMode: Int, keyData: String, count: Long, sizes: String, starts: String?): Packed {
    if (keyMode != KEY_MODE_TEXTS && keyMode != KEY_MODE_UUID_BYTES && keyMode != KEY_MODE_SEED) {
      throw FormatException("unknown key mode $keyMode")
    }
    if (count < 0 || count > Int.MAX_VALUE) throw FormatException("bad count $count")
    val list = Packed(
      placementId,
      keyMode,
      base64("keyData", keyData),
      count.toInt(),
      base64("sizes", sizes),
      starts?.let { base64("starts", it) }
    )
    if (keyMode == KEY_MODE_SEED && list.keyData.size != SEED_BYTES) {
      throw FormatException("seed must be 16 bytes, got ${list.keyData.size}")
    }
    return list
  }
}
