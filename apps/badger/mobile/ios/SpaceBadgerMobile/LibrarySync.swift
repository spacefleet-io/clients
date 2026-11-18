import CryptoKit
import Foundation
import React

/// iOS counterpart of the Android `LibrarySyncModule` (apps/badger/mobile/android/.../LibrarySyncModule.kt).
/// Same JS contract (`src/native/LibrarySync.ts`): library snapshot encrypt/decrypt, whole-file + per-chunk
/// SHA-256, and the storage-tunnel `upload.data` frame builder, all off the JS thread.
///
/// Wire format of an encrypted file is `iv(12) || ciphertext || tag(16)` (AES-256-GCM), which is exactly
/// CryptoKit's `AES.GCM.SealedBox.combined`. CryptoKit has no streaming GCM, so unlike Android the whole
/// file is processed in one shot (the input is memory-mapped; library snapshots are a few MB).
@objc(LibrarySync)
final class LibrarySync: RCTEventEmitter {
  /// Written on RN's observer thread, read from `run`'s background queue.
  private var hasListeners = false
  private let listenersLock = NSLock()

  private struct SyncError: LocalizedError {
    let code: String
    var errorDescription: String? { code }
  }

  override class func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! { ["librarySyncProgress"] }

  override func startObserving() {
    listenersLock.lock()
    hasListeners = true
    listenersLock.unlock()
  }

  override func stopObserving() {
    listenersLock.lock()
    hasListeners = false
    listenersLock.unlock()
  }

  private func emitProgress(_ stage: String, bytesRead: Int, totalBytes: Int) {
    listenersLock.lock()
    let listening = hasListeners
    listenersLock.unlock()
    guard listening else { return }
    let pct = totalBytes <= 0 ? 0.0 : Double(bytesRead) / Double(totalBytes) * 100.0
    sendEvent(
      withName: "librarySyncProgress",
      body: ["stage": stage, "bytesRead": bytesRead, "totalBytes": totalBytes, "pct": pct]
    )
  }

  private func run(
    _ failureCode: String,
    _ resolve: @escaping RCTPromiseResolveBlock,
    _ reject: @escaping RCTPromiseRejectBlock,
    _ work: @escaping () throws -> Any
  ) {
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        resolve(try work())
      } catch {
        NSLog("[LibrarySync] %@ failed: %@", failureCode, error.localizedDescription)
        reject(failureCode, error.localizedDescription, error)
      }
    }
  }

  private func key(from keyBase64: String) throws -> SymmetricKey {
    guard
      let raw = Data(base64Encoded: keyBase64.trimmingCharacters(in: .whitespacesAndNewlines)),
      raw.count == 32
    else { throw SyncError(code: "INVALID_KEY") }
    return SymmetricKey(data: raw)
  }

  private func readSource(_ path: String) throws -> Data {
    guard FileManager.default.fileExists(atPath: path) else { throw SyncError(code: "SOURCE_MISSING") }
    return try Data(contentsOf: URL(fileURLWithPath: path), options: .alwaysMapped)
  }

  private func writeOutput(_ data: Data, to path: String) throws {
    let url = URL(fileURLWithPath: path)
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: url, options: .atomic)
  }

  /// JS numbers arrive as Doubles; `Int(_:)` traps on NaN/infinite/out-of-range values.
  private func nonNegativeInt(_ value: Double) throws -> Int {
    guard value.isFinite, value >= 0, value < Double(Int.max) else { throw SyncError(code: "INVALID_ARGUMENT") }
    return Int(value)
  }

  private func decrypt(_ combined: Data, key: SymmetricKey) throws -> Data {
    guard combined.count >= 12 else { throw SyncError(code: "INVALID_IV") }
    return try AES.GCM.open(try AES.GCM.SealedBox(combined: combined), using: key)
  }

  @objc(decryptBase64File:keyBase64:outputPath:resolve:reject:)
  func decryptBase64File(
    _ sourcePath: String, keyBase64: String, outputPath: String,
    resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    run("DECRYPT_FAILED", resolve, reject) {
      let text = try self.readSource(sourcePath)
      let key = try self.key(from: keyBase64)
      guard let combined = Data(base64Encoded: text, options: .ignoreUnknownCharacters) else {
        throw SyncError(code: "INVALID_IV")
      }
      self.emitProgress("decrypt", bytesRead: 0, totalBytes: text.count)
      try self.writeOutput(try self.decrypt(combined, key: key), to: outputPath)
      self.emitProgress("decrypt", bytesRead: text.count, totalBytes: text.count)
      return true
    }
  }

  @objc(decryptBinaryFile:keyBase64:outputPath:resolve:reject:)
  func decryptBinaryFile(
    _ sourcePath: String, keyBase64: String, outputPath: String,
    resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    run("DECRYPT_FAILED", resolve, reject) {
      let combined = try self.readSource(sourcePath)
      let key = try self.key(from: keyBase64)
      self.emitProgress("decrypt", bytesRead: 0, totalBytes: combined.count)
      try self.writeOutput(try self.decrypt(combined, key: key), to: outputPath)
      self.emitProgress("decrypt", bytesRead: combined.count, totalBytes: combined.count)
      return true
    }
  }

  @objc(encryptBinaryFile:keyBase64:outputPath:resolve:reject:)
  func encryptBinaryFile(
    _ sourcePath: String, keyBase64: String, outputPath: String,
    resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    run("ENCRYPT_FAILED", resolve, reject) {
      let plain = try self.readSource(sourcePath)
      let key = try self.key(from: keyBase64)
      self.emitProgress("encrypt", bytesRead: 0, totalBytes: plain.count)
      guard let combined = try AES.GCM.seal(plain, using: key).combined else {
        throw SyncError(code: "ENCRYPT_FAILED")
      }
      try self.writeOutput(combined, to: outputPath)
      self.emitProgress("encrypt", bytesRead: plain.count, totalBytes: plain.count)
      return true
    }
  }

  private static func hex(_ digest: SHA256.Digest) -> String {
    digest.map { String(format: "%02x", $0) }.joined()
  }

  /// SHA-256 of a whole file plus, when `chunkSize > 0`, of every consecutive `chunkSize`-byte slice of it.
  @objc(sha256File:chunkSize:resolve:reject:)
  func sha256File(
    _ sourcePath: String, chunkSize: Double,
    resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    run("SHA256_FAILED", resolve, reject) {
      guard FileManager.default.fileExists(atPath: sourcePath) else { throw SyncError(code: "SOURCE_MISSING") }
      let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: sourcePath))
      defer { try? handle.close() }
      let chunkBytes = try self.nonNegativeInt(chunkSize)
      var whole = SHA256()
      var chunk = SHA256()
      var chunkFilled = 0
      var total = 0
      var chunks: [[String: Any]] = []
      let emitChunk = {
        chunks.append(["size": chunkFilled, "hash": LibrarySync.hex(chunk.finalize())])
        chunk = SHA256()
        chunkFilled = 0
      }
      while let buffer = try handle.read(upToCount: 64 * 1024), !buffer.isEmpty {
        whole.update(data: buffer)
        total += buffer.count
        if chunkBytes <= 0 { continue }
        var pos = 0
        while pos < buffer.count {
          let take = min(buffer.count - pos, chunkBytes - chunkFilled)
          chunk.update(data: buffer.subdata(in: pos..<(pos + take)))
          chunkFilled += take
          pos += take
          if chunkFilled == chunkBytes { emitChunk() }
        }
      }
      if chunkBytes > 0 && chunkFilled > 0 { emitChunk() }
      return ["size": total, "hash": LibrarySync.hex(whole.finalize()), "chunks": chunks]
    }
  }

  /// Builds one storage-tunnel `upload.data` frame ("SFV1" + u32 BE metadata length + metadata JSON +
  /// ciphertext) from a slice of a file and parks it in React Native's blob store, returning only the blob id.
  @objc(buildUploadFrameBlob:offset:length:uploadId:seq:resolve:reject:)
  func buildUploadFrameBlob(
    _ sourcePath: String, offset: Double, length: Double, uploadId: String, seq: Double,
    resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    run("UPLOAD_FRAME_FAILED", resolve, reject) {
      guard let blobModule = self.bridge?.module(forName: "BlobModule") as? NSObject,
        blobModule.responds(to: NSSelectorFromString("store:"))
      else { throw SyncError(code: "BLOB_MODULE_UNAVAILABLE") }
      let sliceLength = try self.nonNegativeInt(length)
      let sliceOffset = try self.nonNegativeInt(offset)
      let frameSeq = try self.nonNegativeInt(seq)
      let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: sourcePath))
      defer { try? handle.close() }
      try handle.seek(toOffset: UInt64(sliceOffset))
      guard let slice = try handle.read(upToCount: sliceLength), slice.count == sliceLength else {
        throw SyncError(code: "SHORT_READ")
      }
      let metadata = try JSONSerialization.data(withJSONObject: [
        "frame": [
          "kind": "upload.data",
          "uploadId": uploadId,
          "seq": frameSeq,
          "checksum": "sha256:" + LibrarySync.hex(SHA256.hash(data: slice)),
          "ciphertextLength": sliceLength,
        ] as [String: Any]
      ])
      var message = Data("SFV1".utf8)
      withUnsafeBytes(of: UInt32(metadata.count).bigEndian) { message.append(contentsOf: $0) }
      message.append(metadata)
      message.append(slice)
      guard
        let blobId = blobModule.perform(NSSelectorFromString("store:"), with: message)?
          .takeUnretainedValue() as? String
      else { throw SyncError(code: "BLOB_STORE_FAILED") }
      return ["blobId": blobId, "size": message.count]
    }
  }
}
