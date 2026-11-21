package com.spacebadger.mobile.library

import android.database.sqlite.SQLiteDatabase

/**
 * The phone's one-time packing of its chunk tables (LIB-FMT-12, vault v4 plan §1.8), natively, on the playback DB
 * file: every `media_format_chunks` list (owner kind 1) and `media_audio_chunks` list (owner kind 2), in `order_index`
 * order, becomes one `media_chunk_lists` row packed exactly as `packChunkList` in `chunkLists.ts` (key mode 1 when
 * every key is `media/<one placement>/<lowercase uuid>`, else 0; never 2), then both old tables are emptied (never
 * dropped, LIB-FMT-03). One transaction: a failure leaves the file as it was. Owners come from the chunk rows (a
 * chunk whose format/track row is gone is still packed, as the TS step does); an owner without chunks gets no row.
 * The table itself is the JS layout step's (base playback DDL); its absence rejects. Lists the owners first, then
 * reads one owner's chunks per query through the unique `(owner, order_index)` index, so memory is one list, not the
 * table, and each cursor fits one window (one ordered query over the whole table: 42 s vs 33 s for 360k rows on the
 * debug emulator, 2026-11-21).
 */
object ChunkListConversion {
  data class Result(val lists: Int, val rows: Long, val ms: Long)

  class Failure(val code: String, message: String, cause: Throwable? = null) : Exception(message, cause)

  fun interface Log {
    fun info(event: String)
  }

  private val SOURCES = listOf(
    Triple("media_format_chunks", "format_id", ChunkListCodec.OWNER_KIND_FORMAT),
    Triple("media_audio_chunks", "track_id", ChunkListCodec.OWNER_KIND_AUDIO_TRACK)
  )

  fun convert(playbackDbPath: String, nowIso: String, log: Log = Log { }): Result {
    val startedAt = System.currentTimeMillis()
    val db = try {
      SQLiteDatabase.openDatabase(playbackDbPath, null, SQLiteDatabase.OPEN_READWRITE)
    } catch (error: Exception) {
      throw Failure("CONVERT_FAILED", "open failed: ${error.message}", error)
    }
    try {
      db.rawQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_chunk_lists'", null).use {
        if (!it.moveToFirst()) throw Failure("NO_CHUNK_LISTS_TABLE", "media_chunk_lists missing in $playbackDbPath")
      }
      var lists = 0
      var rows = 0L
      db.beginTransaction()
      try {
        val insert = db.compileStatement(
          "INSERT OR REPLACE INTO media_chunk_lists " +
            "(owner_id, owner_kind, placement_id, key_mode, key_data, count, sizes, starts, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        fun write(ownerId: String, kind: Int, chunks: List<ChunkListCodec.Chunk>) {
          val packed = ChunkListCodec.pack(chunks)
          insert.clearBindings()
          insert.bindString(1, ownerId)
          insert.bindLong(2, kind.toLong())
          insert.bindString(3, packed.placementId)
          insert.bindLong(4, packed.keyMode.toLong())
          insert.bindBlob(5, packed.keyData)
          insert.bindLong(6, packed.count.toLong())
          insert.bindBlob(7, packed.sizes)
          if (packed.starts == null) insert.bindNull(8) else insert.bindBlob(8, packed.starts)
          insert.bindString(9, nowIso)
          insert.executeInsert()
          lists += 1
        }
        for ((table, ownerColumn, kind) in SOURCES) {
          var tableRows = 0L
          var tableLists = 0
          val owners = ArrayList<String>()
          db.rawQuery("SELECT DISTINCT $ownerColumn FROM $table", null).use { cursor ->
            while (cursor.moveToNext()) owners.add(cursor.getString(0))
          }
          val chunks = ArrayList<ChunkListCodec.Chunk>()
          for (owner in owners) {
            chunks.clear()
            db.rawQuery(
              "SELECT chunk_key, size_bytes, start_seconds FROM $table WHERE $ownerColumn = ? ORDER BY order_index",
              arrayOf(owner)
            ).use { cursor ->
              while (cursor.moveToNext()) {
                chunks.add(
                  ChunkListCodec.Chunk(
                    cursor.getString(0),
                    if (cursor.isNull(1)) null else cursor.getLong(1),
                    if (cursor.isNull(2)) null else cursor.getDouble(2)
                  )
                )
              }
            }
            write(owner, kind, chunks)
            tableLists += 1
            tableRows += chunks.size
          }
          db.execSQL("DELETE FROM $table")
          rows += tableRows
          log.info("chunkLists.convert.table table=$table rows=$tableRows lists=$tableLists")
        }
        db.setTransactionSuccessful()
      } finally {
        db.endTransaction()
      }
      val result = Result(lists, rows, System.currentTimeMillis() - startedAt)
      log.info("chunkLists.convert.done lists=${result.lists} rows=${result.rows} ms=${result.ms}")
      return result
    } catch (error: Failure) {
      throw error
    } catch (error: Exception) {
      throw Failure("CONVERT_FAILED", error.message ?: error.javaClass.simpleName, error)
    } finally {
      db.close()
    }
  }
}
