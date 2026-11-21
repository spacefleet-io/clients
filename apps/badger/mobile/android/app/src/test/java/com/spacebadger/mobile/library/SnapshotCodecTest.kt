package com.spacebadger.mobile.library

import java.io.File
import java.nio.file.Files
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * @test-id MOBILE-LIB-SNAPSHOT-NATIVE-001
 * @level unit
 * @req LIB-FMT-07
 * @req LIB-SYNC-14
 * @bugfix @regression-proof
 *
 * @why A 60 MB library threw OutOfMemoryError ("Failed to allocate a 160814436 byte allocation") and froze the phone
 *   52 s building its saved copy, because the SQLite file was read into JS as base64 and deflated in Hermes. The
 *   native codec streams file -> deflate -> AES-GCM -> file instead. It must write bytes every existing reader already
 *   decodes (storage format v2), read the copies the JS writers made (desktop `node:zlib`, older phones `fflate`), and
 *   still read v1 copies. The fixtures are shared with tests/library-snapshot-native-compat.test.ts, which decodes
 *   `native-v2.bin` with the JS readers and wrote `js-v2.bin`.
 *   Regenerate `native-v2.bin`: `SNAPSHOT_CODEC_WRITE_FIXTURE=<dir> ./gradlew :app:testDebugUnitTest --tests '*SnapshotCodecTest*'`.
 */
class SnapshotCodecTest {
  private val tag = "[MOBILE-LIB-SNAPSHOT-NATIVE-001]"
  private val key = ByteArray(32) { it.toByte() }

  private fun log(phase: String, data: String = "") = println("$tag $phase $data")

  /** Same bytes as `fixtureDb()` in tests/library-snapshot-native-compat.test.ts: a SQLite header, then a mix of
   *  repeating and LCG-random 1000-byte runs, so deflate emits several blocks and the stream spans many buffers. */
  private fun fixtureDb(size: Int = 200_000): ByteArray {
    val bytes = ByteArray(size)
    val header = "SQLite format 3\u0000".toByteArray(Charsets.US_ASCII)
    header.copyInto(bytes)
    var state = 12345
    for (i in header.size until size) {
      state = state * 1103515245 + 12345
      bytes[i] = if ((i / 1000) % 3 == 0) ((state ushr 16) and 0xff).toByte() else ((i % 251) xor ((i / 4096) and 0xff)).toByte()
    }
    return bytes
  }

  private fun fixture(name: String): ByteArray {
    val stream = javaClass.classLoader!!.getResourceAsStream("snapshot-codec/$name") ?: error("missing fixture $name")
    return stream.use { it.readBytes() }
  }

  private fun gcmOpen(stored: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, stored, 0, 12))
    return cipher.doFinal(stored, 12, stored.size - 12)
  }

  private fun gcmSeal(plain: ByteArray): ByteArray {
    val iv = ByteArray(12) { (it * 7).toByte() }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
    return iv + cipher.doFinal(plain)
  }

  private fun tempDir(): File = Files.createTempDirectory("snapshot-codec").toFile().apply { deleteOnExit() }

  @Test
  fun `native write is storage format v2 and round-trips`() {
    val dir = tempDir()
    val db = File(dir, "library.sqlite").apply { writeBytes(fixtureDb()) }
    val stored = File(dir, "snapshot.bin")
    val stages = mutableListOf<Long>()
    val written = SnapshotCodec.encrypt(db, key, stored) { _, done, _ -> stages.add(done) }
    log("state:encrypt", "dbBytes=${written.dbBytes} storedBytes=${written.storedBytes} progressEvents=${stages.size}")
    assertEquals(db.length(), written.dbBytes)
    assertEquals(stored.length(), written.storedBytes)
    assertTrue("it compresses", written.storedBytes < db.length())
    assertFalse("no partial file left", File(stored.path + ".partial").exists())
    assertEquals("progress ends at the file size", db.length(), stages.last())

    // Format: iv || GCM(00 5A 01 || raw deflate), independent of the codec's own reader.
    val frame = gcmOpen(stored.readBytes())
    assertArrayEquals(byteArrayOf(0x00, 0x5A, 0x01), frame.copyOfRange(0, 3))
    val inflater = java.util.zip.Inflater(true)
    inflater.setInput(frame, 3, frame.size - 3)
    val out = ByteArray(db.length().toInt() + 16)
    val n = inflater.inflate(out)
    inflater.end()
    assertArrayEquals("raw deflate of the SQLite file", fixtureDb(), out.copyOf(n))

    val restored = File(dir, "restored.sqlite")
    val read = SnapshotCodec.decrypt(stored, key, restored)
    log("state:decrypt", "dbBytes=${read.dbBytes} compressed=${read.compressed}")
    assertTrue(read.compressed)
    assertArrayEquals(fixtureDb(), restored.readBytes())

    System.getenv("SNAPSHOT_CODEC_WRITE_FIXTURE")?.takeIf { it.isNotBlank() }?.let { target ->
      stored.copyTo(File(target, "native-v2.bin"), overwrite = true)
      log("phase:fixture-written", target)
    }
  }

  @Test
  fun `reads the checked-in copies written by native and by the JS writer`() {
    for (name in listOf("native-v2.bin", "js-v2.bin")) {
      val dir = tempDir()
      val source = File(dir, name).apply { writeBytes(fixture(name)) }
      val target = File(dir, "out.sqlite")
      val result = SnapshotCodec.decrypt(source, key, target)
      log("state:fixture", "name=$name storedBytes=${result.storedBytes} dbBytes=${result.dbBytes}")
      assertTrue(result.compressed)
      assertArrayEquals("$name decodes to the fixture DB", fixtureDb(), target.readBytes())
    }
  }

  @Test
  fun `a v1 copy (no frame) is written through unchanged`() {
    val dir = tempDir()
    val source = File(dir, "v1.bin").apply { writeBytes(gcmSeal(fixtureDb())) }
    val target = File(dir, "out.sqlite")
    val result = SnapshotCodec.decrypt(source, key, target)
    assertFalse(result.compressed)
    assertArrayEquals(fixtureDb(), target.readBytes())
  }

  @Test
  fun `a wrong key or unknown codec leaves no file behind`() {
    val dir = tempDir()
    val db = File(dir, "library.sqlite").apply { writeBytes(fixtureDb(5_000)) }
    val stored = File(dir, "snapshot.bin")
    SnapshotCodec.encrypt(db, key, stored)
    val target = File(dir, "out.sqlite")
    try {
      SnapshotCodec.decrypt(stored, ByteArray(32) { 9 }, target)
      fail("wrong key must throw")
    } catch (expected: javax.crypto.AEADBadTagException) {
      log("state:wrong-key", expected.javaClass.simpleName)
    }
    assertFalse(target.exists())
    assertFalse(File(target.path + ".partial").exists())

    val unknown = File(dir, "unknown.bin").apply { writeBytes(gcmSeal(byteArrayOf(0x00, 0x5A, 0x07, 1, 2, 3))) }
    try {
      SnapshotCodec.decrypt(unknown, key, target)
      fail("unknown codec must throw")
    } catch (error: IllegalArgumentException) {
      assertEquals("unknown_compression_codec:7", error.message)
    }
    assertFalse(target.exists())
    assertFalse(File(target.path + ".partial").exists())
  }

  @Test
  fun `opens one library change in memory - JS-written frame, v1 plain, wrong key`() {
    // A change is stored in the same envelope as a saved copy (LIB-FMT-07), so the JS writer's copy is a valid change.
    val opened = SnapshotCodec.openPayload(fixture("js-v2.bin"), key)
    log("state:open-payload", "jsonBytes=${opened.size}")
    assertArrayEquals(fixtureDb(), opened)
    val plain = "{\"type\":\"noop\"}".toByteArray(Charsets.UTF_8)
    assertArrayEquals(plain, SnapshotCodec.openPayload(gcmSeal(plain), key))
    try {
      SnapshotCodec.openPayload(fixture("js-v2.bin"), ByteArray(32) { 9 })
      fail("wrong key must throw")
    } catch (expected: javax.crypto.AEADBadTagException) {
      log("state:open-payload-wrong-key", expected.javaClass.simpleName)
    }
    try {
      SnapshotCodec.openPayload(ByteArray(20), key)
      fail("short envelope must throw")
    } catch (error: IllegalArgumentException) {
      assertEquals("INVALID_BLOB", error.message)
    }
  }
}
