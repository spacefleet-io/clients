package com.spacefleet.mediaproxy

import java.io.ByteArrayOutputStream
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

/**
 * #934: [MediaCrypto.decryptSegment] hands out the plaintext as a slice of the cipher's output (no second copy), and
 * [ObjectBody.InMemory] serves byte ranges from that slice. A wrong offset would put the 6-byte length header or the
 * padding into the HLS segment mpv reads.
 */
class MediaCryptoTest {
  private val random = SecureRandom()
  private val magic = byteArrayOf(0x53, 0x46, 0x56, 0x31)

  private fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray): ByteArray {
    val extract = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(salt, "HmacSHA256")) }
    val prk = extract.doFinal(ikm)
    val expand = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(prk, "HmacSHA256")) }
    expand.update(info)
    expand.update(1)
    return expand.doFinal().copyOf(32)
  }

  /** The SFV1 envelope the ingest pipeline writes: [magic][salt][nonce][AES-GCM(header + data + pad)][tag]. */
  private fun envelope(masterKey: ByteArray, data: ByteArray, padLen: Int): ByteArray {
    val salt = ByteArray(16).also(random::nextBytes)
    val nonce = ByteArray(12).also(random::nextBytes)
    val header = byteArrayOf(
      data.size.toByte(), (data.size shr 8).toByte(), (data.size shr 16).toByte(), (data.size shr 24).toByte(),
      padLen.toByte(), (padLen shr 8).toByte(),
    )
    val padded = header + data + ByteArray(padLen) { 0x7f }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(
      Cipher.ENCRYPT_MODE,
      SecretKeySpec(hkdf(masterKey, salt, "sf-media-v1".toByteArray()), "AES"),
      GCMParameterSpec(128, nonce),
    )
    cipher.updateAAD(magic)
    return magic + salt + nonce + cipher.doFinal(padded)
  }

  private fun write(body: ObjectBody, offset: Long, count: Long): ByteArray =
    ByteArrayOutputStream().also { body.writeTo(it, offset, count) }.toByteArray()

  @Test
  fun decryptsToASliceWithoutHeaderOrPadding() {
    val masterKey = MediaCrypto.deriveMasterKey(ByteArray(32) { it.toByte() })
    val data = ByteArray(1000) { (it * 7).toByte() }
    val plaintext = MediaCrypto.decryptSegment(masterKey, envelope(masterKey, data, padLen = 24))

    assertEquals(6, plaintext.offset)
    assertEquals(data.size, plaintext.length)
    assertArrayEquals(data, plaintext.bytes.copyOfRange(plaintext.offset, plaintext.offset + plaintext.length))

    val body = ObjectBody.InMemory(plaintext)
    assertEquals(data.size.toLong(), body.length)
    assertArrayEquals(data, write(body, 0, body.length))
    assertArrayEquals(data.copyOfRange(100, 164), write(body, 100, 64))
    assertArrayEquals(data.copyOfRange(990, 1000), write(body, 990, 10))
  }

  @Test
  fun passesPlainInputThroughUncopied() {
    val vtt = "WEBVTT\n\n00:00.000 --> 00:01.000\nhi\n".toByteArray()
    val plaintext = MediaCrypto.decryptSegment(ByteArray(32), vtt)

    assertSame(vtt, plaintext.bytes)
    assertEquals(0, plaintext.offset)
    assertEquals(vtt.size, plaintext.length)
    assertArrayEquals(vtt.copyOfRange(8, 20), write(ObjectBody.InMemory(plaintext), 8, 12))
  }
}
