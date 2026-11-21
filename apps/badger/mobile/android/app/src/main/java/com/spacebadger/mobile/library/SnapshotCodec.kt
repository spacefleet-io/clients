package com.spacebadger.mobile.library

import java.io.BufferedOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream
import java.security.SecureRandom
import java.util.zip.DataFormatException
import java.util.zip.Deflater
import java.util.zip.DeflaterOutputStream
import java.util.zip.Inflater
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * A saved copy of the library on disk (storage format v2, LIB-FMT-07), written and read in one streaming pass on a
 * worker thread (LIB-SYNC-14): the SQLite file never crosses the bridge and never sits whole in the Java heap.
 *
 *   stored = iv(12) || AES-256-GCM(frame) || tag(16)
 *   frame  = 00 5A 01 || raw DEFLATE (RFC 1951, level 6) of the SQLite file
 *
 * These are the bytes every reader already decodes (desktop `node:zlib`, Kodi `zlib`, web and older phones `fflate`,
 * `@space/library-db-definition/payloadCompression`). Reading also accepts a v1 copy (the SQLite file encrypted with
 * no frame) and writes it through unchanged.
 *
 * Pure JVM (no Android import) so `SnapshotCodecTest` runs it on the build host.
 */
object SnapshotCodec {
  const val IV_SIZE = 12
  private const val TAG_BITS = 128
  const val DEFLATE_LEVEL = 6
  private const val BUFFER_SIZE = 64 * 1024
  val FRAME_HEADER = byteArrayOf(0x00, 0x5A, 0x01)
  private const val FRAME_SENTINEL: Byte = 0x00
  private const val FRAME_MARKER: Byte = 0x5A

  data class Result(
    /** Bytes of the SQLite file (read when encrypting, written when decrypting). */
    val dbBytes: Long,
    /** Bytes of the encrypted file. */
    val storedBytes: Long,
    /** False only when a v1 (uncompressed) copy was read. */
    val compressed: Boolean,
  )

  /** `(stage, done, total)`, called at most every 5 % or once a second. */
  fun interface Progress {
    fun report(stage: String, done: Long, total: Long)
  }

  private fun keySpec(rawKey: ByteArray): SecretKeySpec {
    require(rawKey.size == 32) { "INVALID_KEY" }
    return SecretKeySpec(rawKey, "AES")
  }

  private class Throttle(private val stage: String, private val total: Long, private val progress: Progress) {
    private var lastPct = -1L
    private var lastAt = 0L

    fun tick(done: Long) {
      val pct = if (total <= 0) 0 else (done * 100) / total
      val now = System.currentTimeMillis()
      if (pct / 5 != lastPct / 5 || now - lastAt >= 1000) {
        lastPct = pct
        lastAt = now
        progress.report(stage, done, total)
      }
    }
  }

  /** Feeds a cipher; [finish] writes the tail and the GCM tag. `close` is a no-op so a wrapping stream cannot skip it. */
  private class CipherSink(private val cipher: Cipher, private val out: OutputStream) : OutputStream() {
    override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)

    override fun write(b: ByteArray, off: Int, len: Int) {
      val sealed = cipher.update(b, off, len)
      if (sealed != null && sealed.isNotEmpty()) out.write(sealed)
    }

    fun finish() {
      out.write(cipher.doFinal())
      out.flush()
    }

    override fun close() = Unit
  }

  /**
   * Passes bytes through to [out] and records where text slices of about [sliceBytes] end: each end is the first
   * position at or past the due size that starts a UTF-8 character (not a `10xxxxxx` continuation byte), so every
   * slice decodes on its own. Only the bytes at a due position are looked at.
   */
  internal class Utf8SliceSink(private val out: OutputStream, private val sliceBytes: Long) : OutputStream() {
    var written = 0L
      private set
    private var due = sliceBytes
    private val ends = ArrayList<Long>()

    override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)

    override fun write(b: ByteArray, off: Int, len: Int) {
      // A due position whose character continued past the last write is still being looked for: start at 0.
      var i = maxOf(due - written, 0L)
      while (i < len) {
        if ((b[off + i.toInt()].toInt() and 0xC0) != 0x80) {
          ends.add(written + i)
          due = written + i + sliceBytes
          i += sliceBytes
        } else {
          i++
        }
      }
      out.write(b, off, len)
      written += len
    }

    /** Every slice end, the last one being the whole length; empty for an empty payload. */
    fun sliceEnds(): LongArray = if (written == 0L) LongArray(0) else (ends + written).toLongArray()
  }

  data class OpenedPayload(
    /** Bytes of the change's JSON text. */
    val jsonBytes: Long,
    /** Exclusive end of each text slice of the file, each at a UTF-8 character start; the last is [jsonBytes]. */
    val sliceEnds: LongArray,
  )

  /**
   * SQLite file -> v2 stored copy at [target]. Writes `<target>.partial` and renames it, so a failure never leaves a
   * truncated copy where an upload would pick it up.
   */
  fun encrypt(source: File, rawKey: ByteArray, target: File, progress: Progress = Progress { _, _, _ -> }): Result {
    if (!source.exists()) throw IllegalArgumentException("SOURCE_MISSING")
    val key = keySpec(rawKey)
    val total = source.length()
    val iv = ByteArray(IV_SIZE).also { SecureRandom().nextBytes(it) }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
    target.parentFile?.mkdirs()
    val partial = File(target.path + ".partial")
    val throttle = Throttle("encrypt", total, progress)
    var read = 0L
    val deflater = Deflater(DEFLATE_LEVEL, true)
    try {
      FileOutputStream(partial).use { fileOut ->
        val out = BufferedOutputStream(fileOut, BUFFER_SIZE)
        out.write(iv)
        val sink = CipherSink(cipher, out)
        sink.write(FRAME_HEADER)
        val deflating = DeflaterOutputStream(sink, deflater, BUFFER_SIZE)
        FileInputStream(source).use { input ->
          val buffer = ByteArray(BUFFER_SIZE)
          throttle.tick(0)
          while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            if (n == 0) continue
            deflating.write(buffer, 0, n)
            read += n
            throttle.tick(read)
          }
        }
        deflating.finish()
        sink.finish()
        out.flush()
      }
      if (!partial.renameTo(target)) {
        target.delete()
        if (!partial.renameTo(target)) throw IOException("RENAME_FAILED")
      }
    } catch (error: Throwable) {
      partial.delete()
      throw error
    } finally {
      deflater.end()
    }
    progress.report("encrypt", total, total)
    return Result(dbBytes = read, storedBytes = target.length(), compressed = true)
  }

  /**
   * Stored copy at [source] (v2 framed or v1 plain) -> SQLite file at [target], through `<target>.partial`.
   * AES-GCM authenticates the whole ciphertext before any plaintext is released, so nothing is written for a wrong
   * key or a corrupt file. Throws `IllegalArgumentException("unknown_compression_codec:N")` for a frame codec this
   * build does not know and `IOException("corrupt_compressed_frame")` for a broken deflate stream.
   */
  fun decrypt(source: File, rawKey: ByteArray, target: File, progress: Progress = Progress { _, _, _ -> }): Result {
    if (!source.exists()) throw IllegalArgumentException("SOURCE_MISSING")
    val key = keySpec(rawKey)
    val total = source.length()
    val throttle = Throttle("decrypt", total, progress)
    val plain: ByteArray
    FileInputStream(source).use { input ->
      val iv = ByteArray(IV_SIZE)
      if (input.readNBytesCompat(iv) != IV_SIZE) throw IllegalArgumentException("INVALID_IV")
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
      val buffer = ByteArray(BUFFER_SIZE)
      var read = IV_SIZE.toLong()
      val early = java.io.ByteArrayOutputStream()
      throttle.tick(read)
      while (true) {
        val n = input.read(buffer)
        if (n < 0) break
        if (n == 0) continue
        cipher.update(buffer, 0, n)?.let { if (it.isNotEmpty()) early.write(it) }
        read += n
        throttle.tick(read)
      }
      val tail = cipher.doFinal()
      plain = if (early.size() == 0) tail else early.toByteArray() + tail
    }
    target.parentFile?.mkdirs()
    val partial = File(target.path + ".partial")
    val compressed = plain.size >= FRAME_HEADER.size && plain[0] == FRAME_SENTINEL && plain[1] == FRAME_MARKER
    var written = 0L
    try {
      FileOutputStream(partial).use { fileOut ->
        val out = BufferedOutputStream(fileOut, BUFFER_SIZE)
        if (compressed) {
          val codec = plain[2].toInt() and 0xff
          if (codec != FRAME_HEADER[2].toInt()) throw IllegalArgumentException("unknown_compression_codec:$codec")
          written = inflateInto(plain, FRAME_HEADER.size, out)
        } else {
          out.write(plain)
          written = plain.size.toLong()
        }
        out.flush()
      }
      if (!partial.renameTo(target)) {
        target.delete()
        if (!partial.renameTo(target)) throw IOException("RENAME_FAILED")
      }
    } catch (error: Throwable) {
      partial.delete()
      throw error
    }
    progress.report("decrypt", total, total)
    return Result(dbBytes = written, storedBytes = total, compressed = compressed)
  }

  /**
   * One library change as stored (LIB-FMT-07): `iv(12) || AES-256-GCM(frame or v1 plain JSON) || tag(16)` -> the
   * change's JSON text in [target], inflated straight to the file, plus where to cut it into slices of about
   * [sliceBytes] that each decode as UTF-8. A 3.5 MB stored change is ~56 MB of JSON (deflate packs repetitive JSON
   * ~16:1); as one Java String that is 113 MB of UTF-16, which threw OutOfMemoryError on a 256 MB heap. Throws
   * `IllegalArgumentException("INVALID_BLOB")` for a short envelope, the cipher's `AEADBadTagException` for a wrong
   * key, and the frame errors [decrypt] throws; [target] is deleted on any failure.
   */
  fun openPayloadToFile(envelope: ByteArray, rawKey: ByteArray, target: File, sliceBytes: Int): OpenedPayload {
    require(sliceBytes > 0) { "INVALID_SLICE" }
    try {
      target.parentFile?.mkdirs()
      return BufferedOutputStream(FileOutputStream(target), BUFFER_SIZE).use { file ->
        val sink = Utf8SliceSink(file, sliceBytes.toLong())
        openPayloadInto(envelope, rawKey, sink)
        OpenedPayload(jsonBytes = sink.written, sliceEnds = sink.sliceEnds())
      }
    } catch (error: Throwable) {
      target.delete()
      throw error
    }
  }

  /**
   * One stored change -> its JSON bytes streamed into [out] (the binary ops page, LibraryOpsPage, picks memory or a
   * file per op). Only the compressed plaintext is held whole; the inflated JSON never is. Returns the JSON length.
   * Throws as [openPayloadToFile].
   */
  fun openPayloadInto(envelope: ByteArray, rawKey: ByteArray, out: OutputStream): Long {
    if (envelope.size <= IV_SIZE + TAG_BITS / 8) throw IllegalArgumentException("INVALID_BLOB")
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, keySpec(rawKey), GCMParameterSpec(TAG_BITS, envelope, 0, IV_SIZE))
    val plain = cipher.doFinal(envelope, IV_SIZE, envelope.size - IV_SIZE)
    val framed = plain.size >= FRAME_HEADER.size && plain[0] == FRAME_SENTINEL && plain[1] == FRAME_MARKER
    if (!framed) {
      out.write(plain, 0, plain.size)
      return plain.size.toLong()
    }
    val codec = plain[2].toInt() and 0xff
    if (codec != FRAME_HEADER[2].toInt()) throw IllegalArgumentException("unknown_compression_codec:$codec")
    return inflateInto(plain, FRAME_HEADER.size, out)
  }

  private fun inflateInto(bytes: ByteArray, offset: Int, out: OutputStream): Long {
    val inflater = Inflater(true)
    try {
      inflater.setInput(bytes, offset, bytes.size - offset)
      val buffer = ByteArray(BUFFER_SIZE)
      var written = 0L
      var dummyFed = false
      while (!inflater.finished()) {
        val n = try {
          inflater.inflate(buffer)
        } catch (error: DataFormatException) {
          throw IOException("corrupt_compressed_frame", error)
        }
        if (n > 0) {
          out.write(buffer, 0, n)
          written += n
          continue
        }
        if (inflater.needsInput()) {
          // `nowrap` zlib may ask for one byte past the stream before it reports the end (java.util.zip.Inflater docs).
          if (dummyFed) throw IOException("corrupt_compressed_frame")
          dummyFed = true
          inflater.setInput(byteArrayOf(0))
        } else {
          // No output, no input wanted, not finished: a dictionary request or a stream that cannot progress.
          throw IOException("corrupt_compressed_frame")
        }
      }
      return written
    } finally {
      inflater.end()
    }
  }

  /** `InputStream.readNBytes` is API 33+; a short read only happens at end of file. */
  private fun java.io.InputStream.readNBytesCompat(into: ByteArray): Int {
    var filled = 0
    while (filled < into.size) {
      val n = read(into, filled, into.size - filled)
      if (n < 0) break
      filled += n
    }
    return filled
  }
}
