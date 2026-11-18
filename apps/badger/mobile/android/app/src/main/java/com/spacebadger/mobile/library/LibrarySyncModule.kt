package com.spacebadger.mobile.library

import android.app.ActivityManager
import android.content.Context
import android.util.Base64
import android.util.Base64InputStream
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableNativeArray
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.blob.BlobModule
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.BufferedOutputStream
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import org.json.JSONObject
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
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

  @ReactMethod
  fun decryptBase64File(sourcePath: String, keyBase64: String, outputPath: String, promise: Promise) {
    thread(name = "LibrarySyncDecrypt") {
      try {
        Log.i(tag, "decrypt.start source=$sourcePath output=$outputPath")
        val inputFile = File(sourcePath)
        if (!inputFile.exists()) {
          throw IllegalArgumentException("SOURCE_MISSING")
        }
        val totalSize = inputFile.length()
        val rawKey = Base64.decode(keyBase64.trim(), Base64.DEFAULT)
        if (rawKey.size != 32) {
          throw IllegalArgumentException("INVALID_KEY")
        }
        val keySpec = SecretKeySpec(rawKey, "AES")

        FileInputStream(inputFile).use { fileStream ->
          val countingStream = CountingInputStream(fileStream)
          val base64Stream = Base64InputStream(countingStream, Base64.DEFAULT)

          val iv = ByteArray(12)
          val ivRead = base64Stream.read(iv)
          if (ivRead != iv.size) {
            throw IllegalArgumentException("INVALID_IV")
          }
          Log.i(tag, "decrypt.iv_read bytes=${countingStream.bytesRead} total=$totalSize")

          val cipher = Cipher.getInstance("AES/GCM/NoPadding")
          val gcmSpec = GCMParameterSpec(128, iv)
          cipher.init(Cipher.DECRYPT_MODE, keySpec, gcmSpec)

          val outputFile = File(outputPath)
          outputFile.parentFile?.mkdirs()
          FileOutputStream(outputFile).use { outputStream ->
            BufferedOutputStream(outputStream).use { bufferedOut ->
              val buffer = ByteArray(64 * 1024)
              emitProgress("decrypt", 0, totalSize)
              var lastPct = -1
              var lastEmit = System.currentTimeMillis()
              while (true) {
                val read = base64Stream.read(buffer)
                if (read <= 0) break
                val decoded = cipher.update(buffer, 0, read)
                if (decoded != null && decoded.isNotEmpty()) {
                  bufferedOut.write(decoded)
                }
                val pct = if (totalSize <= 0) 0 else ((countingStream.bytesRead * 100) / totalSize).toInt()
                val now = System.currentTimeMillis()
                if ((pct != lastPct && pct % 5 == 0) || now - lastEmit >= 1000) {
                  lastPct = pct
                  lastEmit = now
                  emitProgress("decrypt", countingStream.bytesRead, totalSize)
                  Log.i(tag, "decrypt.progress bytes=${countingStream.bytesRead} total=$totalSize pct=$pct")
                }
              }
              val finalBytes = cipher.doFinal()
              if (finalBytes.isNotEmpty()) {
                bufferedOut.write(finalBytes)
              }
              emitProgress("decrypt", totalSize, totalSize)
            }
          }
        }

        Log.i(tag, "decrypt.done bytes=$totalSize")
        promise.resolve(true)
      } catch (error: Exception) {
        Log.e(tag, "decrypt.failed", error)
        promise.reject("DECRYPT_FAILED", error)
      }
    }
  }

  @ReactMethod
  fun decryptBinaryFile(sourcePath: String, keyBase64: String, outputPath: String, promise: Promise) {
    thread(name = "LibrarySyncDecryptBinary") {
      try {
        Log.i(tag, "decrypt.binary.start source=$sourcePath output=$outputPath")
        val inputFile = File(sourcePath)
        if (!inputFile.exists()) {
          throw IllegalArgumentException("SOURCE_MISSING")
        }
        val totalSize = inputFile.length()
        val rawKey = Base64.decode(keyBase64.trim(), Base64.DEFAULT)
        if (rawKey.size != 32) {
          throw IllegalArgumentException("INVALID_KEY")
        }
        val keySpec = SecretKeySpec(rawKey, "AES")

        FileInputStream(inputFile).use { fileStream ->
          val countingStream = CountingInputStream(fileStream)
          val iv = ByteArray(12)
          val ivRead = countingStream.read(iv)
          if (ivRead != iv.size) {
            throw IllegalArgumentException("INVALID_IV")
          }
          Log.i(tag, "decrypt.binary.iv_read bytes=${countingStream.bytesRead} total=$totalSize")

          val cipher = Cipher.getInstance("AES/GCM/NoPadding")
          val gcmSpec = GCMParameterSpec(128, iv)
          cipher.init(Cipher.DECRYPT_MODE, keySpec, gcmSpec)

          val outputFile = File(outputPath)
          outputFile.parentFile?.mkdirs()
          FileOutputStream(outputFile).use { outputStream ->
            BufferedOutputStream(outputStream).use { bufferedOut ->
              val buffer = ByteArray(64 * 1024)
              emitProgress("decrypt", 0, totalSize)
              var lastPct = -1
              var lastEmit = System.currentTimeMillis()
              while (true) {
                val read = countingStream.read(buffer)
                if (read <= 0) break
                val decoded = cipher.update(buffer, 0, read)
                if (decoded != null && decoded.isNotEmpty()) {
                  bufferedOut.write(decoded)
                }
                val pct = if (totalSize <= 0) 0 else ((countingStream.bytesRead * 100) / totalSize).toInt()
                val now = System.currentTimeMillis()
                if ((pct != lastPct && pct % 5 == 0) || now - lastEmit >= 1000) {
                  lastPct = pct
                  lastEmit = now
                  emitProgress("decrypt", countingStream.bytesRead, totalSize)
                  Log.i(tag, "decrypt.binary.progress bytes=${countingStream.bytesRead} total=$totalSize pct=$pct")
                }
              }
              val finalBytes = cipher.doFinal()
              if (finalBytes.isNotEmpty()) {
                bufferedOut.write(finalBytes)
              }
              emitProgress("decrypt", totalSize, totalSize)
            }
          }
        }

        Log.i(tag, "decrypt.binary.done bytes=$totalSize")
        promise.resolve(true)
      } catch (error: Exception) {
        Log.e(tag, "decrypt.binary.failed", error)
        promise.reject("DECRYPT_FAILED", error)
      }
    }
  }

  @ReactMethod
  fun encryptBinaryFile(sourcePath: String, keyBase64: String, outputPath: String, promise: Promise) {
    thread(name = "LibrarySyncEncryptBinary") {
      try {
        Log.i(tag, "encrypt.binary.start source=$sourcePath output=$outputPath")
        val inputFile = File(sourcePath)
        if (!inputFile.exists()) {
          throw IllegalArgumentException("SOURCE_MISSING")
        }
        val totalSize = inputFile.length()
        val rawKey = Base64.decode(keyBase64.trim(), Base64.DEFAULT)
        if (rawKey.size != 32) {
          throw IllegalArgumentException("INVALID_KEY")
        }
        val keySpec = SecretKeySpec(rawKey, "AES")
        val iv = ByteArray(12)
        SecureRandom().nextBytes(iv)

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        val gcmSpec = GCMParameterSpec(128, iv)
        cipher.init(Cipher.ENCRYPT_MODE, keySpec, gcmSpec)

        val outputFile = File(outputPath)
        outputFile.parentFile?.mkdirs()
        FileInputStream(inputFile).use { inputStream ->
          FileOutputStream(outputFile).use { outputStream ->
            BufferedOutputStream(outputStream).use { bufferedOut ->
              bufferedOut.write(iv)
              val buffer = ByteArray(64 * 1024)
              var bytesRead = 0L
              emitProgress("encrypt", 0, totalSize)
              var lastPct = -1
              var lastEmit = System.currentTimeMillis()
              while (true) {
                val read = inputStream.read(buffer)
                if (read <= 0) break
                bytesRead += read
                val encrypted = cipher.update(buffer, 0, read)
                if (encrypted != null && encrypted.isNotEmpty()) {
                  bufferedOut.write(encrypted)
                }
                val pct = if (totalSize <= 0) 0 else ((bytesRead * 100) / totalSize).toInt()
                val now = System.currentTimeMillis()
                if ((pct != lastPct && pct % 5 == 0) || now - lastEmit >= 1000) {
                  lastPct = pct
                  lastEmit = now
                  emitProgress("encrypt", bytesRead, totalSize)
                  Log.i(tag, "encrypt.binary.progress bytes=$bytesRead total=$totalSize pct=$pct")
                }
              }
              val finalBytes = cipher.doFinal()
              if (finalBytes.isNotEmpty()) {
                bufferedOut.write(finalBytes)
              }
              emitProgress("encrypt", totalSize, totalSize)
            }
          }
        }

        Log.i(tag, "encrypt.binary.done bytes=$totalSize")
        promise.resolve(true)
      } catch (error: Exception) {
        Log.e(tag, "encrypt.binary.failed", error)
        promise.reject("ENCRYPT_FAILED", error)
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
