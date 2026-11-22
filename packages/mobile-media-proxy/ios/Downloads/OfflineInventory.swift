#if os(iOS)
import Foundation

/// One complete download as Settings › "Manage offline content" lists it (OFFL-MANAGE-01). Twin of the Android
/// `OfflineInventoryItem` (android/.../downloads/OfflineInventory.kt): same fields, same JSON.
struct OfflineInventoryItem: Equatable {
  let itemId: String
  /// Bytes on disk of every object this item lists (shared objects counted in each item that holds them).
  let bytes: Int64
  let objectCount: Int
  /// When the download completed (epoch ms); nil when unknown.
  let savedAt: Int64?
}

/// The complete downloads and the space they take; an object shared by several items counts once in `totalBytes`.
struct OfflineInventory: Equatable {
  let items: [OfflineInventoryItem]
  let totalBytes: Int64

  /// Pure inventory of `completed` items `(id, completedAt)`: `objectsOf` is the item's object list (nil when the list
  /// file is gone: the item is then listed with 0 bytes), `sizeOf` the on-disk size of an object (0 when missing).
  static func compute(
    completed: [(id: String, completedAt: Int64)],
    objectsOf: (String) -> [DownloadObject]?,
    sizeOf: (String) -> Int64
  ) -> OfflineInventory {
    var sizes: [String: Int64] = [:]
    func size(_ key: String) -> Int64 {
      if let known = sizes[key] { return known }
      let value = sizeOf(key)
      sizes[key] = value
      return value
    }
    let rows = completed.map { entry -> OfflineInventoryItem in
      var seen = Set<String>()
      let keys = (objectsOf(entry.id) ?? []).map { $0.key }.filter { seen.insert($0).inserted }
      return OfflineInventoryItem(
        itemId: entry.id,
        bytes: keys.reduce(0) { $0 + size($1) },
        objectCount: keys.count,
        savedAt: entry.completedAt > 0 ? entry.completedAt : nil
      )
    }
    return OfflineInventory(items: rows, totalBytes: sizes.values.reduce(0, +))
  }

  /// Keys of `removing` that no object list in `others` still holds: what removing that item frees on disk.
  static func keysToDelete(removing: [DownloadObject], others: [Set<String>]) -> [String] {
    let inUse = others.reduce(into: Set<String>()) { $0.formUnion($1) }
    var seen = Set<String>()
    return removing.map { $0.key }.filter { !inUse.contains($0) && seen.insert($0).inserted }
  }

  func toJSONString() -> String {
    let root: [String: Any] = [
      "items": items.map { item -> [String: Any] in
        [
          "itemId": item.itemId,
          "bytes": item.bytes,
          "objectCount": item.objectCount,
          "savedAt": item.savedAt.map { $0 as Any } ?? NSNull(),
        ]
      },
      "totalBytes": totalBytes,
    ]
    let data = (try? JSONSerialization.data(withJSONObject: root)) ?? Data("{}".utf8)
    return String(decoding: data, as: UTF8.self)
  }
}
#endif
