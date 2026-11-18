#if os(iOS)
import CryptoKit
import Foundation

/// App-private, content-addressed store of STILL-ENCRYPTED storage objects (SFV1 envelopes exactly as the
/// storage gateway returns them) used for offline playback. iOS counterpart of the Android `OfflineStore`
/// (packages/mobile-mpv-playback/.../downloads/OfflineStore.kt); the layout is identical so the offline
/// playback path can read objects the same way on both platforms.
///
/// Layout, under `Application Support/offline` (excluded from iCloud/iTunes backup):
///   objects/<sha256-hex(objectKey)>       one complete object
///   objects/<sha256-hex(objectKey)>.part  in-flight write (ignored, swept)
///   bodies/                                request bodies of in-flight background upload tasks
///   queue.json                             persisted queue (see `DownloadEngine`)
///   items/<sha256-hex(itemId)>.objects.json  per-item object list
///
/// Chunk-level resume falls out of the layout: an object either exists as a complete file (written to
/// `.part`, fsynced, atomically renamed) or it does not, so "what is left to download" is recomputed from disk.
final class OfflineStore {
  static let shared = OfflineStore()

  let rootDir: URL
  let objectsDir: URL
  let bodiesDir: URL
  let itemsDir: URL

  private init() {
    let fm = FileManager.default
    let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    let root = base.appendingPathComponent("offline", isDirectory: true)
    rootDir = root
    objectsDir = root.appendingPathComponent("objects", isDirectory: true)
    bodiesDir = root.appendingPathComponent("bodies", isDirectory: true)
    itemsDir = root.appendingPathComponent("items", isDirectory: true)
    for dir in [objectsDir, bodiesDir, itemsDir] {
      try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    var mutableRoot = root
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? mutableRoot.setResourceValues(values)
  }

  static func hashKey(_ key: String) -> String {
    SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  func fileURL(forKey key: String) -> URL {
    objectsDir.appendingPathComponent(Self.hashKey(key))
  }

  func partURL(forKey key: String) -> URL {
    objectsDir.appendingPathComponent(Self.hashKey(key) + ".part")
  }

  func bodyURL(named name: String) -> URL {
    bodiesDir.appendingPathComponent(name)
  }

  func objectsListURL(forItem id: String) -> URL {
    itemsDir.appendingPathComponent(Self.hashKey(id) + ".objects.json")
  }

  func has(_ key: String) -> Bool {
    var isDir: ObjCBool = false
    return FileManager.default.fileExists(atPath: fileURL(forKey: key).path, isDirectory: &isDir) && !isDir.boolValue
  }

  func sizeOf(_ key: String) -> Int64 {
    let attrs = try? FileManager.default.attributesOfItem(atPath: fileURL(forKey: key).path)
    return (attrs?[.size] as? NSNumber)?.int64Value ?? 0
  }

  func partSize(forKey key: String) -> Int64 {
    let attrs = try? FileManager.default.attributesOfItem(atPath: partURL(forKey: key).path)
    return (attrs?[.size] as? NSNumber)?.int64Value ?? 0
  }

  func read(_ key: String) throws -> Data {
    try Data(contentsOf: fileURL(forKey: key), options: .mappedIfSafe)
  }

  /// Fsyncs the `.part` file and atomically renames it over the final object path.
  func commitPart(forKey key: String) throws {
    let part = partURL(forKey: key)
    do {
      let handle = try FileHandle(forWritingTo: part)
      defer { try? handle.close() }
      try handle.synchronize()
    }
    if rename(part.path, fileURL(forKey: key).path) != 0 {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "offline_store_rename_failed: \(key)"])
    }
  }

  func removePart(forKey key: String) {
    try? FileManager.default.removeItem(at: partURL(forKey: key))
  }

  func delete(keys: [String]) {
    let fm = FileManager.default
    for key in keys {
      try? fm.removeItem(at: fileURL(forKey: key))
      try? fm.removeItem(at: partURL(forKey: key))
      try? fm.removeItem(at: bodyURL(named: Self.hashKey(key) + ".json"))
    }
  }

  /// Removes `.part` files that do not belong to a still-running transfer (process death mid-write).
  func sweepPartials(keeping liveKeys: Set<String>) {
    let live = Set(liveKeys.map { Self.hashKey($0) + ".part" })
    let names = (try? FileManager.default.contentsOfDirectory(atPath: objectsDir.path)) ?? []
    for name in names where name.hasSuffix(".part") && !live.contains(name) {
      try? FileManager.default.removeItem(at: objectsDir.appendingPathComponent(name))
    }
  }

  func wipeBodies() {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: bodiesDir.path)) ?? []
    for name in names { try? FileManager.default.removeItem(at: bodiesDir.appendingPathComponent(name)) }
  }

  /// Usable bytes on the volume that holds the store (what the system would let a user-initiated download use).
  func freeBytes() -> Int64 {
    let values = try? rootDir.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey, .volumeAvailableCapacityKey])
    if let important = values?.volumeAvailableCapacityForImportantUsage { return important }
    return Int64(values?.volumeAvailableCapacity ?? 0)
  }

  /// Streaming SHA-256 of a file as lowercase hex.
  static func sha256Hex(ofFile url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    while true {
      let block = try handle.read(upToCount: 1 << 20) ?? Data()
      if block.isEmpty { break }
      hasher.update(data: block)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }
}
#endif
