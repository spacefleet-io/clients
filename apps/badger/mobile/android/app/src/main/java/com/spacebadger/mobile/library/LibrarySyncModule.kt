package com.spacebadger.mobile.library

import android.app.ActivityManager
import android.content.Context
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeArray
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.blob.BlobModule
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import org.json.JSONObject
import java.io.FileInputStream
import java.security.MessageDigest
import kotlin.concurrent.thread

class LibrarySyncModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private var listenerCount = 0
  private val tag = "LibrarySync"

  override fun getName(): String = "LibrarySync"

  private val opPageDir: File get() = File(context.cacheDir, "library-op-pages")

  /**
   * No page is in flight when the module starts: every op page file written before now is an orphan of a killed or
   * crashed app (files of a page fetched while this sweep runs are newer, and stay).
   */
  override fun initialize() {
    super.initialize()
    val startedAt = System.currentTimeMillis()
    thread(name = "LibrarySyncOpPageSweep") {
      // 2 s margin: file times can be whole seconds.
      val removed = LibraryOpsPage.sweepStale(opPageDir, 2_000L, startedAt)
      Log.i(tag, "ops.page.sweep.startup removed=$removed")
    }
  }

  private fun emitProgress(stage: String, bytesRead: Long, totalBytes: Long) {
    val payload = WritableNativeMap().apply {
      putString("stage", stage)
      putDouble("bytesRead", bytesRead.toDouble())
      putDouble("totalBytes", totalBytes.toDouble())
      val pct = if (totalBytes <= 0) 0.0 else (bytesRead.toDouble() / totalBytes.toDouble()) * 100.0
      putDouble("pct", pct)
    }
    context
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("librarySyncProgress", payload)
  }

  private fun snapshotResult(result: SnapshotCodec.Result, startedAt: Long) = WritableNativeMap().apply {
    putDouble("dbBytes", result.dbBytes.toDouble())
    putDouble("storedBytes", result.storedBytes.toDouble())
    putBoolean("compressed", result.compressed)
    putDouble("ms", (System.currentTimeMillis() - startedAt).toDouble())
  }

  private fun snapshotProgress(event: String) = SnapshotCodec.Progress { stage, done, total ->
    emitProgress(stage, done, total)
    Log.i(tag, "$event.progress bytes=$done total=$total")
  }

  /**
   * SQLite file -> saved copy of the library (LIB-FMT-07 v2: compressed, then AES-256-GCM), in one streaming pass on
   * a worker thread (LIB-SYNC-14). The JS thread only waits on the promise.
   */
  @ReactMethod
  fun encryptSnapshotFile(dbPath: String, keyBase64: String, outputPath: String, promise: Promise) {
    thread(name = "LibrarySyncSnapshotEncrypt") {
      val startedAt = System.currentTimeMillis()
      try {
        Log.i(tag, "snapshot.encrypt.start db=$dbPath output=$outputPath")
        val rawKey = Base64.decode(keyBase64.trim(), Base64.DEFAULT)
        val result = SnapshotCodec.encrypt(File(dbPath), rawKey, File(outputPath), snapshotProgress("snapshot.encrypt"))
        Log.i(
          tag,
          "snapshot.encrypt.done dbBytes=${result.dbBytes} storedBytes=${result.storedBytes} ms=${System.currentTimeMillis() - startedAt}"
        )
        promise.resolve(snapshotResult(result, startedAt))
      } catch (error: Throwable) {
        Log.e(tag, "snapshot.encrypt.failed", error)
        promise.reject("ENCRYPT_FAILED", error.message ?: error.javaClass.simpleName, error)
      }
    }
  }

  /** Saved copy (v2 framed or v1 plain) -> SQLite file, decrypted and inflated in one pass on a worker thread. */
  @ReactMethod
  fun decryptSnapshotFile(sourcePath: String, keyBase64: String, dbPath: String, promise: Promise) {
    thread(name = "LibrarySyncSnapshotDecrypt") {
      val startedAt = System.currentTimeMillis()
      try {
        Log.i(tag, "snapshot.decrypt.start source=$sourcePath db=$dbPath")
        val rawKey = Base64.decode(keyBase64.trim(), Base64.DEFAULT)
        val result = SnapshotCodec.decrypt(File(sourcePath), rawKey, File(dbPath), snapshotProgress("snapshot.decrypt"))
        Log.i(
          tag,
          "snapshot.decrypt.done storedBytes=${result.storedBytes} dbBytes=${result.dbBytes} compressed=${result.compressed} ms=${System.currentTimeMillis() - startedAt}"
        )
        promise.resolve(snapshotResult(result, startedAt))
      } catch (error: Throwable) {
        Log.e(tag, "snapshot.decrypt.failed", error)
        promise.reject("DECRYPT_FAILED", error.message ?: error.javaClass.simpleName, error)
      }
    }
  }

  /**
   * One stored library change (base64 envelope) -> its JSON text in the file at [targetPath], opened on a worker thread
   * (LIB-SYNC-14), plus `sliceEnds`: where to cut the file into slices of about [sliceBytes] that each decode as UTF-8.
   * The text never becomes one Java String (a 3.5 MB change is a 113 MB String; OutOfMemoryError on a 256 MB heap):
   * JS reads it back with [readTextSlice]. Rejects with message `DECRYPT_FAILED` for a wrong key or a broken envelope,
   * and with the frame error (`corrupt_compressed_frame`, `unknown_compression_codec:N`) otherwise: the messages the JS
   * reader throws.
   */
  @ReactMethod
  fun openOpPayloadToFile(payloadBase64: String, keyBase64: String, targetPath: String, sliceBytes: Double, promise: Promise) {
    thread(name = "LibrarySyncOpOpen") {
      val startedAt = System.currentTimeMillis()
      try {
        val envelope = Base64.decode(payloadBase64, Base64.DEFAULT)
        val opened = try {
          SnapshotCodec.openPayloadToFile(
            envelope, Base64.decode(keyBase64.trim(), Base64.DEFAULT), File(targetPath), sliceBytes.toInt()
          )
        } catch (error: java.security.GeneralSecurityException) {
          throw IllegalStateException("DECRYPT_FAILED", error)
        }
        val ms = System.currentTimeMillis() - startedAt
        Log.i(tag, "op.open.done storedBytes=${envelope.size} jsonBytes=${opened.jsonBytes} slices=${opened.sliceEnds.size} ms=$ms")
        val ends = WritableNativeArray().apply { opened.sliceEnds.forEach { pushDouble(it.toDouble()) } }
        promise.resolve(
          WritableNativeMap().apply {
            putDouble("storedBytes", envelope.size.toDouble())
            putDouble("jsonBytes", opened.jsonBytes.toDouble())
            putArray("sliceEnds", ends)
            putDouble("ms", ms.toDouble())
          }
        )
      } catch (error: Throwable) {
        val message = if (error.message == "INVALID_BLOB" || error.message == "INVALID_KEY") "DECRYPT_FAILED" else error.message
        Log.e(tag, "op.open.failed message=$message", error)
        promise.reject("OPEN_FAILED", message ?: error.javaClass.simpleName, error)
      }
    }
  }

  /** Bytes [start, end) of a UTF-8 file as text, read on a worker thread: one slice from [openOpPayloadToFile]. */
  @ReactMethod
  fun readTextSlice(path: String, start: Double, end: Double, promise: Promise) {
    thread(name = "LibrarySyncTextSlice") {
      try {
        val from = start.toLong()
        val length = end.toLong() - from
        require(from >= 0 && length >= 0 && length <= Int.MAX_VALUE) { "INVALID_RANGE" }
        val bytes = ByteArray(length.toInt())
        RandomAccessFile(path, "r").use { file ->
          file.seek(from)
          file.readFully(bytes)
        }
        promise.resolve(String(bytes, Charsets.UTF_8))
      } catch (error: Throwable) {
        Log.e(tag, "text.slice.failed path=$path start=$start end=$end", error)
        promise.reject("READ_FAILED", error.message ?: error.javaClass.simpleName, error)
      }
    }
  }

  /**
   * One page of the binary op stream (vault v4 plan §1.7, LIB-SYNC-15): `{url, headers, keyBase64, fromVersion}` ->
   * `{version, snapshotVersion, hasMore, tooOld, storageFormatVersion, opStreamVersion, targetOpStreamVersion, ops,
   * bytes, ms}`, fetched, decrypted and inflated on a worker thread. Each op is `{version, jsonBytes, text}` or, when
   * large, `{version, jsonBytes, path, sliceEnds}` (read with [readTextSlice], then deleted by JS). Rejects `HTTP_<status>`
   * (message = body, e.g. the 426 `app_update_required`), `NETWORK_FAILED`, `BAD_FRAMES`, `INVALID_KEY`, `OPEN_FAILED`.
   */
  @ReactMethod
  fun fetchOpsPage(request: ReadableMap, promise: Promise) {
    thread(name = "LibrarySyncOpsPage") {
      val startedAt = System.currentTimeMillis()
      try {
        val url = request.getString("url") ?: throw LibraryOpsPage.Failure("BAD_REQUEST", "url missing")
        val fromVersion = request.getDouble("fromVersion").toLong()
        val headers = HashMap<String, String>()
        request.getMap("headers")?.toHashMap()?.forEach { (name, value) -> if (value != null) headers[name] = value.toString() }
        val rawKey = try {
          Base64.decode((request.getString("keyBase64") ?: "").trim(), Base64.DEFAULT)
        } catch (error: IllegalArgumentException) {
          throw LibraryOpsPage.Failure("INVALID_KEY", "INVALID_KEY", error)
        }
        val fileDir = opPageDir
        val swept = LibraryOpsPage.sweepStale(fileDir, 60 * 60 * 1000L)
        Log.i(tag, "ops.page.start since=$fromVersion swept=$swept")
        val page = LibraryOpsPage.fetch(url, headers, rawKey, fromVersion, fileDir) { Log.i(tag, it) }
        val ops = WritableNativeArray()
        var files = 0
        for (op in page.ops) {
          ops.pushMap(WritableNativeMap().apply {
            putDouble("version", op.version.toDouble())
            putDouble("jsonBytes", op.jsonBytes.toDouble())
            when (op) {
              is LibraryOpsPage.OpenedOp.Inline -> putString("text", op.text)
              is LibraryOpsPage.OpenedOp.InFile -> {
                files += 1
                putString("path", op.path)
                putArray("sliceEnds", WritableNativeArray().apply { op.sliceEnds.forEach { pushDouble(it.toDouble()) } })
              }
            }
          })
        }
        val ms = System.currentTimeMillis() - startedAt
        Log.i(tag, "ops.page.done since=$fromVersion version=${page.version} ops=${page.ops.size} files=$files bytes=${page.bodyBytes} ms=$ms")
        promise.resolve(WritableNativeMap().apply {
          putDouble("version", page.version.toDouble())
          putDouble("snapshotVersion", page.snapshotVersion.toDouble())
          putBoolean("hasMore", page.hasMore)
          putBoolean("tooOld", page.tooOld)
          putDouble("storageFormatVersion", page.storageFormatVersion.toDouble())
          putDouble("opStreamVersion", page.opStreamVersion.toDouble())
          val target = page.targetOpStreamVersion
          if (target == null) putNull("targetOpStreamVersion") else putDouble("targetOpStreamVersion", target.toDouble())
          putArray("ops", ops)
          putDouble("bytes", page.bodyBytes.toDouble())
          putDouble("ms", ms.toDouble())
        })
      } catch (error: LibraryOpsPage.Failure) {
        Log.e(tag, "ops.page.failed code=${error.code} message=${error.message?.take(300)}", error)
        promise.reject(error.code, error.message ?: error.code, error)
      } catch (error: Throwable) {
        Log.e(tag, "ops.page.failed code=OPS_PAGE_FAILED", error)
        promise.reject("OPS_PAGE_FAILED", error.message ?: error.javaClass.simpleName, error)
      }
    }
  }

  /**
   * One-time packing of the playback DB's chunk tables into `media_chunk_lists` (LIB-FMT-12), on a worker thread:
   * `{lists, rows, ms}`. JS runs it from the gated layout step with no transaction open on that file. Rejects
   * `NO_CHUNK_LISTS_TABLE` or `CONVERT_FAILED`; on either the file is unchanged.
   */
  @ReactMethod
  fun convertChunkLists(playbackDbPath: String, nowIso: String, promise: Promise) {
    thread(name = "LibrarySyncChunkLists") {
      try {
        Log.i(tag, "chunkLists.convert.start db=$playbackDbPath")
        val result = ChunkListConversion.convert(playbackDbPath, nowIso) { Log.i(tag, it) }
        promise.resolve(WritableNativeMap().apply {
          putInt("lists", result.lists)
          putDouble("rows", result.rows.toDouble())
          putDouble("ms", result.ms.toDouble())
        })
      } catch (error: ChunkListConversion.Failure) {
        Log.e(tag, "chunkLists.convert.failed code=${error.code}", error)
        promise.reject(error.code, error.message ?: error.code, error)
      } catch (error: Throwable) {
        Log.e(tag, "chunkLists.convert.failed code=CONVERT_FAILED", error)
        promise.reject("CONVERT_FAILED", error.message ?: error.javaClass.simpleName, error)
      }
    }
  }

  /**
   * SHA-256 of a whole file plus, when chunkSize > 0, of every consecutive chunkSize-byte slice of it
   * (the last one may be shorter). One streaming pass on a worker thread: the file never crosses the
   * bridge as base64, so the JS thread neither decodes megabytes of text nor copies the bytes to hash them.
   */
  @ReactMethod
  fun sha256File(sourcePath: String, chunkSize: Double, promise: Promise) {
    thread(name = "LibrarySyncSha256") {
      try {
        val inputFile = File(sourcePath)
        if (!inputFile.exists()) {
          throw IllegalArgumentException("SOURCE_MISSING")
        }
        val chunkBytes = chunkSize.toLong()
        val whole = MessageDigest.getInstance("SHA-256")
        val chunks = WritableNativeArray()
        val chunk = MessageDigest.getInstance("SHA-256")
        var chunkFilled = 0L
        var total = 0L
        val emitChunk = {
          chunks.pushMap(WritableNativeMap().apply {
            putDouble("size", chunkFilled.toDouble())
            putString("hash", chunk.digest().joinToString("") { "%02x".format(it) })
          })
          chunkFilled = 0L
        }
        FileInputStream(inputFile).use { input ->
          val buffer = ByteArray(64 * 1024)
          while (true) {
            val read = input.read(buffer)
            if (read <= 0) break
            whole.update(buffer, 0, read)
            total += read
            if (chunkBytes <= 0) continue
            var pos = 0
            while (pos < read) {
              val take = minOf((read - pos).toLong(), chunkBytes - chunkFilled).toInt()
              chunk.update(buffer, pos, take)
              chunkFilled += take
              pos += take
              if (chunkFilled == chunkBytes) emitChunk()
            }
          }
        }
        if (chunkBytes > 0 && chunkFilled > 0) emitChunk()
        promise.resolve(WritableNativeMap().apply {
          putDouble("size", total.toDouble())
          putString("hash", whole.digest().joinToString("") { "%02x".format(it) })
          putArray("chunks", chunks)
        })
      } catch (error: Exception) {
        Log.e(tag, "sha256.failed", error)
        promise.reject("SHA256_FAILED", error)
      }
    }
  }

  /**
   * Builds one storage-tunnel `upload.data` WebSocket frame ("SFV1" + u32 metadata length + metadata JSON +
   * ciphertext) from a slice of a file and parks it in React Native's BlobModule, returning only the blob id.
   * JS hands that blob to WebSocket.send, which sends it without base64: reading the slice, hashing it and
   * encoding it never touch the JS thread (in JS, decoding 64 KB took ~50 ms and sending 128 KB ~100 ms).
   */
  @ReactMethod
  fun buildUploadFrameBlob(
    sourcePath: String,
    offset: Double,
    length: Double,
    uploadId: String,
    seq: Double,
    promise: Promise
  ) {
    thread(name = "LibrarySyncUploadFrame") {
      try {
        val blobModule = context.getNativeModule(BlobModule::class.java)
          ?: throw IllegalStateException("BLOB_MODULE_UNAVAILABLE")
        val sliceLength = length.toInt()
        val slice = ByteArray(sliceLength)
        RandomAccessFile(sourcePath, "r").use { file ->
          file.seek(offset.toLong())
          file.readFully(slice)
        }
        val checksum = MessageDigest.getInstance("SHA-256").digest(slice).joinToString("") { "%02x".format(it) }
        val metadata = JSONObject()
          .put(
            "frame",
            JSONObject()
              .put("kind", "upload.data")
              .put("uploadId", uploadId)
              .put("seq", seq.toInt())
              .put("checksum", "sha256:$checksum")
              .put("ciphertextLength", sliceLength)
          )
          .toString()
          .toByteArray(Charsets.UTF_8)
        val message = ByteBuffer.allocate(8 + metadata.size + sliceLength)
        message.put("SFV1".toByteArray(Charsets.US_ASCII))
        message.putInt(metadata.size)
        message.put(metadata)
        message.put(slice)
        val blobId = blobModule.store(message.array())
        promise.resolve(WritableNativeMap().apply {
          putString("blobId", blobId)
          putInt("size", message.capacity())
        })
      } catch (error: Exception) {
        Log.e(tag, "uploadFrame.failed", error)
        promise.reject("UPLOAD_FRAME_FAILED", error)
      }
    }
  }

  /** `ActivityManager.isLowRamDevice()`: the phone's maker flagged it as memory-starved (UX-SKY-01 still sky). */
  @ReactMethod
  fun isLowRamDevice(promise: Promise) {
    try {
      val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      promise.resolve(manager.isLowRamDevice)
    } catch (error: Exception) {
      Log.e(tag, "isLowRamDevice.failed", error)
      promise.reject("LOW_RAM_QUERY_FAILED", error)
    }
  }

  @ReactMethod
  fun addListener(eventName: String) {
    listenerCount += 1
  }

  @ReactMethod
  fun removeListeners(count: Int) {
    listenerCount = maxOf(0, listenerCount - count)
  }
}
