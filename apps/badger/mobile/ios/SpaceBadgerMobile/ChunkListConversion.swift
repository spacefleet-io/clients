import Foundation
import SQLite3

/// The one-time packing of the phone's playback database (LIB-FMT-11/12, vault v4 plan §1.8), the native half of the
/// gated layout step that slice 6 (phone JS) registers and runs only once the account is switched. In one transaction:
///
///   1. every `media_format_chunks` owner (`format_id`, owner_kind 1) and `media_audio_chunks` owner (`track_id`,
///      owner_kind 2), chunks in `order_index` order, is packed exactly as TS `packChunkList` (key mode 1 when every
///      key is `media/<one placement>/<lowercase uuid>`, else 0; never 2) and written with `INSERT OR REPLACE` into
///      `media_chunk_lists`, `updated_at` = the one `nowIso` of the run;
///   2. both old chunk tables are emptied (never dropped, LIB-FMT-03).
///
/// Owners come from the chunk rows, so an owner without chunks gets no row. No clock or version rows are written,
/// template tables are untouched, and `media_chunk_lists` must exist already (the base playback DDL creates it).
/// Same contract as Android's `LibrarySyncModule.convertChunkLists`.
enum ChunkListConversion {
  struct ConversionError: LocalizedError {
    let code: String
    let message: String
    var errorDescription: String? { "\(code): \(message)" }
  }

  struct Result: Equatable {
    /// Rows written to `media_chunk_lists`.
    let lists: Int
    /// Old chunk rows packed (and deleted).
    let rows: Int
  }

  private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

  private static let sources: [(table: String, owner: String, kind: Int)] = [
    ("media_format_chunks", "format_id", ChunkListCodec.ownerKindFormat),
    ("media_audio_chunks", "track_id", ChunkListCodec.ownerKindAudioTrack),
  ]

  static func run(dbPath: String, nowIso: String) throws -> Result {
    guard !nowIso.isEmpty else { throw ConversionError(code: "INVALID_ARGUMENT", message: "nowIso is empty") }
    guard FileManager.default.fileExists(atPath: dbPath) else {
      throw ConversionError(code: "CONVERT_FAILED", message: "no database at \(dbPath)")
    }
    var db: OpaquePointer?
    guard sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK, let db else {
      let message = db.map { String(cString: sqlite3_errmsg($0)) } ?? "open failed"
      sqlite3_close(db)
      throw ConversionError(code: "CONVERT_FAILED", message: message)
    }
    defer { sqlite3_close(db) }
    // JS may hold its own connection on the same file: wait for its locks instead of failing at once.
    sqlite3_busy_timeout(db, 10_000)

    guard try tableExists(db, "media_chunk_lists") else {
      throw ConversionError(code: "NO_CHUNK_LISTS_TABLE", message: "media_chunk_lists is missing in \(dbPath)")
    }
    try exec(db, "BEGIN IMMEDIATE")
    do {
      let insert = try prepare(
        db,
        """
        INSERT OR REPLACE INTO media_chunk_lists
          (owner_id, owner_kind, placement_id, key_mode, key_data, count, sizes, starts, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """)
      defer { sqlite3_finalize(insert) }
      var lists = 0
      var rows = 0
      for source in sources {
        let select = try prepare(
          db,
          "SELECT \(source.owner), chunk_key, size_bytes, start_seconds FROM \(source.table) ORDER BY \(source.owner), order_index")
        defer { sqlite3_finalize(select) }
        var owner: String?
        var chunks: [ChunkRef] = []
        func flush() throws {
          guard let owner, !chunks.isEmpty else { return }
          try write(db, insert, owner: owner, kind: source.kind, list: try ChunkListCodec.pack(chunks), nowIso: nowIso)
          lists += 1
          rows += chunks.count
        }
        while true {
          let step = sqlite3_step(select)
          if step == SQLITE_DONE { break }
          guard step == SQLITE_ROW else { throw failure(db, "read \(source.table)") }
          let rowOwner = text(select, 0) ?? ""
          if rowOwner != owner {
            try flush()
            owner = rowOwner
            chunks.removeAll(keepingCapacity: true)
          }
          chunks.append(
            ChunkRef(
              key: text(select, 1) ?? "",
              sizeBytes: sqlite3_column_type(select, 2) == SQLITE_NULL ? nil : sqlite3_column_int64(select, 2),
              startSeconds: sqlite3_column_type(select, 3) == SQLITE_NULL ? nil : sqlite3_column_double(select, 3)))
        }
        try flush()
      }
      for source in sources { try exec(db, "DELETE FROM \(source.table)") }
      try exec(db, "COMMIT")
      return Result(lists: lists, rows: rows)
    } catch {
      sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
      if let error = error as? ChunkListFormatError {
        throw ConversionError(code: "CONVERT_FAILED", message: error.errorDescription ?? error.message)
      }
      throw error
    }
  }

  private static func write(
    _ db: OpaquePointer, _ insert: OpaquePointer, owner: String, kind: Int, list: PackedChunkList, nowIso: String
  ) throws {
    sqlite3_reset(insert)
    sqlite3_clear_bindings(insert)
    sqlite3_bind_text(insert, 1, owner, -1, transient)
    sqlite3_bind_int64(insert, 2, Int64(kind))
    sqlite3_bind_text(insert, 3, list.placementId, -1, transient)
    sqlite3_bind_int64(insert, 4, Int64(list.keyMode))
    bindBlob(insert, 5, list.keyData)
    sqlite3_bind_int64(insert, 6, Int64(list.count))
    bindBlob(insert, 7, list.sizes)
    if let starts = list.starts { bindBlob(insert, 8, starts) } else { sqlite3_bind_null(insert, 8) }
    sqlite3_bind_text(insert, 9, nowIso, -1, transient)
    guard sqlite3_step(insert) == SQLITE_DONE else { throw failure(db, "write list \(owner)") }
  }

  /// A zero-length blob, never NULL: `key_data` and `sizes` are NOT NULL (binding a nil pointer would give NULL).
  private static func bindBlob(_ statement: OpaquePointer, _ index: Int32, _ data: Data) {
    if data.isEmpty {
      sqlite3_bind_zeroblob(statement, index, 0)
      return
    }
    data.withUnsafeBytes { raw in
      _ = sqlite3_bind_blob(statement, index, raw.baseAddress, Int32(raw.count), transient)
    }
  }

  private static func text(_ statement: OpaquePointer, _ column: Int32) -> String? {
    guard let pointer = sqlite3_column_text(statement, column) else { return nil }
    return String(cString: pointer)
  }

  private static func tableExists(_ db: OpaquePointer, _ name: String) throws -> Bool {
    let statement = try prepare(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    defer { sqlite3_finalize(statement) }
    sqlite3_bind_text(statement, 1, name, -1, transient)
    return sqlite3_step(statement) == SQLITE_ROW
  }

  private static func prepare(_ db: OpaquePointer, _ sql: String) throws -> OpaquePointer {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
      throw failure(db, "prepare \(sql)")
    }
    return statement
  }

  private static func exec(_ db: OpaquePointer, _ sql: String) throws {
    guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw failure(db, sql) }
  }

  private static func failure(_ db: OpaquePointer, _ what: String) -> ConversionError {
    ConversionError(code: "CONVERT_FAILED", message: "\(what): \(String(cString: sqlite3_errmsg(db)))")
  }
}
