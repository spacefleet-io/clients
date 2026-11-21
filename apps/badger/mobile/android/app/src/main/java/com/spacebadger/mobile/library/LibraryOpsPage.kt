package com.spacebadger.mobile.library

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.EOFException
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

/**
 * One page of the library op stream, fetched and opened off the JS thread (vault v4 plan §1.7, LIB-SYNC-15):
 * `GET /library/db/ops?since=N` with `Accept: application/vnd.space.library-ops` answers repeated frames
 * `u64be version | u32be length | envelope` (the envelope is the exact stored change, LIB-FMT-07) and the page state
 * in `x-library-*` headers. Each frame is opened (AES-GCM, then the v2 deflate frame or v1 plain JSON) as it is read:
 * the body is never held whole, and no op becomes one big Java String. A small op's JSON comes back as `text`; a large
 * one (or once the page's inline budget is spent) is written to a cache file with UTF-8 slice ends, read by JS
 * slice by slice (`readTextSlice`) like `openOpPayloadToFile`. The 256 MB heap of a OnePlus 6 is the design target:
 * a 3.5 MB stored op is ~56 MB of JSON, 113 MB as one String.
 */
object LibraryOpsPage {
  const val CONTENT_TYPE = "application/vnd.space.library-ops"

  /** An op whose JSON is at most this long comes back inline as `text`. */
  const val INLINE_OP_MAX_BYTES = 256 * 1024

  /** Inline JSON across one page stops here; later ops go to files. Bounds the strings one bridge call carries. */
  const val INLINE_PAGE_MAX_BYTES = 4 * 1024 * 1024

  /** Same slice as `OP_TEXT_SLICE_BYTES` in JS: no single String read from a file is over ~2 MB. */
  const val SLICE_BYTES = 2 * 1024 * 1024

  /** The API caps an op at 1 MiB of ciphertext (vault v4 plan §1.1); old v3 ops reach a few MB. Larger = garbage. */
  const val MAX_FRAME_BYTES = 64 * 1024 * 1024

  private const val ERROR_BODY_MAX_BYTES = 64 * 1024
  private const val CONNECT_TIMEOUT_MS = 15_000
  private const val READ_TIMEOUT_MS = 60_000

  /** A page call that fails; [code] is the promise rejection code JS switches on. */
  class Failure(val code: String, message: String, cause: Throwable? = null) : Exception(message, cause)

  sealed class OpenedOp {
    abstract val version: Long
    abstract val jsonBytes: Long

    class Inline(override val version: Long, override val jsonBytes: Long, val text: String) : OpenedOp()

    class InFile(override val version: Long, override val jsonBytes: Long, val path: String, val sliceEnds: LongArray) : OpenedOp()
  }

  class Page(
    val version: Long,
    val snapshotVersion: Long,
    val hasMore: Boolean,
    val tooOld: Boolean,
    val storageFormatVersion: Long,
    val opStreamVersion: Long,
    val targetOpStreamVersion: Long?,
    val ops: List<OpenedOp>,
    val bodyBytes: Long
  )

  fun interface Log {
    fun info(event: String)
  }

  /** `url` with `since=<fromVersion>` added. */
  fun pageUrl(url: String, fromVersion: Long): String = url + (if (url.contains('?')) "&" else "?") + "since=$fromVersion"

  fun fetch(
    url: String,
    headers: Map<String, String>,
    rawKey: ByteArray,
    fromVersion: Long,
    fileDir: File,
    log: Log = Log { }
  ): Page {
    if (rawKey.size != 32) throw Failure("INVALID_KEY", "INVALID_KEY")
    val target = pageUrl(url, fromVersion)
    val connection = try {
      (URL(target).openConnection() as HttpURLConnection).apply {
        requestMethod = "GET"
        connectTimeout = CONNECT_TIMEOUT_MS
        readTimeout = READ_TIMEOUT_MS
        instanceFollowRedirects = false
        for ((name, value) in headers) {
          if (!name.equals("accept", ignoreCase = true)) setRequestProperty(name, value)
        }
        setRequestProperty("Accept", CONTENT_TYPE)
      }
    } catch (error: IOException) {
      throw Failure("NETWORK_FAILED", error.message ?: "NETWORK_FAILED", error)
    }
    try {
      val status = try {
        connection.responseCode
      } catch (error: IOException) {
        throw Failure("NETWORK_FAILED", error.message ?: "NETWORK_FAILED", error)
      }
      if (status !in 200..299) {
        val body = connection.errorStream?.use { readCapped(it, ERROR_BODY_MAX_BYTES) } ?: ""
        log.info("ops.page.http status=$status since=$fromVersion body=${body.take(200)}")
        throw Failure("HTTP_$status", body)
      }
      val contentType = connection.contentType ?: ""
      if (!contentType.startsWith(CONTENT_TYPE)) {
        throw Failure("BAD_FRAMES", "unexpected content-type: $contentType")
      }
      fun header(name: String): String? = connection.getHeaderField(name)
      fun required(name: String): Long =
        header(name)?.trim()?.toLongOrNull() ?: throw Failure("BAD_FRAMES", "missing or bad header $name: ${header(name)}")
      fun flag(name: String): Boolean = when (header(name)?.trim()) {
        "1" -> true
        "0", null -> false
        else -> throw Failure("BAD_FRAMES", "bad header $name: ${header(name)}")
      }
      val version = required("x-library-version")
      val snapshotVersion = required("x-library-snapshot-version")
      val tooOld = flag("x-library-too-old")
      val hasMore = flag("x-library-has-more")
      val storageFormatVersion = required("x-library-storage-format-version")
      val opStreamVersion = required("x-library-op-stream-version")
      val targetOpStreamVersion = header("x-library-target-op-stream-version")?.trim()?.toLongOrNull()
      log.info(
        "ops.page.headers since=$fromVersion version=$version snapshotVersion=$snapshotVersion hasMore=$hasMore " +
          "tooOld=$tooOld storageFormat=$storageFormatVersion opStream=$opStreamVersion target=$targetOpStreamVersion"
      )
      val body = try {
        connection.inputStream
      } catch (error: IOException) {
        throw Failure("NETWORK_FAILED", error.message ?: "NETWORK_FAILED", error)
      }
      val (ops, bodyBytes) = body.use { readFrames(it, rawKey, fileDir, log) }
      return Page(version, snapshotVersion, hasMore, tooOld, storageFormatVersion, opStreamVersion, targetOpStreamVersion, ops, bodyBytes)
    } finally {
      connection.disconnect()
    }
  }

  /**
   * Reads frames to the end of [body], opening each as it arrives. On any failure, deletes the files it wrote and
   * throws a [Failure]: `BAD_FRAMES` (truncated or oversized frame), `NETWORK_FAILED` (read error), `OPEN_FAILED`
   * (message `DECRYPT_FAILED`, `corrupt_compressed_frame` or `unknown_compression_codec:N`, as openOpPayload).
   */
  fun readFrames(body: InputStream, rawKey: ByteArray, fileDir: File, log: Log = Log { }): Pair<List<OpenedOp>, Long> {
    val ops = ArrayList<OpenedOp>()
    val input = DataInputStream(BufferedInputStream(body, 64 * 1024))
    var bodyBytes = 0L
    var inlineBytes = 0L
    try {
      while (true) {
        val first = try {
          input.read()
        } catch (error: IOException) {
          throw Failure("NETWORK_FAILED", error.message ?: "NETWORK_FAILED", error)
        }
        if (first < 0) break
        val envelope: ByteArray
        val version: Long
        try {
          version = (first.toLong() shl 56) or (readUnsigned(input, 7))
          val length = input.readInt().toLong() and 0xffffffffL
          if (version < 0) throw Failure("BAD_FRAMES", "frame ${ops.size}: version out of range")
          if (length > MAX_FRAME_BYTES) throw Failure("BAD_FRAMES", "frame ${ops.size}: length $length over $MAX_FRAME_BYTES")
          envelope = ByteArray(length.toInt())
          input.readFully(envelope)
          bodyBytes += 12 + length
        } catch (error: EOFException) {
          throw Failure("BAD_FRAMES", "frame ${ops.size}: body ends inside a frame", error)
        } catch (error: Failure) {
          throw error
        } catch (error: IOException) {
          throw Failure("NETWORK_FAILED", error.message ?: "NETWORK_FAILED", error)
        }
        val startedAt = System.currentTimeMillis()
        val inlineLimit = minOf(INLINE_OP_MAX_BYTES.toLong(), INLINE_PAGE_MAX_BYTES - inlineBytes)
        val sink = SpillSink(inlineLimit) { File(fileDir, "${UUID.randomUUID()}.json") }
        try {
          sink.use { SnapshotCodec.openPayloadInto(envelope, rawKey, it) }
        } catch (error: Throwable) {
          sink.discard()
          val message = when {
            error is java.security.GeneralSecurityException -> "DECRYPT_FAILED"
            error.message == "INVALID_BLOB" || error.message == "INVALID_KEY" -> "DECRYPT_FAILED"
            else -> error.message ?: error.javaClass.simpleName
          }
          throw Failure("OPEN_FAILED", message, error)
        }
        val op = sink.result(version)
        if (op is OpenedOp.Inline) inlineBytes += sink.written
        log.info(
          "ops.page.frame index=${ops.size} version=$version storedBytes=${envelope.size} jsonBytes=${sink.written} " +
            "inline=${op is OpenedOp.Inline} ms=${System.currentTimeMillis() - startedAt}"
        )
        ops.add(op)
      }
    } catch (error: Throwable) {
      for (op in ops) if (op is OpenedOp.InFile) File(op.path).delete()
      throw error
    }
    return ops to bodyBytes
  }

  private fun readUnsigned(input: DataInputStream, bytes: Int): Long {
    var value = 0L
    repeat(bytes) { value = (value shl 8) or input.readUnsignedByte().toLong() }
    return value
  }

  private fun readCapped(input: InputStream, max: Int): String {
    val out = ByteArrayOutputStream()
    val buffer = ByteArray(8 * 1024)
    while (out.size() < max) {
      val n = input.read(buffer, 0, minOf(buffer.size, max - out.size()))
      if (n < 0) break
      out.write(buffer, 0, n)
    }
    return out.toString("UTF-8")
  }

  /** Deletes page files older than [maxAgeMs]: left behind when the app died between a page and its reading. */
  fun sweepStale(fileDir: File, maxAgeMs: Long, now: Long = System.currentTimeMillis()): Int {
    var removed = 0
    fileDir.listFiles()?.forEach { if (now - it.lastModified() > maxAgeMs && it.delete()) removed += 1 }
    return removed
  }

  /**
   * Keeps an op's JSON in memory up to [inlineLimit] bytes; past it, moves to a file (through
   * [SnapshotCodec.Utf8SliceSink], which records the slice ends) and streams the rest there.
   */
  private class SpillSink(private val inlineLimit: Long, private val newFile: () -> File) : OutputStream() {
    private var memory: ByteArrayOutputStream? = ByteArrayOutputStream(minOf(inlineLimit, 64L * 1024).toInt().coerceAtLeast(32))
    private var file: File? = null
    private var fileOut: OutputStream? = null
    private var slices: SnapshotCodec.Utf8SliceSink? = null
    var written = 0L
      private set

    override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)

    override fun write(b: ByteArray, off: Int, len: Int) {
      val mem = memory
      if (mem != null && written + len <= inlineLimit) {
        mem.write(b, off, len)
      } else {
        if (mem != null) spill(mem)
        slices!!.write(b, off, len)
      }
      written += len
    }

    private fun spill(mem: ByteArrayOutputStream) {
      val target = newFile()
      target.parentFile?.mkdirs()
      file = target
      val out = BufferedOutputStream(FileOutputStream(target), 64 * 1024)
      fileOut = out
      val sink = SnapshotCodec.Utf8SliceSink(out, SLICE_BYTES.toLong())
      slices = sink
      mem.writeTo(sink)
      memory = null
    }

    override fun close() {
      fileOut?.close()
    }

    fun discard() {
      try {
        fileOut?.close()
      } catch (_: IOException) {
      }
      file?.delete()
    }

    fun result(version: Long): OpenedOp {
      val mem = memory
      if (mem != null) return OpenedOp.Inline(version, written, mem.toString("UTF-8"))
      return OpenedOp.InFile(version, written, file!!.absolutePath, slices!!.sliceEnds())
    }
  }
}
