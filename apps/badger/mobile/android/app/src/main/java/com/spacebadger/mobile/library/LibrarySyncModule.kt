package com.spacebadger.mobile.library

import android.app.ActivityManager
import android.content.Context
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
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
   * One stored library change (base64 envelope) -> its JSON text, opened on a worker thread (LIB-SYNC-14). Rejects
   * with message `DECRYPT_FAILED` for a wrong key or a broken envelope, and with the frame error
   * (`corrupt_compressed_frame`, `unknown_compression_codec:N`) otherwise: the messages the JS reader throws.
   */
  @ReactMethod
  fun openOpPayload(payloadBase64: String, keyBase64: String, promise: Promise) {
    thread(name = "LibrarySyncOpOpen") {
      val startedAt = System.currentTimeMillis()
      val envelope: ByteArray
      val plain: ByteArray
      try {
        envelope = Base64.decode(payloadBase64, Base64.DEFAULT)
        plain = try {
          SnapshotCodec.openPayload(envelope, Base64.decode(keyBase64.trim(), Base64.DEFAULT))
        } catch (error: java.security.GeneralSecurityException) {
          throw IllegalStateException("DECRYPT_FAILED", error)
        }
      } catch (error: Throwable) {
        val message = if (error.message == "INVALID_BLOB" || error.message == "INVALID_KEY") "DECRYPT_FAILED" else error.message
        Log.e(tag, "op.open.failed message=$message", error)
        promise.reject("OPEN_FAILED", message ?: error.javaClass.simpleName, error)
        return@thread
      }
      Log.i(tag, "op.open.done storedBytes=${envelope.size} jsonBytes=${plain.size} ms=${System.currentTimeMillis() - startedAt}")
      promise.resolve(String(plain, Charsets.UTF_8))
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
