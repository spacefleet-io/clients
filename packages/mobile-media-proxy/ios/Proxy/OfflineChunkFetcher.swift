import CryptoKit
import Foundation

/// Read-only view of the app's offline object store (`Application Support/offline/objects/<sha256-hex(objectKey)>`,
/// still-encrypted SFV1 envelopes). The writer is `OfflineStore` / `DownloadEngine` (ios/Downloads of this pod, iOS
/// only); this reader is compiled for tvOS too, where those are not, so the on-disk layout is the contract (identical
/// to Android's `OfflineStore`, which the Kotlin `OfflineChunkFetcher` reads the same way).
struct OfflineObjectReader {
  let objectsDir: URL

  init() {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    objectsDir = base.appendingPathComponent("offline", isDirectory: true).appendingPathComponent("objects", isDirectory: true)
  }

  private func fileURL(forKey key: String) -> URL {
    let name = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
    return objectsDir.appendingPathComponent(name)
  }

  func has(_ key: String) -> Bool {
    var isDir: ObjCBool = false
    return FileManager.default.fileExists(atPath: fileURL(forKey: key).path, isDirectory: &isDir) && !isDir.boolValue
  }

  /// Size of the stored object, or nil when it was not downloaded.
  func size(_ key: String) -> Int? {
    guard has(key) else { return nil }
    return ((try? FileManager.default.attributesOfItem(atPath: fileURL(forKey: key).path)[.size]) as? NSNumber)?.intValue
  }

  /// Complete object bytes, or nil when the object was not downloaded (`.part` files are never visible here: the
  /// download engine renames them over the final path only once verified).
  func read(_ key: String) -> Data? {
    guard has(key) else { return nil }
    return try? Data(contentsOf: fileURL(forKey: key), options: .mappedIfSafe)
  }

  /// A stream over the stored object, for decrypting it piece by piece (see `PlaintextSpool`).
  func stream(_ key: String) -> InputStream? {
    guard has(key) else { return nil }
    return InputStream(url: fileURL(forKey: key))
  }
}

/// `ChunkFetcher` that serves downloaded objects from the offline store and runs them through the same
/// `MediaCrypto` decrypt the tunnel client uses, so everything libmpv sees is identical online and offline (iOS twin
/// of the Kotlin `OfflineChunkFetcher`). Stored objects above `spoolThresholdBytes` (subtitle sidecars) are decrypted
/// file-to-file through `spool` instead of whole in memory.
///
/// Objects missing from the store go to `fallback` (the live tunnel client) when one is supplied; with no fallback
/// (`clientKind: "offline"`) a missing object is a hard error that the HTTP server turns into a 502.
final class OfflineChunkFetcher: ChunkFetcher {
  private let reader: OfflineObjectReader
  private let masterKey: SymmetricKey
  private let spool: PlaintextSpool
  private let fallback: ChunkFetcher?

  init(
    masterKey: SymmetricKey, spool: PlaintextSpool, fallback: ChunkFetcher? = nil,
    reader: OfflineObjectReader = OfflineObjectReader()
  ) {
    self.masterKey = masterKey
    self.spool = spool
    self.fallback = fallback
    self.reader = reader
  }

  func getObject(_ key: String) throws -> Data {
    if let storedBytes = reader.size(key), storedBytes > spoolThresholdBytes {
      if let spooled = spool.open(key) { return spooled }
      let start = DispatchTime.now().uptimeNanoseconds
      guard let input = reader.stream(key) else { throw TunnelError(message: "offline_object_unreadable: \(key)") }
      let plaintext = try spool.spool(key, masterKey: masterKey, input: input)
      let ms = (DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
      PlaybackLog.info("object.offline_spool key=\(key) storedBytes=\(storedBytes) plaintextBytes=\(plaintext.count) ms=\(ms)")
      return plaintext
    }
    if let encrypted = reader.read(key) {
      let start = DispatchTime.now().uptimeNanoseconds
      let plaintext = try MediaCrypto.decryptSegment(masterKey: masterKey, encrypted: encrypted)
      let ms = (DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
      PlaybackLog.info("object.offline_hit key=\(key) plaintextBytes=\(plaintext.count) ms=\(ms)")
      return plaintext
    }
    guard let network = fallback else { throw TunnelError(message: "offline_object_missing: \(key)") }
    PlaybackLog.info("object.offline_miss_fallback key=\(key)")
    return try network.getObject(key)
  }

  /// Stored objects are a cheap local read and this fetcher has no cache to warm: only forward misses to the live fetcher.
  func prefetch(_ key: String) throws {
    if !reader.has(key) { try fallback?.prefetch(key) }
  }

  func shutdown() {
    fallback?.shutdown()
    spool.clear()
  }
}
