#if os(iOS)
import Foundation
import React

/// iOS counterpart of the Android `DownloadsModule` (packages/mobile-mpv-playback/.../downloads/DownloadsModule.kt):
/// same `NativeModules.DownloadsBridge` surface (`@space/mobile-media-proxy/downloads`), same payloads, same
/// `downloads_bridge_error` rejection code, and the `SpaceDownloadsChanged` device event carrying the full
/// `DownloadsState` JSON string. All behaviour lives in `DownloadEngine`; this class only translates calls.
///
/// JS subscribes through `DeviceEventEmitter` (not `NativeEventEmitter`), so it never calls `addListener` on this
/// module; the emitter is created with observation disabled so events are always forwarded.
@objc(DownloadsBridge)
final class DownloadsBridge: RCTEventEmitter {
  private static let eventName = "SpaceDownloadsChanged"
  private static let errorCode = "downloads_bridge_error"

  private let engine = DownloadEngine.shared

  override init() {
    super.init(disabledObservation: ())
  }

  override class func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! { [Self.eventName] }

  override func invalidate() {
    engine.queue.async {
      // A JS reload creates a fresh module before/after this one is torn down: only clear our own hook.
      if self.engine.listenerOwner === self {
        self.engine.listener = nil
        self.engine.listenerOwner = nil
      }
    }
    super.invalidate()
  }

  /// Runs `block` on the engine queue and settles the promise with its result.
  private func run(
    _ resolve: @escaping RCTPromiseResolveBlock,
    _ reject: @escaping RCTPromiseRejectBlock,
    _ block: @escaping () throws -> Any
  ) {
    engine.queue.async {
      do {
        resolve(try block())
      } catch {
        NSLog("[DownloadsBridge] call.failed %@", error.localizedDescription)
        reject(Self.errorCode, error.localizedDescription, error)
      }
    }
  }

  private struct BridgeError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
  }

  @objc(configure:appId:wifiOnly:labelsJson:resolve:reject:)
  func configure(
    _ authToken: String,
    appId: String,
    wifiOnly: Bool,
    labelsJson: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    run(resolve, reject) {
      self.attachListener()
      self.engine.configure(authToken: authToken, appId: appId, wifiOnly: wifiOnly, labelsJson: labelsJson)
      return true
    }
  }

  /// `itemJson`: `{ id, mediaId, title, subtitle, kind, seasonNumber, episodeNumber, quality, formatId, codec,
  /// estimatedBytes, gatewayCandidates[], objects: [[key, sizeBytes], ...] }`
  @objc(enqueue:resolve:reject:)
  func enqueue(
    _ itemJson: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    run(resolve, reject) {
      guard
        var json = (try JSONSerialization.jsonObject(with: Data(itemJson.utf8))) as? [String: Any],
        let pairs = json["objects"] as? [[Any]]
      else { throw BridgeError(message: "invalid_item_json") }
      let objects = pairs.compactMap { pair -> DownloadObject? in
        guard let key = pair.first as? String else { return nil }
        return DownloadObject(key: key, size: (pair.count > 1 ? (pair[1] as? NSNumber)?.int64Value : nil) ?? 0)
      }
      json["totalObjects"] = objects.count
      guard let item = DownloadItem(json: json) else { throw BridgeError(message: "invalid_item_json") }
      self.attachListener()
      self.engine.enqueue(item, objects: objects)
      return true
    }
  }

  @objc(retry:gatewayCandidatesJson:resolve:reject:)
  func retry(
    _ id: String,
    gatewayCandidatesJson: String?,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    run(resolve, reject) {
      var candidates: [String]?
      if let raw = gatewayCandidatesJson {
        candidates = ((try JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [Any])?.compactMap { $0 as? String }
      }
      self.engine.retry(id: id, gatewayCandidates: candidates)
      return true
    }
  }

  @objc(remove:resolve:reject:)
  func remove(
    _ idsJson: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    run(resolve, reject) {
      let ids = ((try JSONSerialization.jsonObject(with: Data(idsJson.utf8))) as? [Any])?.compactMap { $0 as? String } ?? []
      self.engine.remove(ids: ids)
      return true
    }
  }

  @objc(removeAll:reject:)
  func removeAll(resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    run(resolve, reject) {
      self.engine.removeAll()
      return true
    }
  }

  /// `{ items: [{ itemId, bytes, objectCount, savedAt }], totalBytes }`: complete downloads only (OFFL-MANAGE-01).
  @objc(listItems:reject:)
  func listItems(resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    run(resolve, reject) { self.engine.listItems().toJSONString() }
  }

  @objc(resume:reject:)
  func resume(resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    run(resolve, reject) {
      self.attachListener()
      self.engine.resume()
      return true
    }
  }

  @objc(getState:reject:)
  func getState(resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    run(resolve, reject) {
      self.attachListener()
      return self.engine.stateJSON()
    }
  }

  /// `{ networkType, freeBytes }`: inputs of the JS-side start decision.
  @objc(getStatus:reject:)
  func getStatus(resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    engine.queue.async {
      self.engine.statusJSON { resolve($0) }
    }
  }

  /// Engine-queue only. Routes engine state pushes to JS; the latest module instance owns the hook.
  private func attachListener() {
    guard engine.listenerOwner !== self else { return }
    engine.listenerOwner = self
    engine.listener = { [weak self] json in
      self?.sendEvent(withName: Self.eventName, body: json)
    }
  }
}
#endif
