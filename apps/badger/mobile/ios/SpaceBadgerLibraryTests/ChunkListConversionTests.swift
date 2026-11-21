import Foundation
import SQLite3
import XCTest

/// @test-id MOBILE-LIB-CHUNKLIST-CONVERT-SWIFT-001
/// @level unit
/// @req LIB-FMT-11
/// @req LIB-FMT-12
/// @req LIB-SYNC-15
/// @why The phone and TV convert their playback database to packed chunk lists once, natively, off the script thread
///   (the gated layout step of LIB-FMT-12). One row per chunk becomes one packed row per format or audio track, in
///   one transaction, with the agreed contract (vault v4 plan §1.8): owners only from chunk rows, a zero-chunk owner
///   gets no row, mode 1 or 0 never 2, `updated_at` = the run's `nowIso`, old tables emptied not dropped, and
///   `NO_CHUNK_LISTS_TABLE` when the base DDL has not created the packed table. Losing a chunk here would make a
///   title unplayable on that device, so every converted list is unpacked back and compared with its source rows.
final class ChunkListConversionTests: XCTestCase {
  private let tag = "[MOBILE-LIB-CHUNKLIST-CONVERT-SWIFT-001]"
  private var dbPath: String!

  private func log(_ phase: String, _ data: String = "") { print("\(tag) \(phase) \(data)") }

  /// The chunk tables of the playback DDL (`packages/library-db-definition/src/migrations.ts`, foreign keys left out)
  /// and the v4 packed table (vault v4 plan §1.2).
  private static let ddl = """
    CREATE TABLE media_format_chunks (
      id TEXT PRIMARY KEY, format_id TEXT NOT NULL, chunk_key TEXT NOT NULL, order_index INTEGER NOT NULL,
      size_bytes INTEGER, start_seconds REAL);
    CREATE UNIQUE INDEX media_format_chunks_unique_idx ON media_format_chunks(format_id, order_index);
    CREATE TABLE media_audio_chunks (
      id TEXT PRIMARY KEY, track_id TEXT NOT NULL, chunk_key TEXT NOT NULL, order_index INTEGER NOT NULL,
      size_bytes INTEGER, start_seconds REAL);
    CREATE UNIQUE INDEX media_audio_chunks_unique_idx ON media_audio_chunks(track_id, order_index);
    """
  private static let packedDdl = """
    CREATE TABLE media_chunk_lists (
      owner_id TEXT PRIMARY KEY, owner_kind INTEGER NOT NULL, placement_id TEXT NOT NULL, key_mode INTEGER NOT NULL,
      key_data BLOB NOT NULL, count INTEGER NOT NULL, sizes BLOB NOT NULL, starts BLOB, updated_at TEXT NOT NULL
    ) WITHOUT ROWID;
    """

  override func setUpWithError() throws {
    dbPath = FileManager.default.temporaryDirectory.appendingPathComponent("convert-\(UUID().uuidString).db").path
    log("setUp", dbPath)
  }

  override func tearDownWithError() throws {
    for suffix in ["", "-wal", "-shm", "-journal"] { try? FileManager.default.removeItem(atPath: dbPath + suffix) }
  }

  private func withDb<T>(_ body: (OpaquePointer) throws -> T) throws -> T {
    var db: OpaquePointer?
    guard sqlite3_open(dbPath, &db) == SQLITE_OK, let db else { throw XCTSkip("sqlite open failed") }
    defer { sqlite3_close(db) }
    return try body(db)
  }

  private func exec(_ db: OpaquePointer, _ sql: String) {
    var error: UnsafeMutablePointer<CChar>?
    if sqlite3_exec(db, sql, nil, nil, &error) != SQLITE_OK {
      XCTFail("sql failed: \(error.map { String(cString: $0) } ?? "?") in \(sql.prefix(200))")
    }
  }

  private func count(_ db: OpaquePointer, _ table: String) -> Int {
    var statement: OpaquePointer?
    sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM \(table)", -1, &statement, nil)
    defer { sqlite3_finalize(statement) }
    sqlite3_step(statement)
    return Int(sqlite3_column_int64(statement, 0))
  }

  private func blob(_ statement: OpaquePointer, _ column: Int32) -> Data? {
    guard sqlite3_column_type(statement, column) != SQLITE_NULL else { return nil }
    let length = Int(sqlite3_column_bytes(statement, column))
    guard length > 0, let pointer = sqlite3_column_blob(statement, column) else { return Data() }
    return Data(bytes: pointer, count: length)
  }

  private struct Row: Equatable {
    let kind: Int
    let list: PackedChunkList
    let updatedAt: String
  }

  private func packedRows(_ db: OpaquePointer) -> [String: Row] {
    var statement: OpaquePointer?
    sqlite3_prepare_v2(
      db,
      "SELECT owner_id, owner_kind, placement_id, key_mode, key_data, count, sizes, starts, updated_at FROM media_chunk_lists",
      -1, &statement, nil)
    defer { sqlite3_finalize(statement) }
    var out: [String: Row] = [:]
    while sqlite3_step(statement) == SQLITE_ROW, let statement {
      let owner = String(cString: sqlite3_column_text(statement, 0))
      out[owner] = Row(
        kind: Int(sqlite3_column_int64(statement, 1)),
        list: PackedChunkList(
          placementId: String(cString: sqlite3_column_text(statement, 2)),
          keyMode: Int(sqlite3_column_int64(statement, 3)),
          keyData: blob(statement, 4) ?? Data(), count: Int(sqlite3_column_int64(statement, 5)),
          sizes: blob(statement, 6) ?? Data(), starts: blob(statement, 7)),
        updatedAt: String(cString: sqlite3_column_text(statement, 8)))
    }
    return out
  }

  private func sqlValue(_ value: Any?) -> String {
    switch value {
    case let text as String: return "'\(text.replacingOccurrences(of: "'", with: "''"))'"
    case let number as Int64: return String(number)
    case let number as Double: return String(number)
    default: return "NULL"
    }
  }

  /// Inserts `chunks` for `owner`, in shuffled row order so the conversion has to sort by `order_index`.
  private func insert(_ db: OpaquePointer, table: String, ownerColumn: String, owner: String, _ chunks: [ChunkRef]) {
    for (index, chunk) in chunks.enumerated().reversed() {
      exec(
        db,
        "INSERT INTO \(table) (id, \(ownerColumn), chunk_key, order_index, size_bytes, start_seconds) VALUES ('\(owner)-\(index)', '\(owner)', \(sqlValue(chunk.key)), \(index), \(sqlValue(chunk.sizeBytes)), \(sqlValue(chunk.startSeconds)))"
      )
    }
  }

  private let placement = "p-1"
  private func uuid(_ i: Int) -> String { String(format: "00000000-0000-4000-8000-%012x", i) }

  func testConvertsBothTablesInOneRunAndEmptiesThem() throws {
    let video = (0..<500).map {
      ChunkRef(key: "media/\(placement)/\(uuid($0))", sizeBytes: 4_194_304 + Int64($0), startSeconds: Double($0) * 4.004)
    }
    let mixed = [
      ChunkRef(key: "media/p-2/\(uuid(1))", sizeBytes: nil, startSeconds: nil),
      ChunkRef(key: "legacy/key with space", sizeBytes: 4_294_967_303, startSeconds: 0.5),
    ]
    let audio = (0..<3).map { ChunkRef(key: "media/\(placement)/\(uuid(1000 + $0))", sizeBytes: 100, startSeconds: nil) }
    try withDb { db in
      exec(db, Self.ddl + Self.packedDdl)
      insert(db, table: "media_format_chunks", ownerColumn: "format_id", owner: "fmt-video", video)
      insert(db, table: "media_format_chunks", ownerColumn: "format_id", owner: "fmt-mixed", mixed)
      insert(db, table: "media_audio_chunks", ownerColumn: "track_id", owner: "trk-audio", audio)
      // A row a previous run or an op already wrote for an owner that has chunks again: replaced.
      exec(
        db,
        "INSERT INTO media_chunk_lists VALUES ('fmt-mixed', 1, 'old', 0, x'', 0, x'', NULL, 'old'); INSERT INTO media_chunk_lists VALUES ('fmt-none', 1, 'keep', 0, x'', 0, x'', NULL, 'keep')"
      )
    }

    let started = Date()
    let result = try ChunkListConversion.run(dbPath: dbPath, nowIso: "2026-11-21T12:00:00.000Z")
    log("run", "lists=\(result.lists) rows=\(result.rows) ms=\(Int(Date().timeIntervalSince(started) * 1000))")
    XCTAssertEqual(result, ChunkListConversion.Result(lists: 3, rows: 505))

    try withDb { db in
      XCTAssertEqual(count(db, "media_format_chunks"), 0)
      XCTAssertEqual(count(db, "media_audio_chunks"), 0)
      let rows = packedRows(db)
      log("rows", rows.map { "\($0.key): kind=\($0.value.kind) mode=\($0.value.list.keyMode) count=\($0.value.list.count) keyData=\($0.value.list.keyData.count)B sizes=\($0.value.list.sizes.count)B starts=\($0.value.list.starts?.count ?? -1)B" }.sorted().joined(separator: "; "))
      XCTAssertEqual(Set(rows.keys), ["fmt-video", "fmt-mixed", "trk-audio", "fmt-none"])

      let expectations: [(String, Int, [ChunkRef], Int)] = [
        ("fmt-video", ChunkListCodec.ownerKindFormat, video, ChunkListCodec.keyModeUuidBytes),
        ("fmt-mixed", ChunkListCodec.ownerKindFormat, mixed, ChunkListCodec.keyModeTexts),
        ("trk-audio", ChunkListCodec.ownerKindAudioTrack, audio, ChunkListCodec.keyModeUuidBytes),
      ]
      for (owner, kind, chunks, mode) in expectations {
        let row = try XCTUnwrap(rows[owner], owner)
        XCTAssertEqual(row.kind, kind, owner)
        XCTAssertEqual(row.list.keyMode, mode, owner)
        XCTAssertEqual(row.updatedAt, "2026-11-21T12:00:00.000Z", owner)
        XCTAssertEqual(row.list, try ChunkListCodec.pack(chunks), "\(owner) same bytes as pack()")
        let back = try ChunkListCodec.unpack(row.list)
        XCTAssertEqual(back.map(\.key), chunks.map(\.key), owner)
        XCTAssertEqual(back.map(\.sizeBytes), chunks.map(\.sizeBytes), owner)
        for (a, b) in zip(back, chunks) {
          XCTAssertEqual(a.startSeconds == nil, b.startSeconds == nil, owner)
          if let a = a.startSeconds, let b = b.startSeconds { XCTAssertEqual(a, b, accuracy: 0.0005, owner) }
        }
      }
      XCTAssertNil(rows["trk-audio"]?.list.starts, "no start times -> starts NULL")
      XCTAssertEqual(rows["fmt-none"]?.updatedAt, "keep", "an owner without chunk rows is left alone")
    }

    // A second run finds no chunk rows and changes nothing.
    let again = try ChunkListConversion.run(dbPath: dbPath, nowIso: "2026-11-21T13:00:00.000Z")
    log("rerun", "lists=\(again.lists) rows=\(again.rows)")
    XCTAssertEqual(again, ChunkListConversion.Result(lists: 0, rows: 0))
    try withDb { db in XCTAssertEqual(packedRows(db)["fmt-video"]?.updatedAt, "2026-11-21T12:00:00.000Z") }
  }

  func testMissingPackedTableFailsWithoutTouchingTheChunks() throws {
    try withDb { db in
      exec(db, Self.ddl)
      insert(db, table: "media_format_chunks", ownerColumn: "format_id", owner: "f", [ChunkRef(key: "k", sizeBytes: 1, startSeconds: nil)])
    }
    XCTAssertThrowsError(try ChunkListConversion.run(dbPath: dbPath, nowIso: "2026-11-21T12:00:00.000Z")) { error in
      log("noTable", "\(error)")
      XCTAssertEqual((error as? ChunkListConversion.ConversionError)?.code, "NO_CHUNK_LISTS_TABLE")
    }
    try withDb { db in XCTAssertEqual(count(db, "media_format_chunks"), 1) }
  }

  func testAFailedPackRollsBackEverything() throws {
    try withDb { db in
      exec(db, Self.ddl + Self.packedDdl)
      insert(db, table: "media_format_chunks", ownerColumn: "format_id", owner: "a-good", [ChunkRef(key: "k1", sizeBytes: 1, startSeconds: nil)])
      // A key with a newline cannot be packed in mode 0 (keys are joined by `\n`): the run must fail as a whole.
      insert(db, table: "media_format_chunks", ownerColumn: "format_id", owner: "b-bad", [ChunkRef(key: "bad\nkey", sizeBytes: 1, startSeconds: nil)])
    }
    XCTAssertThrowsError(try ChunkListConversion.run(dbPath: dbPath, nowIso: "2026-11-21T12:00:00.000Z")) { error in
      log("rollback", "\(error)")
      XCTAssertEqual((error as? ChunkListConversion.ConversionError)?.code, "CONVERT_FAILED")
    }
    try withDb { db in
      XCTAssertEqual(count(db, "media_format_chunks"), 2)
      XCTAssertEqual(count(db, "media_chunk_lists"), 0)
    }
  }
}
