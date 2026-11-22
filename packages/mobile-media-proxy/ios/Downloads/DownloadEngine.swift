#if os(iOS)
import Foundation
import Network
import UserNotifications

// MARK: - Models

struct DownloadObject {
  let key: String
  let size: Int64
}

struct DownloadConfig {
  let authToken: String
  let appId: String
  let wifiOnly: Bool
  let labels: DownloadLabels
}

/// Notification texts, translated by JS in the app language and passed through `configure` (persisted in
/// queue.json for relaunches without JS). A missing or blank key is nil: the notification then uses
/// `Localizable.strings`, in the phone's language. Android counterpart: `DownloadLabels` in `DownloadQueueStore.kt`;
/// the Android-only keys JS also sends are ignored.
struct DownloadLabels: Equatable {
  var completed: String?
  var failed: String?
  var insufficientSpace: String?
  var auth: String?
  var network: String?

  init() {}

  /// Tolerant parse of the `labelsJson` argument; unparseable input yields no labels (warning logged).
  init(jsonString string: String) {
    guard
      !string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      let data = string.data(using: .utf8),
      let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    else {
      NSLog("[Downloads] labels.parse_failed")
      self.init()
      return
    }
    self.init(json: object, warnMissing: true)
  }

  /// Blank / non-string keys stay nil.
  init(json: [String: Any]?, warnMissing: Bool = false) {
    self.init()
    guard let json else { return }
    var missing: [String] = []
    func pick(_ key: String) -> String? {
      if let value = json[key] as? String, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return value
      }
      missing.append(key)
      return nil
    }
    completed = pick("completed")
    failed = pick("failed")
    insufficientSpace = pick("insufficientSpace")
    auth = pick("auth")
    network = pick("network")
    if warnMissing && !missing.isEmpty { NSLog("[Downloads] labels.missing_keys %@", missing.joined(separator: ",")) }
  }

  func toJSON() -> [String: Any] {
    let all: [String: String?] = [
      "completed": completed, "failed": failed, "insufficientSpace": insufficientSpace, "auth": auth, "network": network,
    ]
    return all.compactMapValues { $0 }
  }
}

/// Same status / error vocabulary as `DownloadQueueStore.kt` (and `types.ts`).
enum DownloadStatus {
  static let queued = "queued"
  static let downloading = "downloading"
  static let waitingNetwork = "waiting_network"
  static let completed = "completed"
  static let failed = "failed"
}

enum DownloadErrorCode {
  static let auth = "auth"
  static let network = "network"
  static let insufficientSpace = "insufficient_space"
  static let storage = "storage"
}

private func jsonString(_ o: [String: Any], _ key: String) -> String? {
  if let s = o[key] as? String { return s }
  return nil
}

private func jsonInt64(_ o: [String: Any], _ key: String) -> Int64? {
  (o[key] as? NSNumber)?.int64Value
}

private func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

/// What one silo (one gateway, one link) says about its load (STOR-BW-01, STOR-BW-09): the wire `traffic` object of a
/// tunnel session response, a `session.ack` frame and `GET /storage/traffic` (`parseStorageTraffic` in
/// `packages/shared/src/storageTunnel.ts`). `high` = `state == "high"`; `saturated` = the silo's link is saturated and an
/// `export` flow (an offline download) gets zero bytes until it lifts.
struct DownloadTrafficReport {
  let high: Bool
  let saturated: Bool

  static let normal = DownloadTrafficReport(high: false, saturated: false)

  /// Mirrors `parseStorageTraffic`: an unknown `state` yields nil (old gateways send no report).
  static func parse(_ value: Any?) -> DownloadTrafficReport? {
    guard let object = value as? [String: Any], let state = object["state"] as? String, state == "normal" || state == "high" else {
      return nil
    }
    return DownloadTrafficReport(high: state == "high", saturated: (object["saturated"] as? Bool) == true)
  }
}

/// Rules the engine applies under load (the Kotlin `DownloadTrafficPolicy`, same values).
enum DownloadTrafficPolicy {
  /// STOR-BW-01: while the silo is high the average rate stays at or under 4 Mbit/s (the desktop's `HIGH_TRAFFIC_DOWNLOAD_BYTES_PER_SEC`).
  static let highTrafficBytesPerSec: Int64 = 500_000
  /// STOR-BW-01, STOR-BW-09: while anything downloads each silo's report is re-read at most this often (seconds).
  static let trafficPollInterval: TimeInterval = 60
  private static let healBase: TimeInterval = 60
  private static let healMax: TimeInterval = 30 * 60

  /// A failure that heals by itself: a lost session / network, a refused token the app can renew. Never storage or space.
  static func isHealable(_ errorCode: String?) -> Bool {
    errorCode == DownloadErrorCode.auth || errorCode == DownloadErrorCode.network
  }

  /// Delay before the `n`-th automatic retry (1 = first): 1, 2, 4, 8, 16 min, then 30 min.
  static func healDelay(_ consecutiveFailures: Int) -> TimeInterval {
    min(healMax, healBase * pow(2, Double(max(0, min(20, consecutiveFailures - 1)))))
  }

  /// The `traffic` field of the state JSON: held wins over slowed (a saturated silo is also high).
  static func state(held: Bool, slowed: Bool) -> String { held ? "held" : (slowed ? "slowed" : "normal") }
}

/// Time slots on one shared timeline of `bytes / highTrafficBytesPerSec`, so the objects of every download together stay
/// at the average rate while the silo is high; time spent idle or held earns no credit for a later burst.
struct DownloadPacer {
  private var nextFree = Date.distantPast

  /// Seconds to wait before starting an object of `bytes`. Reserves the slot.
  mutating func reserve(bytes: Int64, now: Date) -> TimeInterval {
    let start = max(now, nextFree)
    let slot = bytes > 0 ? Double(bytes) / Double(DownloadTrafficPolicy.highTrafficBytesPerSec) : 0
    nextFree = start.addingTimeInterval(slot)
    return start.timeIntervalSince(now)
  }
}

/// One downloadable media file (a movie or one episode). `id` is the library `media_files.id`.
final class DownloadItem {
  let id: String
  let mediaId: String
  let title: String
  let subtitle: String?
  let kind: String
  let seasonNumber: Int?
  let episodeNumber: Int?
  let quality: String
  let formatId: String
  let codec: String
  let estimatedBytes: Int64
  let totalObjects: Int
  var gatewayCandidates: [String]
  let createdAt: Int64

  var status = DownloadStatus.queued
  var errorCode: String?
  var errorMessage: String?
  var doneBytes: Int64 = 0
  var doneObjects = 0
  var storedBytes: Int64 = 0
  var completedAt: Int64 = 0

  var isActive: Bool {
    status == DownloadStatus.queued || status == DownloadStatus.downloading || status == DownloadStatus.waitingNetwork
  }

  init?(json o: [String: Any]) {
    guard let id = jsonString(o, "id"), let mediaId = jsonString(o, "mediaId") else { return nil }
    self.id = id
    self.mediaId = mediaId
    title = jsonString(o, "title") ?? ""
    subtitle = jsonString(o, "subtitle")
    kind = jsonString(o, "kind") ?? "movie"
    seasonNumber = jsonInt64(o, "seasonNumber").map { Int($0) }
    episodeNumber = jsonInt64(o, "episodeNumber").map { Int($0) }
    quality = jsonString(o, "quality") ?? ""
    formatId = jsonString(o, "formatId") ?? ""
    codec = jsonString(o, "codec") ?? ""
    estimatedBytes = jsonInt64(o, "estimatedBytes") ?? 0
    totalObjects = Int(jsonInt64(o, "totalObjects") ?? 0)
    gatewayCandidates = (o["gatewayCandidates"] as? [Any])?.compactMap { $0 as? String } ?? []
    createdAt = jsonInt64(o, "createdAt") ?? nowMs()
    status = jsonString(o, "status") ?? DownloadStatus.queued
    errorCode = jsonString(o, "errorCode")
    errorMessage = jsonString(o, "errorMessage")
    doneBytes = jsonInt64(o, "doneBytes") ?? 0
    doneObjects = Int(jsonInt64(o, "doneObjects") ?? 0)
    storedBytes = jsonInt64(o, "storedBytes") ?? 0
    completedAt = jsonInt64(o, "completedAt") ?? 0
  }

  /// Light JSON (no object list): persisted in queue.json (with gateways) and sent to JS (without).
  func toJSON(includeGateways: Bool) -> [String: Any] {
    var o: [String: Any] = [
      "id": id,
      "mediaId": mediaId,
      "title": title,
      "subtitle": subtitle ?? NSNull(),
      "kind": kind,
      "seasonNumber": seasonNumber ?? NSNull(),
      "episodeNumber": episodeNumber ?? NSNull(),
      "quality": quality,
      "formatId": formatId,
      "codec": codec,
      "estimatedBytes": estimatedBytes,
      "totalObjects": totalObjects,
      "createdAt": createdAt,
      "status": status,
      "errorCode": errorCode ?? NSNull(),
      "errorMessage": errorMessage ?? NSNull(),
      "doneBytes": doneBytes,
      "doneObjects": doneObjects,
      "storedBytes": storedBytes,
      "completedAt": completedAt,
    ]
    if includeGateways { o["gatewayCandidates"] = gatewayCandidates }
    return o
  }
}

// MARK: - Engine

/// Process-wide offline download engine (iOS counterpart of Android's `DownloadEngine` + `DownloadService`).
///
/// Transfers run in a *background* `URLSession` so they continue while the app is suspended or was killed by
/// the system; `AppDelegate.application(_:handleEventsForBackgroundURLSession:)` hands the system completion
/// handler to `handleBackgroundEvents`. The persisted queue (`queue.json`) plus the on-disk object store are the
/// source of truth: after any relaunch the engine re-attaches to surviving tasks (`getAllTasks`) and schedules
/// whatever is still missing.
///
/// One `URLSessionUploadTask` per storage object. The tunnel download endpoint is `POST` with a JSON body, and
/// background sessions only support bodies for upload tasks (from a file), so each task uploads a tiny body file
/// and the response (the still-encrypted SFV1 envelope) is streamed to `<hash>.part` from the data delegate,
/// verified (length + `x-storage-tunnel-sha256`) and atomically renamed into the store.
///
/// Tunnel sessions expire 10 minutes after their last `session.start` frame and cannot be (re)created while the
/// app is suspended, so alongside the object tasks the engine schedules `session.start` keep-alive frames as
/// background tasks with `earliestBeginDate`; if a session still dies, the resulting 404s wake the app and a new
/// session is negotiated.
///
/// Everything below runs on `queue` (also the delegate queue of the background session).
public final class DownloadEngine: NSObject, URLSessionDataDelegate {
  public static let shared = DownloadEngine()
  /// `<bundle id>.downloads`: `com.spacebadger.mobile.downloads` for Badger, so its existing background session (and
  /// the tasks the system holds for it) carries over the move into this pod; each other app gets its own.
  static let sessionIdentifier = "\(Bundle.main.bundleIdentifier ?? "com.spacebadger.mobile").downloads"

  private static let maxInflight = 96
  private static let maxAttempts = 5
  private static let spaceReserveBytes: Int64 = 100 * 1024 * 1024
  private static let persistInterval: TimeInterval = 2
  private static let emitInterval: TimeInterval = 0.5
  private static let keepAliveInterval: TimeInterval = 240
  private static let keepAliveCount = 15
  /// Name suffix of the keep-alive armed while a silo holds the downloads (`armTrafficProbe`).
  private static let probeSuffix = "probe"
  private static let clientType = "client-mobile-download"
  private static let clientVersion = "spacebadger-mobile"

  /// Serial queue guarding all engine state; callers from outside must hop onto it.
  let queue = DispatchQueue(label: "\(DownloadEngine.sessionIdentifier).engine")

  /// Set by `DownloadsBridge`; receives the state JSON for the `SpaceDownloadsChanged` event.
  var listener: ((String) -> Void)?
  weak var listenerOwner: AnyObject?

  private struct Tunnel {
    let sessionId: String
    let baseURL: String
    let createdAt: Date
    /// The silo's report at session start; nil when the gateway sent none (or the session was adopted after a relaunch).
    var traffic: DownloadTrafficReport? = nil
  }

  private final class Runtime {
    let objects: [DownloadObject]
    let keys: Set<String>
    var remaining: Set<String>
    /// The current session; assigning one also records its gateway in `silo`.
    var tunnel: Tunnel? {
      didSet { if let tunnel { silo = tunnel.baseURL } }
    }
    /// Gateway base URL of the last session (kept while a new one negotiates): the silo whose traffic rules apply.
    private(set) var silo: String?
    var tunnelStarting = false
    var tunnelAttempts = 0
    var tunnelNotBefore = Date.distantPast

    init(objects: [DownloadObject], remaining: Set<String>) {
      self.objects = objects
      keys = Set(objects.map { $0.key })
      self.remaining = remaining
    }
  }

  private enum TaskInfo {
    case object(sessionId: String, key: String)
    case keepAlive(sessionId: String, name: String)

    static func parse(_ description: String?) -> TaskInfo? {
      guard let description else { return nil }
      let parts = description.split(separator: "|", maxSplits: 2, omittingEmptySubsequences: false)
      guard parts.count == 3 else { return nil }
      switch parts[0] {
      case "obj": return .object(sessionId: String(parts[1]), key: String(parts[2]))
      case "ka": return .keepAlive(sessionId: String(parts[1]), name: String(parts[2]))
      default: return nil
      }
    }
  }

  private let store = OfflineStore.shared
  private let controlSession: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.waitsForConnectivity = false
    config.timeoutIntervalForRequest = 15
    return URLSession(configuration: config)
  }()
  private var session: URLSession!
  private let monitor = NWPathMonitor()

  private var config: DownloadConfig?
  private var items: [String: DownloadItem] = [:]
  private var order: [String] = []
  private var runtimes: [String: Runtime] = [:]
  private var inflight: [String: URLSessionTask] = [:]
  private var attempts: [String: Int] = [:]
  private var notBefore: [String: Date] = [:]
  private var doomedKeys = Set<String>()

  /// One silo's load as the engine knows it (STOR-BW-01, STOR-BW-09), keyed by its gateway base URL: the report rides
  /// that gateway's sessions and its `GET /storage/traffic` answers for that silo alone.
  private struct SiloTraffic {
    var report = DownloadTrafficReport.normal
    /// The reduced rate's timeline, shared by every object downloading from this silo.
    var pacer = DownloadPacer()
    var lastRead = Date.distantPast
    var polling = false
  }

  // Traffic rules (STOR-BW-01, STOR-BW-09): each silo's last report and pacing timeline, and their upkeep.
  private var silos: [String: SiloTraffic] = [:]
  /// Keys whose in-flight task was scheduled for a later slot on a silo's pacing timeline (`earliestBeginDate`), with
  /// that silo.
  private var pacedKeys: [String: String] = [:]
  /// `GET /storage/traffic` reads still running; the system's background handler waits for them.
  private var trafficReadsInFlight = 0
  /// Sessions with a pending hold probe (`armTrafficProbe`).
  private var probeSessions = Set<String>()
  private var trafficTickScheduled = false
  private var lastTrafficState = "normal"
  // Self-healing (STOR-DECOM-02): failed downloads whose cause heals by itself are retried on a timer, not only at app start.
  private var healScheduled = false
  private var healFailures = 0
  /// Items the timer requeued: their repeated failures do not notify again.
  private var healedItems = Set<String>()

  private var writers: [Int: FileHandle] = [:]
  private var writeFailures: [Int: Error] = [:]

  private var lastPath: NWPath?
  private var networkAllowed = true
  private var statusWaiters: [() -> Void] = []

  private var lastPersist = Date.distantPast
  private var lastEmit = Date.distantPast
  private var trailingEmitScheduled = false

  private var pendingBackgroundHandlers: [() -> Void] = []
  /// `urlSessionDidFinishEvents` fired and its events are fully processed. It can arrive BEFORE
  /// `handleBackgroundEvents` stores the system handler (relaunch race), so it is remembered until a handler shows up.
  private var finishedEventsPending = false
  private var activeTunnelStarts = 0
  /// `reattach` has adopted (or cancelled) the previous process's tasks. Until then `pump` must not schedule
  /// anything: a fresh task would race the survivors for the same `.part` files.
  private var reattached = false

  private var queueURL: URL { store.rootDir.appendingPathComponent("queue.json") }

  override init() {
    super.init()
    loadQueue()
    let configuration = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
    configuration.isDiscretionary = false
    configuration.sessionSendsLaunchEvents = true
    configuration.allowsCellularAccess = true
    configuration.httpMaximumConnectionsPerHost = 3
    configuration.waitsForConnectivity = true
    let delegateQueue = OperationQueue()
    delegateQueue.maxConcurrentOperationCount = 1
    delegateQueue.underlyingQueue = queue
    session = URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
    monitor.pathUpdateHandler = { [weak self] path in self?.pathChanged(path) }
    monitor.start(queue: queue)
    // The completion handler runs on the delegate queue, whose underlying queue is `queue`: reattach right here,
    // with no extra hop that would let other `queue` work slip in between.
    session.getAllTasks { [weak self] tasks in
      self?.reattach(tasks)
      self?.scheduleHeal()
    }
    NSLog("[Downloads] engine.init items=%d active=%d", items.count, items.values.filter { $0.isActive }.count)
  }

  // MARK: Public API (call on `queue`)

  /// Labels in effect: the persisted/configured ones; none until JS configured the engine.
  private var currentLabels: DownloadLabels { config?.labels ?? DownloadLabels() }

  func configure(authToken: String, appId: String, wifiOnly: Bool, labelsJson: String) {
    let wifiChanged = config?.wifiOnly != wifiOnly
    let labels = DownloadLabels(jsonString: labelsJson)
    NSLog("[Downloads] labels.applied changed=%ld", labels == currentLabels ? 0 : 1)
    config = DownloadConfig(authToken: authToken, appId: appId, wifiOnly: wifiOnly, labels: labels)
    refreshNetwork()
    if wifiChanged {
      // `allowsCellularAccess` is a per-request property: recreate whatever is in flight under the new policy.
      for task in inflight.values { task.cancel() }
    }
    persist(force: true)
    emit(force: true)
    pump()
  }

  /// Adds (or revives a failed) item. Completed and already-active items are left alone.
  func enqueue(_ item: DownloadItem, objects: [DownloadObject]) {
    if let existing = items[item.id], existing.status == DownloadStatus.completed || existing.isActive {
      NSLog("[Downloads] enqueue.skip id=%@ status=%@", item.id, existing.status)
      return
    }
    saveObjects(item.id, objects)
    doomedKeys.subtract(objects.map { $0.key })
    // Reviving a failed item: its objects must not inherit the exhausted attempt counts / backoff of the failed run.
    for object in objects {
      attempts[object.key] = nil
      notBefore[object.key] = nil
    }
    items[item.id] = item
    order.removeAll { $0 == item.id }
    order.append(item.id)
    runtimes[item.id] = makeRuntime(item, objects: objects)
    persist(force: true)
    emit(force: true)
    NSLog("[Downloads] enqueue id=%@ title=%@ objects=%d done=%d", item.id, item.title, objects.count, item.doneObjects)
    DownloadNotifications.requestAuthorizationIfNeeded()
    pump()
  }

  /// Re-queues a failed item (optionally with refreshed gateway candidates).
  func retry(id: String, gatewayCandidates: [String]?) {
    guard let item = items[id], item.status == DownloadStatus.failed else { return }
    if let candidates = gatewayCandidates, !candidates.isEmpty { item.gatewayCandidates = candidates }
    healedItems.remove(id)
    requeue(item)
    persist(force: true)
    emit(force: true)
    pump()
  }

  /// Cancels (if running) and deletes the downloads and their files.
  func remove(ids: [String]) {
    for id in ids {
      guard let item = items[id] else { continue }
      let objects = runtimes[id]?.objects ?? loadObjects(id) ?? []
      if let tunnel = runtimes[id]?.tunnel { cancelKeepAlive(sessionId: tunnel.sessionId) }
      items[id] = nil
      order.removeAll { $0 == id }
      runtimes[id] = nil
      // Audio / subtitle objects are shared by every episode of a title: only delete the keys no other
      // download still lists.
      let others = order.map { otherId in runtimes[otherId]?.keys ?? Set((loadObjects(otherId) ?? []).map { $0.key }) }
      let doomed = OfflineInventory.keysToDelete(removing: objects, others: others)
      for key in doomed {
        doomedKeys.insert(key)
        inflight[key]?.cancel()
      }
      store.delete(keys: doomed)
      try? FileManager.default.removeItem(at: store.objectsListURL(forItem: id))
      NSLog("[Downloads] remove id=%@ status=%@ objects=%d deleting=%d", id, item.status, objects.count, doomed.count)
    }
    persist(force: true)
    emit(force: true)
    pump()
  }

  /// Called by JS at app start: restart whatever is unfinished.
  func resume() {
    for id in order {
      guard let item = items[id], item.status == DownloadStatus.failed else { continue }
      if item.errorCode == DownloadErrorCode.auth || item.errorCode == DownloadErrorCode.network {
        requeue(item)
      }
    }
    persist(force: true)
    emit(force: true)
    pump()
  }

  func stateJSON() -> String {
    var root: [String: Any] = [:]
    root["items"] = order.compactMap { items[$0]?.toJSON(includeGateways: false) }
    root["traffic"] = trafficState()
    root["networkAllowed"] = networkAllowed
    root["wifiOnly"] = config?.wifiOnly ?? true
    let data = (try? JSONSerialization.data(withJSONObject: root)) ?? Data("{}".utf8)
    return String(decoding: data, as: UTF8.self)
  }

  /// Complete downloads with their size on disk (OFFL-MANAGE-01); shared objects count once in the total.
  func listItems() -> OfflineInventory {
    let completed = order.compactMap { id -> (id: String, completedAt: Int64)? in
      guard let item = items[id], item.status == DownloadStatus.completed else { return nil }
      return (id: id, completedAt: item.completedAt)
    }
    let inventory = OfflineInventory.compute(
      completed: completed,
      objectsOf: { self.loadObjects($0) },
      sizeOf: { self.store.sizeOf($0) }
    )
    NSLog("[Downloads] inventory items=%d totalBytes=%lld", inventory.items.count, inventory.totalBytes)
    return inventory
  }

  /// Cancels and deletes every download, finished or not (Settings › "Remove all", OFFL-MANAGE-01).
  func removeAll() {
    NSLog("[Downloads] remove.all count=%d", order.count)
    remove(ids: order)
  }

  /// `{ networkType, freeBytes }`. Waits (briefly) for the first network path update after launch.
  func statusJSON(_ completion: @escaping (String) -> Void) {
    let reply = { [self] in
      let root: [String: Any] = ["networkType": networkType(), "freeBytes": store.freeBytes()]
      let data = (try? JSONSerialization.data(withJSONObject: root)) ?? Data("{}".utf8)
      completion(String(decoding: data, as: UTF8.self))
    }
    if lastPath != nil {
      reply()
      return
    }
    statusWaiters.append(reply)
    queue.asyncAfter(deadline: .now() + 1.5) { [weak self] in
      guard let self, !self.statusWaiters.isEmpty else { return }
      let waiters = self.statusWaiters
      self.statusWaiters = []
      waiters.forEach { $0() }
    }
  }

  /// Called from `AppDelegate.application(_:handleEventsForBackgroundURLSession:completionHandler:)`.
  public func handleBackgroundEvents(identifier: String, completion: @escaping () -> Void) {
    guard identifier == Self.sessionIdentifier else {
      completion()
      return
    }
    queue.async {
      self.pendingBackgroundHandlers.append(completion)
      // The events may already have been delivered: nothing else would ever release this handler.
      self.flushBackgroundHandlersIfIdle()
    }
  }

  // MARK: Startup

  private func loadQueue() {
    guard
      let data = try? Data(contentsOf: queueURL),
      let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    else { return }
    if let c = root["config"] as? [String: Any] {
      config = DownloadConfig(
        authToken: jsonString(c, "authToken") ?? "",
        appId: jsonString(c, "appId") ?? "badger",
        wifiOnly: (c["wifiOnly"] as? Bool) ?? true,
        // Absent in a queue.json written before labels existed: no labels, Localizable.strings applies.
        labels: DownloadLabels(json: c["labels"] as? [String: Any])
      )
    }
    for case let o as [String: Any] in (root["items"] as? [Any]) ?? [] {
      guard let item = DownloadItem(json: o) else { continue }
      if item.isActive {
        // The tasks of a previous process are re-attached by `reattach`; until then every unfinished item
        // is queued and its remaining objects are recomputed from disk.
        item.status = DownloadStatus.queued
        if let objects = loadObjects(item.id) {
          runtimes[item.id] = makeRuntime(item, objects: objects)
        } else {
          item.status = DownloadStatus.failed
          item.errorCode = DownloadErrorCode.storage
          item.errorMessage = "object_list_missing"
        }
      }
      items[item.id] = item
      order.append(item.id)
    }
  }

  private func reattach(_ tasks: [URLSessionTask]) {
    var live = Set<String>()
    var adopted = Set<String>()
    for task in tasks {
      guard case .object(let sid, let key)? = TaskInfo.parse(task.taskDescription) else { continue }
      // Already finished: its result goes through `didCompleteWithError`, never adopt it as in flight.
      if task.state == .completed { continue }
      let owners = order.compactMap { runtimes[$0] }.filter { $0.remaining.contains(key) }
      if owners.isEmpty || inflight[key] != nil || doomedKeys.contains(key) {
        task.cancel()
        continue
      }
      inflight[key] = task
      live.insert(key)
      // The surviving task still carries its session: adopt it so the keep-alive frames (and the base URL) carry on.
      let suffix = "/storage/tunnel/download"
      if let url = task.originalRequest?.url?.absoluteString, url.hasSuffix(suffix) {
        for rt in owners where rt.tunnel == nil {
          rt.tunnel = Tunnel(sessionId: sid, baseURL: String(url.dropLast(suffix.count)), createdAt: .distantPast)
          adopted.insert(sid)
        }
      }
    }
    for task in tasks {
      switch TaskInfo.parse(task.taskDescription) {
      case .keepAlive(let sid, _)? where adopted.contains(sid): break
      case .object?: break
      default: task.cancel()
      }
    }
    if tasks.isEmpty { store.wipeBodies() }
    store.sweepPartials(keeping: live)
    NSLog("[Downloads] reattach tasks=%d live=%d", tasks.count, live.count)
    reattached = true
    pump()
  }

  private func makeRuntime(_ item: DownloadItem, objects: [DownloadObject]) -> Runtime {
    var remaining = Set<String>()
    var doneBytes: Int64 = 0
    for object in objects {
      if store.has(object.key) {
        doneBytes += store.sizeOf(object.key)
      } else {
        remaining.insert(object.key)
      }
    }
    item.doneObjects = Set(objects.map { $0.key }).count - remaining.count
    item.doneBytes = doneBytes
    return Runtime(objects: objects, remaining: remaining)
  }

  private func requeue(_ item: DownloadItem) {
    item.status = DownloadStatus.queued
    item.errorCode = nil
    item.errorMessage = nil
    attempts.removeAll()
    if let objects = loadObjects(item.id) {
      runtimes[item.id] = makeRuntime(item, objects: objects)
    } else {
      item.status = DownloadStatus.failed
      item.errorCode = DownloadErrorCode.storage
      item.errorMessage = "object_list_missing"
    }
  }

  // MARK: Scheduling

  private func pump() {
    guard reattached else { return }  // `reattach` pumps once it has settled the surviving tasks
    guard let cfg = config, !cfg.authToken.isEmpty else {
      for id in order {
        if let item = items[id], item.isActive { fail(item, DownloadErrorCode.auth, "no_auth_token") }
      }
      return
    }
    settleTrafficIfIdle()
    if items.values.contains(where: { $0.isActive }) {
      // A high or saturated state can start or lift mid-item: each silo's report is re-read once a minute while anything
      // downloads. The tick only fires in the foreground; in the background the engine wakes on its tasks' completions
      // (objects, keep-alives, hold probes).
      refreshTraffic(cfg)
      armTrafficTick()
    }
    var budget = Self.maxInflight - inflight.count
    let now = Date()
    for id in order {
      guard let item = items[id], item.isActive else { continue }
      guard let rt = runtimes[id] else {
        fail(item, DownloadErrorCode.storage, "object_list_missing")
        continue
      }
      if rt.remaining.isEmpty {
        complete(item)
        continue
      }
      let hasInflight = rt.remaining.contains { inflight[$0] != nil }
      if budget <= 0 && !hasInflight { continue }  // stays queued behind the items ahead of it
      if item.status == DownloadStatus.queued {
        let remainingBytes = rt.objects.filter { rt.remaining.contains($0.key) }.reduce(Int64(0)) { $0 + $1.size }
        let free = store.freeBytes()
        if free < remainingBytes + Self.spaceReserveBytes {
          fail(item, DownloadErrorCode.insufficientSpace, "need=\(remainingBytes) free=\(free)")
          continue
        }
        setStatus(item, networkAllowed ? DownloadStatus.downloading : DownloadStatus.waitingNetwork)
        NSLog("[Downloads] item.start id=%@ pending=%d/%d remainingBytes=%lld", id, rt.remaining.count, rt.keys.count, remainingBytes)
      }
      let unscheduled = rt.objects.filter { object in
        rt.remaining.contains(object.key) && inflight[object.key] == nil && (notBefore[object.key] ?? .distantPast) <= now
      }
      if unscheduled.isEmpty || budget <= 0 { continue }
      guard let tunnel = rt.tunnel else {
        startTunnel(item, rt, cfg)
        continue
      }
      let silo = siloReport(tunnel.baseURL)
      // STOR-BW-09: a saturated silo gives an offline download zero bytes, so nothing is requested until it lifts.
      if silo.saturated {
        armTrafficProbe(tunnel, cfg)
        continue
      }
      for object in unscheduled {
        if budget <= 0 { break }
        // STOR-BW-01: while the silo is high every object waits for its slot on that silo's 4 Mbit/s timeline; never
        // stopped. The wait rides the background task (`earliestBeginDate`), so it holds while the app is suspended.
        let wait = silo.high ? silos[tunnel.baseURL, default: SiloTraffic()].pacer.reserve(bytes: object.size, now: now) : 0
        if wait > 0 {
          pacedKeys[object.key] = tunnel.baseURL
          schedule(object.key, tunnel, cfg, beginAt: now.addingTimeInterval(wait))
        } else {
          schedule(object.key, tunnel, cfg)
        }
        budget -= 1
      }
    }
  }

  private func schedule(_ key: String, _ tunnel: Tunnel, _ cfg: DownloadConfig, beginAt: Date? = nil) {
    guard let url = URL(string: tunnel.baseURL + "/storage/tunnel/download") else { return }
    store.removePart(forKey: key)
    let bodyURL = store.bodyURL(named: OfflineStore.hashKey(key) + ".json")
    let body: [String: Any] = ["sessionId": tunnel.sessionId, "objectKey": key]
    guard let data = try? JSONSerialization.data(withJSONObject: body), (try? data.write(to: bodyURL, options: .atomic)) != nil else {
      NSLog("[Downloads] schedule.body_failed key=%@", key)
      return
    }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.allowsCellularAccess = !cfg.wifiOnly
    request.setValue("Bearer \(cfg.authToken)", forHTTPHeaderField: "Authorization")
    request.setValue(cfg.appId, forHTTPHeaderField: "x-space-app")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    let task = session.uploadTask(with: request, fromFile: bodyURL)
    task.taskDescription = "obj|\(tunnel.sessionId)|\(key)"
    task.earliestBeginDate = beginAt
    inflight[key] = task
    task.resume()
  }

  // MARK: Tunnel session

  private func startTunnel(_ item: DownloadItem, _ rt: Runtime, _ cfg: DownloadConfig) {
    guard !rt.tunnelStarting, rt.tunnelNotBefore <= Date() else { return }
    guard networkAllowed else { return }
    rt.tunnelStarting = true
    activeTunnelStarts += 1
    let id = item.id
    openTunnel(candidates: item.gatewayCandidates, cfg: cfg, index: 0, failures: []) { [weak self] tunnel, failures in
      guard let self else { return }
      self.queue.async {
        self.activeTunnelStarts -= 1
        defer { self.flushBackgroundHandlersIfIdle() }
        guard let item = self.items[id], let rt = self.runtimes[id], item.isActive else { return }
        rt.tunnelStarting = false
        if let tunnel {
          rt.tunnel = tunnel
          rt.tunnelAttempts = 0
          // A session that carries no report leaves the silo's last known state unchanged.
          if let report = tunnel.traffic { self.applyTraffic(report, silo: tunnel.baseURL) }
          NSLog("[Downloads] tunnel.open id=%@ base=%@ sid=%@", id, tunnel.baseURL, tunnel.sessionId)
          self.armKeepAlive(tunnel, cfg)
          self.pump()
          return
        }
        let summary = failures.joined(separator: "; ")
        if failures.contains(where: { $0.range(of: "tunnel_(session_failed|session_start_failed): (401|403)", options: .regularExpression) != nil }) {
          self.fail(item, DownloadErrorCode.auth, "tunnel_session_all_candidates_failed: \(summary)")
          return
        }
        if !self.networkAllowed { return }
        rt.tunnelAttempts += 1
        NSLog("[Downloads] tunnel.failed id=%@ attempt=%d %@", id, rt.tunnelAttempts, summary)
        if rt.tunnelAttempts >= Self.maxAttempts {
          self.fail(item, DownloadErrorCode.network, "tunnel_session_all_candidates_failed: \(summary)")
          return
        }
        let delay = min(8.0, Double(1 << (rt.tunnelAttempts - 1)))
        rt.tunnelNotBefore = Date().addingTimeInterval(delay)
        self.queue.asyncAfter(deadline: .now() + delay) { [weak self] in self?.pump() }
      }
    }
  }

  /// Walks the gateway candidates in order (3 s per request, like Android's waterfall) and opens + starts a session.
  private func openTunnel(
    candidates: [String],
    cfg: DownloadConfig,
    index: Int,
    failures: [String],
    completion: @escaping (Tunnel?, [String]) -> Void
  ) {
    guard index < candidates.count else {
      completion(nil, failures)
      return
    }
    let base = candidates[index]
    let next = { (why: String) in
      self.openTunnel(candidates: candidates, cfg: cfg, index: index + 1, failures: failures + ["\(base) -> \(why)"], completion: completion)
    }
    guard let sessionURL = URL(string: base + "/storage/tunnel/session"), let frameURL = URL(string: base + "/storage/tunnel/frame") else {
      next("invalid_url")
      return
    }
    // Offline downloads are export-class flows: held with zero bytes while the silo is saturated, resumed by the gateway (STOR-BW-09).
    post(sessionURL, cfg, json: ["purpose": "export"]) { [self] status, payload, error in
      guard let payload, status / 100 == 2 else {
        next(error ?? "tunnel_session_failed: \(status)")
        return
      }
      guard let sid = payload["sessionId"] as? String, !sid.isEmpty else {
        next("tunnel_session_missing_id")
        return
      }
      let sessionTraffic = DownloadTrafficReport.parse(payload["traffic"])
      let frame: [String: Any] = [
        "kind": "session.start", "sessionId": sid, "token": cfg.authToken,
        "clientType": Self.clientType, "clientVersion": Self.clientVersion,
      ]
      post(frameURL, cfg, json: ["sessionId": sid, "frame": frame]) { status, payload, error in
        guard let payload, status / 100 == 2 else {
          next(error ?? "tunnel_session_start_failed: \(status)")
          return
        }
        let frameObject = payload["frame"] as? [String: Any]
        let ack = frameObject?["kind"] as? String ?? ""
        guard ack == "session.ack" else {
          next("tunnel_session_start_unexpected_frame: \(ack)")
          return
        }
        let report = DownloadTrafficReport.parse(frameObject?["traffic"]) ?? sessionTraffic
        completion(Tunnel(sessionId: sid, baseURL: base, createdAt: Date(), traffic: report), failures)
      }
    }
  }

  /// `done(httpStatus, jsonBody, errorText)`; errorText is `tunnel_session_failed: <status>` style for non-2xx.
  private func post(_ url: URL, _ cfg: DownloadConfig, json: [String: Any], done: @escaping (Int, [String: Any]?, String?) -> Void) {
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.timeoutInterval = 3
    request.setValue("Bearer \(cfg.authToken)", forHTTPHeaderField: "Authorization")
    request.setValue(cfg.appId, forHTTPHeaderField: "x-space-app")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: json)
    let label = url.path.hasSuffix("/session") ? "tunnel_session_failed" : "tunnel_session_start_failed"
    controlSession.dataTask(with: request) { data, response, error in
      if let error {
        done(0, nil, "\(label): \(error.localizedDescription)")
        return
      }
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      let payload = data.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
      done(status, payload, status / 100 == 2 ? nil : "\(label): \(status)")
    }.resume()
  }

  /// Background `session.start` frames spaced under the 10 min session TTL, so a session survives while the
  /// app is suspended and cannot make requests itself.
  private func armKeepAlive(_ tunnel: Tunnel, _ cfg: DownloadConfig) {
    let now = Date()
    for n in 1...Self.keepAliveCount {
      scheduleKeepAlive(tunnel, cfg, name: "ka-\(tunnel.sessionId)-\(n)", beginAt: now.addingTimeInterval(Self.keepAliveInterval * Double(n)))
    }
  }

  /// One background `session.start` frame on `tunnel`, sent no sooner than `beginAt`.
  private func scheduleKeepAlive(_ tunnel: Tunnel, _ cfg: DownloadConfig, name: String, beginAt: Date) {
    guard let url = URL(string: tunnel.baseURL + "/storage/tunnel/frame") else { return }
    let frame: [String: Any] = [
      "kind": "session.start", "sessionId": tunnel.sessionId, "token": cfg.authToken,
      "clientType": Self.clientType, "clientVersion": Self.clientVersion,
    ]
    guard let body = try? JSONSerialization.data(withJSONObject: ["sessionId": tunnel.sessionId, "frame": frame]) else { return }
    let bodyURL = store.bodyURL(named: name + ".json")
    guard (try? body.write(to: bodyURL, options: .atomic)) != nil else { return }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("Bearer \(cfg.authToken)", forHTTPHeaderField: "Authorization")
    request.setValue(cfg.appId, forHTTPHeaderField: "x-space-app")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.allowsCellularAccess = !cfg.wifiOnly
    let task = session.uploadTask(with: request, fromFile: bodyURL)
    task.taskDescription = "ka|\(tunnel.sessionId)|\(name)"
    task.earliestBeginDate = beginAt
    task.resume()
  }

  private func cancelKeepAlive(sessionId: String) {
    session.getAllTasks { tasks in
      for task in tasks {
        if case .keepAlive(let sid, _)? = TaskInfo.parse(task.taskDescription), sid == sessionId { task.cancel() }
      }
    }
  }

  // MARK: Transitions

  private func setStatus(_ item: DownloadItem, _ status: String) {
    item.status = status
    if status == DownloadStatus.downloading {
      item.errorCode = nil
      item.errorMessage = nil
    }
    persist(force: true)
    emit(force: true)
  }

  private func complete(_ item: DownloadItem) {
    guard let rt = runtimes[item.id] else { return }
    let stored = rt.objects.reduce(Int64(0)) { $0 + store.sizeOf($1.key) }
    item.storedBytes = stored
    item.doneBytes = stored
    item.doneObjects = rt.keys.count
    item.status = DownloadStatus.completed
    item.errorCode = nil
    item.errorMessage = nil
    item.completedAt = nowMs()
    healedItems.remove(item.id)
    healFailures = 0
    if let tunnel = rt.tunnel { cancelKeepAlive(sessionId: tunnel.sessionId) }
    runtimes[item.id] = nil
    persist(force: true)
    emit(force: true)
    DownloadNotifications.post(completed: item, labels: currentLabels)
    NSLog("[Downloads] item.completed id=%@ storedBytes=%lld objects=%d", item.id, stored, rt.keys.count)
  }

  private func fail(_ item: DownloadItem, _ code: String, _ message: String) {
    guard items[item.id] != nil else { return }
    if let rt = runtimes[item.id] {
      if let tunnel = rt.tunnel { cancelKeepAlive(sessionId: tunnel.sessionId) }
      // Stop transfers only this item needed; the objects already on disk stay for a later retry.
      var neededElsewhere = Set<String>()
      for (otherId, other) in runtimes where otherId != item.id { neededElsewhere.formUnion(other.remaining) }
      for key in rt.keys where !neededElsewhere.contains(key) { inflight[key]?.cancel() }
      runtimes[item.id] = nil
    }
    item.status = DownloadStatus.failed
    item.errorCode = code
    item.errorMessage = message
    persist(force: true)
    emit(force: true)
    // A download the timer retried fails quietly again: the viewer was told once.
    if !healedItems.contains(item.id) { DownloadNotifications.post(failed: item, labels: currentLabels) }
    scheduleHeal()
    NSLog("[Downloads] item.failed id=%@ code=%@ message=%@", item.id, code, message)
  }

  private func failItems(containing key: String, _ code: String, _ message: String) {
    for id in order {
      guard let item = items[id], item.isActive, runtimes[id]?.keys.contains(key) == true else { continue }
      fail(item, code, message)
    }
  }

  private func onObjectDone(_ key: String, bytes: Int64) {
    attempts[key] = nil
    notBefore[key] = nil
    healFailures = 0
    for id in order {
      guard let item = items[id], item.isActive, let rt = runtimes[id], rt.remaining.remove(key) != nil else { continue }
      item.doneBytes += bytes
      item.doneObjects += 1
      if rt.remaining.isEmpty { complete(item) }
    }
    persist(force: false)
    emit(force: false)
    pump()
  }

  // MARK: Task results

  private func finishTask(_ task: URLSessionTask, error: Error?) {
    closeWriter(task.taskIdentifier)
    let writeFailure = writeFailures.removeValue(forKey: task.taskIdentifier)
    guard let info = TaskInfo.parse(task.taskDescription) else { return }
    switch info {
    case .keepAlive(let sid, let name):
      try? FileManager.default.removeItem(at: store.bodyURL(named: name + ".json"))
      if name.hasSuffix("-\(Self.probeSuffix)") { probeSessions.remove(sid) }
      // In the background a keep-alive is what wakes the engine: re-read the silos' reports (at most once a minute) and
      // resume what a lifted hold allows (STOR-BW-09). A cancelled keep-alive (session dropped) wakes nothing.
      let cancelled = (error as NSError?).map { $0.domain == NSURLErrorDomain && $0.code == NSURLErrorCancelled } ?? false
      if !cancelled, items.values.contains(where: { $0.isActive }) { pump() }
    case .object(let sid, let key):
      if let current = inflight[key], current.taskIdentifier == task.taskIdentifier {
        inflight[key] = nil
        pacedKeys[key] = nil
        try? FileManager.default.removeItem(at: store.bodyURL(named: OfflineStore.hashKey(key) + ".json"))
      } else if reattached {
        // Stale task (survivor cancelled by `reattach`, or superseded): its result must not touch the `.part` or the
        // retry state owned by the current task for this key. The body is per key, so only drop it when no task owns it.
        if inflight[key] == nil {
          try? FileManager.default.removeItem(at: store.bodyURL(named: OfflineStore.hashKey(key) + ".json"))
        }
        return
      }
      handleObjectResult(task, sid: sid, key: key, error: writeFailure ?? error)
    }
  }

  private func handleObjectResult(_ task: URLSessionTask, sid: String, key: String, error: Error?) {
    if doomedKeys.contains(key) {
      store.removePart(forKey: key)
      store.delete(keys: [key])
      pump()
      return
    }
    if let error {
      store.removePart(forKey: key)
      let ns = error as NSError
      if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled {
        pump()  // cancelled on purpose (remove / policy change / failed item): reschedule only what is still needed
        return
      }
      if isNoSpace(ns) {
        failItems(containing: key, DownloadErrorCode.insufficientSpace, ns.localizedDescription)
        return
      }
      if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorTimedOut {
        objectTimedOut(key, sid: sid, message: ns.localizedDescription)
        return
      }
      keyAttemptFailed(key, sid: sid, message: ns.localizedDescription, countsAttempt: true)
      return
    }
    let http = task.response as? HTTPURLResponse
    let status = http?.statusCode ?? 0
    if !(200..<300).contains(status) {
      store.removePart(forKey: key)
      let message = "tunnel_download_failed: \(status) key=\(key)"
      if status == 401 || status == 403 {
        failItems(containing: key, DownloadErrorCode.auth, message)
      } else if status == 404 {
        // `invalid_session`: the tunnel session expired. Drop it so the next pump negotiates a new one; the
        // attempt only counts when the failed task already used the current session.
        var usedCurrent = false
        for id in order {
          guard let rt = runtimes[id], rt.keys.contains(key), let tunnel = rt.tunnel, tunnel.sessionId == sid else { continue }
          usedCurrent = true
          cancelKeepAlive(sessionId: sid)
          rt.tunnel = nil
        }
        keyAttemptFailed(key, sid: sid, message: message, countsAttempt: usedCurrent)
      } else {
        keyAttemptFailed(key, sid: sid, message: message, countsAttempt: true)
      }
      return
    }
    let size = store.partSize(forKey: key)
    let expected = http?.expectedContentLength ?? -1
    if expected >= 0 && size != expected {
      store.removePart(forKey: key)
      keyAttemptFailed(key, sid: sid, message: "tunnel_download_truncated: \(size)/\(expected) key=\(key)", countsAttempt: true)
      return
    }
    if let wanted = http?.value(forHTTPHeaderField: "x-storage-tunnel-sha256")?.lowercased(), !wanted.isEmpty {
      let actual = try? OfflineStore.sha256Hex(ofFile: store.partURL(forKey: key))
      if actual != wanted {
        store.removePart(forKey: key)
        keyAttemptFailed(key, sid: sid, message: "tunnel_download_checksum_mismatch key=\(key)", countsAttempt: true)
        return
      }
    }
    do {
      try store.commitPart(forKey: key)
    } catch {
      store.removePart(forKey: key)
      let ns = error as NSError
      failItems(
        containing: key,
        isNoSpace(ns) ? DownloadErrorCode.insufficientSpace : DownloadErrorCode.storage,
        ns.localizedDescription
      )
      return
    }
    onObjectDone(key, bytes: size)
  }

  // MARK: Traffic (STOR-BW-01, STOR-BW-09)

  /// The silos the active items download from (their gateway base URLs).
  private func activeSilos() -> Set<String> {
    var bases = Set<String>()
    for id in order {
      if let item = items[id], item.isActive, let base = runtimes[id]?.silo { bases.insert(base) }
    }
    return bases
  }

  private func siloReport(_ base: String) -> DownloadTrafficReport { silos[base]?.report ?? .normal }

  /// The `traffic` field of the state JSON, over the silos the active items download from: held when any of them is
  /// saturated, slowed when any is high (the clients' merge rule).
  private func trafficState() -> String {
    let reports = activeSilos().map { siloReport($0) }
    return DownloadTrafficPolicy.state(held: reports.contains { $0.saturated }, slowed: reports.contains { $0.high })
  }

  /// A read went silent. The gateway holds an export flow's bytes while its silo is saturated, so then it is not a
  /// failed attempt: the silo's own report decides, and the download waits for it to lift instead of failing `network`.
  private func objectTimedOut(_ key: String, sid: String, message: String) {
    let base = runtimes.values.first { $0.keys.contains(key) && $0.silo != nil }?.silo
    if let base, siloReport(base).saturated {
      NSLog("[Downloads] object.held key=%@: read timed out while the silo is saturated", key)
      keyAttemptFailed(key, sid: sid, message: message, countsAttempt: false)
      return
    }
    guard let cfg = config, let base else {
      keyAttemptFailed(key, sid: sid, message: message, countsAttempt: true)
      return
    }
    readTraffic(base, cfg) { report in
      NSLog("[Downloads] object.timeout key=%@ saturated=%ld", key, report?.saturated == true ? 1 : 0)
      self.keyAttemptFailed(key, sid: sid, message: message, countsAttempt: !(report?.saturated == true))
    }
  }

  /// `GET /storage/traffic` on the gateway `base`, which answers for its own silo; the report (nil when unreadable) is
  /// applied to that silo, then handed to `done` on `queue`. The system's background handler waits for it.
  private func readTraffic(_ base: String, _ cfg: DownloadConfig, done: @escaping (DownloadTrafficReport?) -> Void) {
    guard let url = URL(string: base + "/storage/traffic") else {
      done(nil)
      return
    }
    var request = URLRequest(url: url)
    request.timeoutInterval = 3
    request.setValue("Bearer \(cfg.authToken)", forHTTPHeaderField: "Authorization")
    request.setValue(cfg.appId, forHTTPHeaderField: "x-space-app")
    trafficReadsInFlight += 1
    controlSession.dataTask(with: request) { [weak self] data, response, _ in
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      let body = data.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
      let report = status / 100 == 2 ? DownloadTrafficReport.parse(body?["traffic"]) : nil
      guard let self else { return }
      self.queue.async {
        self.trafficReadsInFlight -= 1
        defer { self.flushBackgroundHandlersIfIdle() }
        if let report { self.applyTraffic(report, silo: base) }
        done(report)
      }
    }.resume()
  }

  /// Re-reads each active silo's report, at most once a minute per silo, while anything downloads: a session reports only
  /// when it opens, so the engine hears of a state that starts or lifts mid-item no other way.
  private func refreshTraffic(_ cfg: DownloadConfig) {
    let now = Date()
    for base in activeSilos() {
      let silo = silos[base] ?? SiloTraffic()
      guard !silo.polling, now.timeIntervalSince(silo.lastRead) >= DownloadTrafficPolicy.trafficPollInterval else { continue }
      silos[base, default: SiloTraffic()].polling = true
      readTraffic(base, cfg) { _ in
        self.silos[base]?.polling = false
        self.silos[base]?.lastRead = Date()
        self.pump()
      }
    }
  }

  /// One pump a minute while anything downloads, so the reports are re-read in the foreground even when nothing else wakes
  /// the engine.
  private func armTrafficTick() {
    guard !trafficTickScheduled else { return }
    trafficTickScheduled = true
    queue.asyncAfter(deadline: .now() + DownloadTrafficPolicy.trafficPollInterval + 1) { [weak self] in
      guard let self else { return }
      self.trafficTickScheduled = false
      self.pump()
    }
  }

  /// STOR-BW-09: while a silo holds the downloads, one extra keep-alive a minute ahead on its session, so a suspended app
  /// is woken to re-read the report (`finishTask` pumps on every keep-alive) rather than at the next spaced keep-alive.
  private func armTrafficProbe(_ tunnel: Tunnel, _ cfg: DownloadConfig) {
    guard probeSessions.insert(tunnel.sessionId).inserted else { return }
    let beginAt = Date().addingTimeInterval(DownloadTrafficPolicy.trafficPollInterval)
    scheduleKeepAlive(tunnel, cfg, name: "ka-\(tunnel.sessionId)-\(Self.probeSuffix)", beginAt: beginAt)
  }

  private func applyTraffic(_ report: DownloadTrafficReport, silo base: String) {
    var silo = silos[base] ?? SiloTraffic()
    if silo.report.high && !report.high {
      // Slots reserved on the reduced rate's timeline no longer apply.
      silo.pacer = DownloadPacer()
    }
    silo.report = report
    silo.lastRead = Date()
    silos[base] = silo
    if !report.high || report.saturated {
      // The reduced rate is over or the silo holds everything: its paced tasks that have not begun lose their slot. The
      // cancellation repumps them (`handleObjectResult`), sent at once when traffic is normal, held when saturated.
      for (key, keyBase) in pacedKeys where keyBase == base {
        if let task = inflight[key], let begin = task.earliestBeginDate, begin > Date() { task.cancel() }
        pacedKeys[key] = nil
      }
    }
    let state = trafficState()
    if state != lastTrafficState {
      NSLog("[Downloads] traffic.state %@ -> %@ silo=%@", lastTrafficState, state, base)
      lastTrafficState = state
      emit(force: true)
      pump()
    }
  }

  /// With nothing left to download no restriction applies; the next session reports afresh.
  private func settleTrafficIfIdle() {
    guard !silos.isEmpty, !items.values.contains(where: { $0.isActive }) else { return }
    silos.removeAll()
    pacedKeys.removeAll()
    if lastTrafficState != "normal" {
      lastTrafficState = "normal"
      emit(force: true)
    }
  }

  // MARK: Self-healing (STOR-DECOM-02)

  /// Arms one retry of the failed items whose cause heals by itself; the delay grows while they keep failing.
  private func scheduleHeal() {
    guard !healScheduled else { return }
    guard items.values.contains(where: { $0.status == DownloadStatus.failed && DownloadTrafficPolicy.isHealable($0.errorCode) }) else { return }
    healScheduled = true
    healFailures += 1
    let delay = DownloadTrafficPolicy.healDelay(healFailures)
    NSLog("[Downloads] heal.scheduled inSec=%.0f consecutive=%ld", delay, healFailures)
    queue.asyncAfter(deadline: .now() + delay) { [weak self] in self?.healFailed() }
  }

  private func healFailed() {
    healScheduled = false
    var requeued = 0
    for id in order {
      guard let item = items[id], item.status == DownloadStatus.failed, DownloadTrafficPolicy.isHealable(item.errorCode) else { continue }
      healedItems.insert(id)
      requeue(item)
      requeued += 1
    }
    if requeued == 0 {
      healFailures = 0
      return
    }
    NSLog("[Downloads] heal.retry items=%ld", requeued)
    persist(force: true)
    emit(force: true)
    pump()
  }

  private func keyAttemptFailed(_ key: String, sid: String, message: String, countsAttempt: Bool) {
    let n = (attempts[key] ?? 0) + (countsAttempt ? 1 : 0)
    attempts[key] = n
    NSLog("[Downloads] object.fetch_failed attempt=%d err=%@", n, message)
    if n >= Self.maxAttempts {
      failItems(containing: key, DownloadErrorCode.network, message)
      return
    }
    let delay = countsAttempt ? min(8.0, Double(1 << max(0, n - 1))) : 0
    if delay > 0 {
      notBefore[key] = Date().addingTimeInterval(delay)
      queue.asyncAfter(deadline: .now() + delay) { [weak self] in self?.pump() }
    }
    pump()
  }

  private func isNoSpace(_ error: NSError) -> Bool {
    if error.domain == NSPOSIXErrorDomain && error.code == Int(ENOSPC) { return true }
    if error.domain == NSCocoaErrorDomain && error.code == NSFileWriteOutOfSpaceError { return true }
    if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError { return isNoSpace(underlying) }
    return false
  }

  // MARK: URLSessionDataDelegate / URLSessionTaskDelegate

  public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard case .object(_, let key)? = TaskInfo.parse(dataTask.taskDescription) else { return }
    guard let http = dataTask.response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return }
    let id = dataTask.taskIdentifier
    // A stale task (cancelled survivor, superseded) must not append to the `.part` the current task owns.
    if reattached, inflight[key]?.taskIdentifier != id { return }
    if writeFailures[id] != nil { return }
    do {
      let handle: FileHandle
      if let open = writers[id] {
        handle = open
      } else {
        let url = store.partURL(forKey: key)
        if !FileManager.default.fileExists(atPath: url.path) {
          FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        handle = try FileHandle(forWritingTo: url)
        // First data seen by this process for the task: align the file with what the system already
        // delivered to a previous process (if anything), then append.
        let offset = max(0, dataTask.countOfBytesReceived - Int64(data.count))
        let end = try handle.seekToEnd()
        let size = Int64(end)
        if size > offset {
          try handle.truncate(atOffset: UInt64(offset))
          try handle.seek(toOffset: UInt64(offset))
        }
        writers[id] = handle
      }
      try handle.write(contentsOf: data)
    } catch {
      writeFailures[id] = error
      closeWriter(id)
      dataTask.cancel()
    }
  }

  public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    finishTask(task, error: error)
  }

  public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    finishedEventsPending = true
    flushBackgroundHandlersIfIdle()
  }

  private func closeWriter(_ id: Int) {
    if let handle = writers.removeValue(forKey: id) { try? handle.close() }
  }

  /// The system handler must be called once all events were processed; hold it while a (foreground-session)
  /// tunnel negotiation or traffic read triggered by those events is still running, so it gets the wake-up time it needs.
  private func flushBackgroundHandlersIfIdle() {
    guard finishedEventsPending, activeTunnelStarts == 0, trafficReadsInFlight == 0, !pendingBackgroundHandlers.isEmpty else { return }
    flushBackgroundHandlers()
  }

  private func flushBackgroundHandlers() {
    finishedEventsPending = false
    let handlers = pendingBackgroundHandlers
    pendingBackgroundHandlers = []
    DispatchQueue.main.async { handlers.forEach { $0() } }
  }

  // MARK: Network

  private func pathChanged(_ path: NWPath) {
    lastPath = path
    let waiters = statusWaiters
    statusWaiters = []
    waiters.forEach { $0() }
    refreshNetwork()
  }

  private func computeAllowed(_ path: NWPath) -> Bool {
    guard path.status == .satisfied else { return false }
    guard config?.wifiOnly ?? true else { return true }
    let cellularOnly = path.usesInterfaceType(.cellular) && !path.usesInterfaceType(.wifi) && !path.usesInterfaceType(.wiredEthernet)
    return !cellularOnly
  }

  private func refreshNetwork() {
    guard let path = lastPath else { return }
    let allowed = computeAllowed(path)
    guard allowed != networkAllowed else { return }
    networkAllowed = allowed
    NSLog("[Downloads] network.allowed=%d type=%@ wifiOnly=%d", allowed ? 1 : 0, networkType(), (config?.wifiOnly ?? true) ? 1 : 0)
    for id in order {
      guard let item = items[id] else { continue }
      if allowed && item.status == DownloadStatus.waitingNetwork { item.status = DownloadStatus.downloading }
      if !allowed && item.status == DownloadStatus.downloading { item.status = DownloadStatus.waitingNetwork }
    }
    persist(force: true)
    emit(force: true)
    if allowed { pump() }
  }

  private func networkType() -> String {
    guard let path = lastPath, path.status == .satisfied else { return "none" }
    if path.usesInterfaceType(.wifi) { return "wifi" }
    if path.usesInterfaceType(.wiredEthernet) { return "ethernet" }
    if path.usesInterfaceType(.cellular) { return "cellular" }
    return "other"
  }

  // MARK: Persistence / events

  private func saveObjects(_ id: String, _ objects: [DownloadObject]) {
    let array = objects.map { [$0.key, $0.size] as [Any] }
    if let data = try? JSONSerialization.data(withJSONObject: array) {
      try? data.write(to: store.objectsListURL(forItem: id), options: .atomic)
    }
  }

  private func loadObjects(_ id: String) -> [DownloadObject]? {
    guard
      let data = try? Data(contentsOf: store.objectsListURL(forItem: id)),
      let array = (try? JSONSerialization.jsonObject(with: data)) as? [[Any]]
    else { return nil }
    return array.compactMap { pair in
      guard pair.count >= 1, let key = pair[0] as? String else { return nil }
      return DownloadObject(key: key, size: (pair.count > 1 ? (pair[1] as? NSNumber)?.int64Value : nil) ?? 0)
    }
  }

  private func persist(force: Bool) {
    let now = Date()
    if !force && now.timeIntervalSince(lastPersist) < Self.persistInterval { return }
    lastPersist = now
    var root: [String: Any] = [:]
    if let config {
      root["config"] = [
        "authToken": config.authToken, "appId": config.appId, "wifiOnly": config.wifiOnly,
        "labels": config.labels.toJSON(),
      ]
    }
    root["items"] = order.compactMap { items[$0]?.toJSON(includeGateways: true) }
    do {
      let data = try JSONSerialization.data(withJSONObject: root)
      try data.write(to: queueURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    } catch {
      NSLog("[Downloads] persist.failed %@", error.localizedDescription)
    }
  }

  private func emit(force: Bool) {
    let now = Date()
    if !force && now.timeIntervalSince(lastEmit) < Self.emitInterval {
      // Keep the last progress step from being swallowed by the throttle.
      if !trailingEmitScheduled {
        trailingEmitScheduled = true
        queue.asyncAfter(deadline: .now() + Self.emitInterval) { [weak self] in
          guard let self else { return }
          self.trailingEmitScheduled = false
          self.emit(force: true)
        }
      }
      return
    }
    lastEmit = now
    listener?(stateJSON())
  }
}

// MARK: - Local notifications

/// Completion / failure notifications (Android shows a foreground-service progress notification instead; an
/// iOS app cannot update one while suspended). The texts are translated by JS in the app language and handed
/// over through `configure` as `DownloadLabels`; the engine persists them in `queue.json` so a background
/// relaunch (no JS running) still posts notifications in the right language. Without labels, the texts of
/// `Localizable.strings` apply (UX-I18N-02), in the phone's language.
enum DownloadNotifications {
  /// `MediaProxyDownloads.bundle`, the pod's resource bundle holding `Localizable.strings` (falls back to the app's).
  private static let strings: Bundle = {
    guard let url = Bundle(for: DownloadEngine.self).url(forResource: "MediaProxyDownloads", withExtension: "bundle"),
      let bundle = Bundle(url: url)
    else {
      NSLog("[Downloads] notification.strings bundle=missing fallback=main")
      return .main
    }
    return bundle
  }()

  private static func text(_ key: String) -> String {
    NSLocalizedString(key, tableName: nil, bundle: strings, comment: "Download notification text")
  }

  static func requestAuthorizationIfNeeded() {
    let center = UNUserNotificationCenter.current()
    center.getNotificationSettings { settings in
      guard settings.authorizationStatus == .notDetermined else { return }
      center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }
  }

  static func post(completed item: DownloadItem, labels: DownloadLabels) {
    deliver(item, body: labels.completed ?? text("download.notification.complete"))
  }

  static func post(failed item: DownloadItem, labels: DownloadLabels) {
    let reason: String
    switch item.errorCode {
    case DownloadErrorCode.insufficientSpace:
      reason = labels.insufficientSpace ?? text("download.notification.error.insufficientSpace")
    case DownloadErrorCode.auth:
      reason = labels.auth ?? text("download.notification.error.auth")
    case DownloadErrorCode.network:
      reason = labels.network ?? text("download.notification.error.network")
    default:
      reason = labels.failed ?? text("download.notification.error.failed")
    }
    deliver(item, body: reason)
  }

  private static func deliver(_ item: DownloadItem, body: String) {
    let content = UNMutableNotificationContent()
    if item.kind == "episode", let season = item.seasonNumber, let episode = item.episodeNumber {
      content.title = "\(item.title) · S\(season)E\(episode)"
    } else {
      content.title = item.title
    }
    content.body = body
    content.sound = .default
    let request = UNNotificationRequest(identifier: "download-\(item.id)", content: content, trigger: nil)
    UNUserNotificationCenter.current().add(request) { error in
      if let error { NSLog("[Downloads] notification.failed %@", error.localizedDescription) }
    }
  }
}
#endif
