package com.spacefleet.mediaproxy

import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * AES-256-GCM + HKDF-SHA256 for the SFV1 media format.
 *
 * SFV1 wire format (must stay in sync with the badger-mobile ingest
 * pipeline and packages/content-core encryption):
 *   [4B magic "SFV1"][16B salt][12B nonce][N bytes ciphertext][16B GCM tag]
 *
 * The decrypted plaintext has a small length-prefix header:
 *   [4B UInt32LE origLen][2B UInt16LE padLen][origLen bytes data][padLen pad]
 *
 * The Cipher's AAD is the 4-byte SFV1 magic — same as the JS encrypt path
 * sets via setAAD.
 */
object MediaCrypto {
  private val MAGIC = byteArrayOf(0x53, 0x46, 0x56, 0x31) // "SFV1"
  private const val SALT_BYTES = 16
  private const val NONCE_BYTES = 12
  private const val TAG_BYTES = 16
  private const val HEADER_BYTES = 6 // UInt32LE origLen + UInt16LE padLen
  /** Piece size of [decryptStream]: what one streamed object costs in heap, whatever its size. */
  const val STREAM_PIECE_BYTES = 64 * 1024
  private val HKDF_INFO = "sf-media-v1".toByteArray()
  private val MEDIA_MASTER_SALT = "sf-media-master-salt".toByteArray()
  private val MEDIA_MASTER_INFO = "sf-media-master".toByteArray()

  /**
   * Derive the per-process media master key from the library key (32 bytes)
   * via HKDF-SHA256(salt=MEDIA_MASTER_SALT, info=MEDIA_MASTER_INFO,
   * length=32). Mirrors deriveMediaMasterKey in apps/badger/mobile/src/lib/mediaCrypto.ts.
   */
  fun deriveMasterKey(libraryKey: ByteArray): ByteArray {
    require(libraryKey.size == 32) { "library_key_size_invalid: ${libraryKey.size}" }
    return hkdfSha256(libraryKey, MEDIA_MASTER_SALT, MEDIA_MASTER_INFO, 32)
  }

  /** Media bytes inside [bytes]: [length] bytes from [offset]. [bytes] is never modified after it is returned. */
  class Plaintext(val bytes: ByteArray, val offset: Int, val length: Int)

  /**
   * Decrypt one SFV1 envelope. Returns where the plaintext sits (the length-prefix
   * header skipped) inside the cipher's own output buffer — no second copy of the
   * segment. Pass-through for non-SFV1 buffers (mirrors the
   * `wasEncrypted=false` path in mediaCrypto.ts) — used for plaintext VTT and
   * PGS subtitle files.
   */
  fun decryptSegment(masterKey: ByteArray, encrypted: ByteArray): Plaintext {
    if (encrypted.size < MAGIC.size) return Plaintext(encrypted, 0, encrypted.size)
    for (i in MAGIC.indices) {
      if (encrypted[i] != MAGIC[i]) return Plaintext(encrypted, 0, encrypted.size)
    }

    val minSize = MAGIC.size + SALT_BYTES + NONCE_BYTES + TAG_BYTES
    if (encrypted.size < minSize) {
      throw IllegalStateException("ciphertext too short ($minSize required, got ${encrypted.size})")
    }

    val saltStart = MAGIC.size
    val nonceStart = saltStart + SALT_BYTES
    val cipherStart = nonceStart + NONCE_BYTES

    val salt = encrypted.copyOfRange(saltStart, nonceStart)
    val nonce = encrypted.copyOfRange(nonceStart, cipherStart)

    val objectKey = hkdfSha256(masterKey, salt, HKDF_INFO, 32)

    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(
      Cipher.DECRYPT_MODE,
      SecretKeySpec(objectKey, "AES"),
      GCMParameterSpec(TAG_BYTES * 8, nonce)
    )
    cipher.updateAAD(MAGIC)

    val padded = cipher.doFinal(encrypted, cipherStart, encrypted.size - cipherStart)

    if (padded.size < HEADER_BYTES) {
      throw IllegalStateException("media_payload_invalid")
    }

    val origLen = (padded[0].toInt() and 0xff) or
      ((padded[1].toInt() and 0xff) shl 8) or
      ((padded[2].toInt() and 0xff) shl 16) or
      ((padded[3].toInt() and 0xff) shl 24)
    val padLen = (padded[4].toInt() and 0xff) or
      ((padded[5].toInt() and 0xff) shl 8)
    val expectedLen = HEADER_BYTES + origLen + padLen
    if (expectedLen > padded.size) {
      throw IllegalStateException("media_payload_truncated")
    }

    val dataEnd = minOf(padded.size, HEADER_BYTES + origLen)
    return Plaintext(padded, HEADER_BYTES, dataEnd - HEADER_BYTES)
  }

  /** Where the media bytes sit in what [decryptStream] wrote: [offset] past the length-prefix header, [length] bytes. */
  class StreamedPayload(val offset: Long, val length: Long)

  /**
   * [decryptSegment] for objects too large to hold in memory (a PGS sidecar runs to tens of MB): reads one SFV1
   * envelope from [input] and writes the padded plaintext (header included) to [output] in [STREAM_PIECE_BYTES]
   * pieces, so memory stays bounded whatever the object size. Non-SFV1 input is copied through unchanged.
   *
   * Android's AES/GCM provider (Conscrypt) is one-shot: it buffers the whole ciphertext until doFinal, which is what
   * ran the proxy out of heap on a 29.5 MB sidecar. GCM is CTR encryption plus a GHASH tag, so this decrypts with the
   * streaming AES/CTR cipher (counter starts at J0+1 = nonce || 00000002) and computes the tag itself. The tag is
   * only known at the end of the stream: [output] holds unauthenticated bytes until this returns, and a mismatch
   * throws [AEADBadTagException] — the caller must discard what was written.
   */
  fun decryptStream(masterKey: ByteArray, input: InputStream, output: OutputStream): StreamedPayload {
    val head = ByteArray(MAGIC.size + SALT_BYTES + NONCE_BYTES)
    val headLen = readUpTo(input, head)
    val isSfv1 = headLen >= MAGIC.size && MAGIC.indices.all { head[it] == MAGIC[it] }
    if (!isSfv1) {
      output.write(head, 0, headLen)
      return StreamedPayload(0L, headLen + input.copyTo(output, STREAM_PIECE_BYTES))
    }
    if (headLen < head.size) {
      throw IllegalStateException("ciphertext too short (${head.size + TAG_BYTES} required, got $headLen)")
    }

    val salt = head.copyOfRange(MAGIC.size, MAGIC.size + SALT_BYTES)
    val nonce = head.copyOfRange(MAGIC.size + SALT_BYTES, head.size)
    val keySpec = SecretKeySpec(hkdfSha256(masterKey, salt, HKDF_INFO, 32), "AES")

    val ecb = Cipher.getInstance("AES/ECB/NoPadding")
    ecb.init(Cipher.ENCRYPT_MODE, keySpec)
    val ghash = Ghash(ecb.doFinal(ByteArray(16)))
    val tagMask = ecb.doFinal(nonce + byteArrayOf(0, 0, 0, 1))
    val ctr = Cipher.getInstance("AES/CTR/NoPadding")
    ctr.init(Cipher.DECRYPT_MODE, keySpec, IvParameterSpec(nonce + byteArrayOf(0, 0, 0, 2)))

    ghash.update(MAGIC, 0, MAGIC.size)
    ghash.padBlock()

    // The last TAG_BYTES of the stream are the tag, not ciphertext: always hold them back until more input arrives.
    val buf = ByteArray(STREAM_PIECE_BYTES + TAG_BYTES)
    val plain = ByteArray(STREAM_PIECE_BYTES + 2 * TAG_BYTES)
    val header = ByteArray(HEADER_BYTES)
    var held = 0
    var cipherLen = 0L
    while (true) {
      val n = input.read(buf, held, buf.size - held)
      if (n < 0) break
      held += n
      if (held <= TAG_BYTES) continue
      val chunk = held - TAG_BYTES
      ghash.update(buf, 0, chunk)
      val produced = ctr.update(buf, 0, chunk, plain, 0)
      captureHeader(header, cipherLen, plain, produced)
      output.write(plain, 0, produced)
      cipherLen += chunk
      System.arraycopy(buf, chunk, buf, 0, TAG_BYTES)
      held = TAG_BYTES
    }
    if (held < TAG_BYTES) {
      throw IllegalStateException("ciphertext too short (${head.size + TAG_BYTES} required, got ${head.size + held})")
    }
    val tail = ctr.doFinal(plain, 0)
    output.write(plain, 0, tail)

    val computed = ghash.finish(MAGIC.size.toLong(), cipherLen)
    for (i in computed.indices) computed[i] = (computed[i].toInt() xor tagMask[i].toInt()).toByte()
    if (!MessageDigest.isEqual(computed, buf.copyOf(TAG_BYTES))) {
      throw AEADBadTagException("media_tag_mismatch")
    }

    if (cipherLen < HEADER_BYTES) {
      throw IllegalStateException("media_payload_invalid")
    }
    val origLen = ((header[0].toLong() and 0xff) or
      ((header[1].toLong() and 0xff) shl 8) or
      ((header[2].toLong() and 0xff) shl 16) or
      ((header[3].toLong() and 0xff) shl 24))
    val padLen = (header[4].toLong() and 0xff) or ((header[5].toLong() and 0xff) shl 8)
    if (HEADER_BYTES + origLen + padLen > cipherLen) {
      throw IllegalStateException("media_payload_truncated")
    }
    return StreamedPayload(HEADER_BYTES.toLong(), minOf(origLen, cipherLen - HEADER_BYTES))
  }

  /** Copies the plaintext length-prefix header out of the first decrypted piece(s). */
  private fun captureHeader(header: ByteArray, writtenBefore: Long, plain: ByteArray, produced: Int) {
    if (writtenBefore >= HEADER_BYTES) return
    val from = writtenBefore.toInt()
    val count = minOf(HEADER_BYTES - from, produced)
    System.arraycopy(plain, 0, header, from, count)
  }

  private fun readUpTo(input: InputStream, into: ByteArray): Int {
    var total = 0
    while (total < into.size) {
      val n = input.read(into, total, into.size - total)
      if (n < 0) break
      total += n
    }
    return total
  }

  /**
   * GHASH (NIST SP 800-38D) over GF(2^128) with Shoup's 4-bit tables — the same construction as mbedTLS
   * `gcm_mult`. Fed AAD, then ciphertext, then the bit lengths; [finish] returns S, and the GCM tag is S xor E(K, J0).
   */
  private class Ghash(h: ByteArray) {
    private val hh = LongArray(16)
    private val hl = LongArray(16)
    private var yh = 0L
    private var yl = 0L
    private val block = ByteArray(16)
    private var fill = 0

    init {
      var vh = be64(h, 0)
      var vl = be64(h, 8)
      hh[8] = vh
      hl[8] = vl
      var i = 4
      while (i > 0) {
        val t = if (vl and 1L != 0L) R_HIGH else 0L
        vl = (vh shl 63) or (vl ushr 1)
        vh = (vh ushr 1) xor t
        hh[i] = vh
        hl[i] = vl
        i = i shr 1
      }
      i = 2
      while (i <= 8) {
        vh = hh[i]
        vl = hl[i]
        for (j in 1 until i) {
          hh[i + j] = vh xor hh[j]
          hl[i + j] = vl xor hl[j]
        }
        i *= 2
      }
    }

    fun update(bytes: ByteArray, offset: Int, length: Int) {
      var pos = offset
      val end = offset + length
      if (fill > 0) {
        while (fill < 16 && pos < end) block[fill++] = bytes[pos++]
        if (fill < 16) return
        absorb(be64(block, 0), be64(block, 8))
        fill = 0
      }
      while (end - pos >= 16) {
        absorb(be64(bytes, pos), be64(bytes, pos + 8))
        pos += 16
      }
      while (pos < end) block[fill++] = bytes[pos++]
    }

    /** Zero-pads a trailing partial block (AAD and ciphertext are each padded to 16 bytes). */
    fun padBlock() {
      if (fill == 0) return
      block.fill(0, fill, 16)
      absorb(be64(block, 0), be64(block, 8))
      fill = 0
    }

    fun finish(aadBytes: Long, cipherBytes: Long): ByteArray {
      padBlock()
      absorb(aadBytes * 8, cipherBytes * 8)
      val out = ByteArray(16)
      for (i in 0 until 8) {
        out[i] = (yh ushr (56 - 8 * i)).toByte()
        out[8 + i] = (yl ushr (56 - 8 * i)).toByte()
      }
      return out
    }

    /** Y = (Y xor X) * H. */
    private fun absorb(xh: Long, xl: Long) {
      val ah = yh xor xh
      val al = yl xor xl
      var lo = (al and 0xf).toInt()
      var zh = hh[lo]
      var zl = hl[lo]
      for (i in 15 downTo 0) {
        val b = (if (i < 8) (ah ushr (56 - 8 * i)) else (al ushr (56 - 8 * (i - 8)))).toInt() and 0xff
        lo = b and 0xf
        val hi = b ushr 4
        if (i != 15) {
          val rem = (zl and 0xf).toInt()
          zl = (zh shl 60) or (zl ushr 4)
          zh = (zh ushr 4) xor (LAST4[rem] shl 48) xor hh[lo]
          zl = zl xor hl[lo]
        }
        val rem = (zl and 0xf).toInt()
        zl = (zh shl 60) or (zl ushr 4)
        zh = (zh ushr 4) xor (LAST4[rem] shl 48) xor hh[hi]
        zl = zl xor hl[hi]
      }
      yh = zh
      yl = zl
    }

    private companion object {
      const val R_HIGH = -0x1f00000000000000L // 0xe100000000000000: the GCM reduction polynomial
      val LAST4 = longArrayOf(
        0x0000, 0x1c20, 0x3840, 0x2460, 0x7080, 0x6ca0, 0x48c0, 0x54e0,
        0xe100, 0xfd20, 0xd940, 0xc560, 0x9180, 0x8da0, 0xa9c0, 0xb5e0,
      )

      fun be64(b: ByteArray, off: Int): Long {
        var v = 0L
        for (i in 0 until 8) v = (v shl 8) or (b[off + i].toLong() and 0xff)
        return v
      }
    }
  }

  // HKDF-SHA256 (RFC 5869). Matches the JS hkdfSha256 implementation in
  // mediaCrypto.ts — extract phase is HMAC(salt, ikm); expand phase chains
  // T(N) = HMAC(prk, T(N-1) || info || counter).
  private fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
    val extract = Mac.getInstance("HmacSHA256")
    extract.init(SecretKeySpec(salt, "HmacSHA256"))
    val prk = extract.doFinal(ikm)

    val expand = Mac.getInstance("HmacSHA256")
    expand.init(SecretKeySpec(prk, "HmacSHA256"))

    val output = ByteArray(length)
    var t = ByteArray(0)
    var pos = 0
    var counter = 1
    while (pos < length) {
      expand.reset()
      expand.update(t)
      expand.update(info)
      expand.update(counter.toByte())
      t = expand.doFinal()
      val toCopy = minOf(t.size, length - pos)
      System.arraycopy(t, 0, output, pos, toCopy)
      pos += toCopy
      counter++
    }
    return output
  }
}
