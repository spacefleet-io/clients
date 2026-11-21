import CryptoKit
import Foundation
import React

/// Vault v4 bridge methods of `LibrarySync` (vault v4 plan §1.7), same JS contract as Android's `LibrarySyncModule`:
///
///     fetchOpsPage({ url, headers, keyBase64, fromVersion })
///       -> { version, snapshotVersion, hasMore, tooOld, storageFormatVersion, opStreamVersion,
///            targetOpStreamVersion: number | null, bytes, ms,
///            ops: Array<{ version, jsonBytes, text?: string, path?: string, sliceEnds?: number[] }> }
///     convertChunkLists(playbackDbPath, nowIso) -> { lists, rows, ms }
///
/// Rejection codes: `HTTP_<status>` (message = response body), `NETWORK_FAILED`, `BAD_FRAMES`, `OPEN_FAILED`
/// (message `DECRYPT_FAILED` | `corrupt_compressed_frame` | `unknown_compression_codec:N` | `INVALID_UTF8`),
/// `INVALID_KEY`, `INVALID_ARGUMENT`; `NO_CHUNK_LISTS_TABLE`, `CONVERT_FAILED`.
extension LibrarySync {
  @objc(fetchOpsPage:resolve:reject:)
  func fetchOpsPage(
    _ options: NSDictionary, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    guard
      let url = options["url"] as? String,
      let keyBase64 = options["keyBase64"] as? String,
      let fromVersion = (options["fromVersion"] as? NSNumber)?.doubleValue,
      fromVersion.isFinite, fromVersion >= 0, fromVersion < Double(Int.max)
    else {
      reject("INVALID_ARGUMENT", "fetchOpsPage needs url, keyBase64 and fromVersion", nil)
      return
    }
    guard
      let raw = Data(base64Encoded: keyBase64.trimmingCharacters(in: .whitespacesAndNewlines)), raw.count == 32
    else {
      reject("INVALID_KEY", "INVALID_KEY", nil)
      return
    }
    var headers: [String: String] = [:]
    for (name, value) in (options["headers"] as? [String: Any]) ?? [:] {
      if let text = value as? String { headers[name] = text }
    }
    LibraryOpsPage.fetch(
      url: url, headers: headers, key: SymmetricKey(data: raw), fromVersion: Int(fromVersion),
      directory: LibraryOpsPage.defaultDirectory()
    ) { result in
      switch result {
      case .success(let page):
        resolve(page.bridge)
      case .failure(let error as LibraryOpsPage.PageError):
        NSLog("[LibrarySync] ops.page.failed code=%@ message=%@", error.code, String(error.message.prefix(512)))
        reject(error.code, error.message, error)
      case .failure(let error):
        NSLog("[LibrarySync] ops.page.failed %@", error.localizedDescription)
        reject("NETWORK_FAILED", error.localizedDescription, error)
      }
    }
  }

  @objc(convertChunkLists:nowIso:resolve:reject:)
  func convertChunkLists(
    _ playbackDbPath: String, nowIso: String,
    resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.global(qos: .userInitiated).async {
      let startedAt = Date()
      NSLog("[LibrarySync] chunkLists.convert.start db=%@ now=%@", playbackDbPath, nowIso)
      do {
        let result = try ChunkListConversion.run(dbPath: playbackDbPath, nowIso: nowIso)
        let ms = Int(Date().timeIntervalSince(startedAt) * 1000)
        NSLog("[LibrarySync] chunkLists.convert.done lists=%ld rows=%ld ms=%ld", result.lists, result.rows, ms)
        resolve(["lists": result.lists, "rows": result.rows, "ms": ms])
      } catch let error as ChunkListConversion.ConversionError {
        NSLog("[LibrarySync] chunkLists.convert.failed %@ %@", error.code, error.message)
        reject(error.code, error.message, error)
      } catch {
        NSLog("[LibrarySync] chunkLists.convert.failed %@", error.localizedDescription)
        reject("CONVERT_FAILED", error.localizedDescription, error)
      }
    }
  }
}
