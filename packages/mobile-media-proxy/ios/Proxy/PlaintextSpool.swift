import CryptoKit
import Foundation

/// Above this size an object is decrypted through `PlaintextSpool` instead of in memory, and never enters the
/// segment LRU (twin of the Kotlin `ChunkFetcher.SPOOL_THRESHOLD_BYTES`).
let spoolThresholdBytes = 8 * 1024 * 1024

/// Disk-backed cache of decrypted objects too large for the in-memory segment LRU (subtitle sidecars: LOTR's PGS track
/// is 29.5 MB). `MediaCrypto.decryptStream` writes each one to a file under the caches directory piece by piece, and
/// the fetcher hands out a memory-mapped view: clean file-backed pages the system can drop, not dirty heap (twin of
/// the Kotlin `PlaintextSpool`). Wiped when the proxy starts and stops.
final class PlaintextSpool {
  private struct Entry {
    let url: URL
    let offset: Int
    let length: Int
    let fileBytes: Int
  }

  private static let maxDiskBytes = 256 * 1024 * 1024

  private let dir: URL
  private let lock = NSLock()
  private var entries: [String: Entry] = [:]
  private var order: [String] = []  // least recently used first
  private var diskBytes = 0

  init(dir: URL) {
    self.dir = dir
    // A killed process leaves its spool behind; nothing in it is reusable without the index.
    try? FileManager.default.removeItem(at: dir)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  }

  /// The spooled object for `key`, or nil when it is not (or no longer) on disk.
  func open(_ key: String) -> Data? {
    lock.lock()
    defer { lock.unlock() }
    guard let entry = entries[key] else { return nil }
    touchLocked(key)
    return try? Self.map(entry)
  }

  /// Decrypts `input` (an SFV1 envelope, or plaintext passed through) to disk as `key` and maps it.
  func spool(_ key: String, masterKey: SymmetricKey, input: InputStream) throws -> Data {
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let start = DispatchTime.now().uptimeNanoseconds
    let url = dir.appendingPathComponent("object-\(UUID().uuidString).plain")
    guard let output = OutputStream(url: url, append: false) else {
      throw MediaCryptoError.stream("spool_open_failed")
    }
    input.open()
    output.open()
    let payload: (offset: Int, length: Int)
    do {
      payload = try MediaCrypto.decryptStream(masterKey: masterKey, input: input, output: output)
      input.close()
      output.close()
    } catch {
      input.close()
      output.close()
      try? FileManager.default.removeItem(at: url)
      throw error
    }
    let fileBytes = ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.intValue ?? 0
    let entry = Entry(url: url, offset: payload.offset, length: payload.length, fileBytes: fileBytes)
    let ms = (DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
    PlaybackLog.info("spool.write key=\(key) plaintextBytes=\(payload.length) fileBytes=\(fileBytes) ms=\(ms)")

    lock.lock()
    defer { lock.unlock() }
    if let old = entries.removeValue(forKey: key) { dropLocked(key, old, reason: "replaced") }
    entries[key] = entry
    order.append(key)
    diskBytes += fileBytes
    while diskBytes > Self.maxDiskBytes, let oldest = order.first(where: { $0 != key }), let old = entries[oldest] {
      entries[oldest] = nil
      dropLocked(oldest, old, reason: "evict")
    }
    return try Self.map(entry)
  }

  /// Deletes every spooled file (proxy shutdown). Data already handed out stays valid: a mapping outlives the unlink.
  func clear() {
    lock.lock()
    defer { lock.unlock() }
    entries.removeAll()
    order.removeAll()
    diskBytes = 0
    try? FileManager.default.removeItem(at: dir)
  }

  // MARK: private (caller holds lock)

  private func touchLocked(_ key: String) {
    if let i = order.firstIndex(of: key) { order.remove(at: i) }
    order.append(key)
  }

  private func dropLocked(_ key: String, _ entry: Entry, reason: String) {
    if let i = order.firstIndex(of: key) { order.remove(at: i) }
    diskBytes -= entry.fileBytes
    try? FileManager.default.removeItem(at: entry.url)
    PlaybackLog.debug("spool.\(reason) key=\(key) diskBytes=\(diskBytes)")
  }

  /// The media bytes of `entry` as a zero-based Data over a read-only mapping of the file (no heap copy).
  private static func map(_ entry: Entry) throws -> Data {
    let mapped = try NSData(contentsOf: entry.url, options: .alwaysMapped)
    guard entry.length > 0 else { return Data() }
    let base = UnsafeMutableRawPointer(mutating: mapped.bytes).advanced(by: entry.offset)
    return Data(bytesNoCopy: base, count: entry.length, deallocator: .custom { _, _ in withExtendedLifetime(mapped) {} })
  }
}
