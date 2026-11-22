package com.spacefleet.mediaproxy.downloads

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.util.Log
import com.spacefleet.mediaproxy.OfflineStore
import com.spacefleet.mediaproxy.StorageTunnelClient
import com.spacefleet.mediaproxy.TrafficReport
import com.spacefleet.mediaproxy.TunnelHttpException
import com.spacefleet.mediaproxy.R
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Process-wide offline download engine. Owns the persisted queue and a single
 * worker thread that drains it item by item (one media file at a time,
 * [PARALLEL_FETCHES] encrypted objects in flight), writing each object still
 * encrypted into [OfflineStore].
 *
 * Fetching goes through [StorageTunnelClient.fetchEncrypted] — the very same
 * tunnel session/waterfall/auth path playback uses.
 *
 * Resume model (chunk-level): objects are written atomically, so on any
 * interruption (app kill, reboot, network loss, Wi-Fi-only gate closing) the
 * remaining work is simply "objects of this item that are not in the store".
 * Items persisted as downloading/waiting come back as queued on the next
 * process start; [resume] (called by JS at startup and by the sticky service)
 * restarts the worker.
 *
 * Network gate: [networkAllowed] is recomputed from [ConnectivityManager]
 * (Wi-Fi/Ethernet only when `wifiOnly`, any internet network otherwise);
 * workers block on it between objects and the item shows
 * [DownloadStatus.WAITING_NETWORK] meanwhile.
 */
class DownloadEngine private constructor(context: Context) {
  private val appContext = context.applicationContext
  val store = OfflineStore(appContext)
  private val queueStore = DownloadQueueStore(store.rootDir)
  private val lock = ReentrantLock()
  private val netChanged = lock.newCondition()
  private val items = LinkedHashMap<String, DownloadItem>()
  private val defaultLabels = DownloadLabels()
  private var config: DownloadConfig? = null
  private var workerRunning = false
  @Volatile private var timedOut = false
  private var currentItem: DownloadItem? = null
  private var netCallback: ConnectivityManager.NetworkCallback? = null
  private var lastPersistMs = 0L
  private var lastEmitMs = 0L
  private var lastNotifyMs = 0L

  // Load of the silo the current item downloads from (STOR-BW-01, STOR-BW-09): the report learned from its session
  // response / ack / `GET /storage/traffic`. One item runs at a time, so one report is enough.
  @Volatile private var traffic: TrafficReport = TrafficReport.NORMAL
  /** Set while the workers wait for a saturated silo to lift (nothing is requested meanwhile). */
  @Volatile private var trafficHeld = false
  @Volatile private var pacer = DownloadPacer()
  private var lastTrafficPollMs = 0L
  private var lastTrafficState = DownloadTrafficState.NORMAL

  // DECOM-02: a download that failed for a cause that heals by itself is retried on a timer, not only at app start.
  private val healer = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "OfflineDownloadHealer").apply { isDaemon = true } }
  private var healScheduled = false
  private var healFailures = 0

  @Volatile private var networkAllowed = false
  @Volatile private var service: DownloadService? = null
  @Volatile var listener: ((String) -> Unit)? = null

  private val connectivity: ConnectivityManager? =
    appContext.getSystemService(ConnectivityManager::class.java)

  init {
    store.sweepPartials()
    val (savedConfig, saved) = queueStore.load()
    config = savedConfig
    for (item in saved) {
      if (item.isActive) {
        // No worker survives a process death: every unfinished item is
        // simply queued again and its remaining objects recomputed from disk.
        item.status = DownloadStatus.QUEUED
        val objects = queueStore.loadObjects(item.id)
        if (objects == null) {
          item.status = DownloadStatus.FAILED
          item.errorCode = DownloadErrorCode.STORAGE
          item.errorMessage = "object_list_missing"
        } else {
          item.objects = objects
          recount(item, objects)
        }
      }
      items[item.id] = item
    }
    refreshNetwork()
    lock.withLock { scheduleHealLocked() }
    Log.i(TAG, "engine.init items=${items.size} active=${items.values.count { it.isActive }}")
  }

  // ---- public API -----------------------------------------------------------

  fun configure(authToken: String, appId: String, wifiOnly: Boolean, labelsJson: String) {
    lock.withLock {
      val previous = currentLabelsLocked()
      val labels = DownloadLabels.fromJson(labelsJson)
      config = DownloadConfig(authToken, appId, wifiOnly, labels)
      persistLocked()
      refreshNetworkLocked()
      netChanged.signalAll()
      emitLocked(force = true)
      val changed = labels != previous
      Log.i(TAG, "labels.applied changed=$changed")
      if (changed) {
        // A running service keeps its channel until told: the name/description of an existing
        // channel id are updatable, and the ongoing notification text is rebuilt right away.
        service?.let {
          it.updateChannel(labels)
          it.refreshNotification()
        }
      }
    }
  }

  /** Adds (or revives a failed) item. Completed and already-active items are left alone. */
  fun enqueue(item: DownloadItem, objects: List<DownloadObject>) {
    lock.withLock {
      val existing = items[item.id]
      if (existing != null && (existing.status == DownloadStatus.COMPLETED || existing.isActive)) {
        Log.i(TAG, "enqueue.skip id=${item.id} status=${existing.status}")
        return
      }
      queueStore.saveObjects(item.id, objects)
      item.objects = objects
      recount(item, objects)
      items.remove(item.id)
      items[item.id] = item
      persistLocked()
      emitLocked(force = true)
      Log.i(TAG, "enqueue id=${item.id} title=${item.title} objects=${objects.size} done=${item.doneObjects} estimatedBytes=${item.estimatedBytes}")
      timedOut = false
      ensureRunningLocked()
    }
  }

  /** Re-queues a failed item (optionally with refreshed gateway candidates). */
  fun retry(id: String, gatewayCandidates: List<String>?) {
    lock.withLock {
      val item = items[id] ?: return
      if (item.status != DownloadStatus.FAILED) return
      if (!gatewayCandidates.isNullOrEmpty()) item.gatewayCandidates = gatewayCandidates
      requeueLocked(item)
      persistLocked()
      emitLocked(force = true)
      timedOut = false
      ensureRunningLocked()
    }
  }

  /** Cancels (if running) and deletes the download and its files. */
  fun remove(ids: List<String>) {
    lock.withLock {
      for (id in ids) {
        val item = items.remove(id) ?: continue
        item.removed = true
        if (item !== currentItem) deleteFilesLocked(item)
        Log.i(TAG, "remove id=$id status=${item.status}")
      }
      persistLocked()
      netChanged.signalAll()
      emitLocked(force = true)
    }
  }

  /** Called by JS at app start: restart whatever is unfinished. */
  fun resume() {
    lock.withLock {
      for (item in items.values) {
        if (item.status == DownloadStatus.FAILED &&
          (item.errorCode == DownloadErrorCode.AUTH || item.errorCode == DownloadErrorCode.NETWORK)
        ) {
          requeueLocked(item)
        }
      }
      persistLocked()
      emitLocked(force = true)
      timedOut = false
      ensureRunningLocked()
    }
  }

  fun stateJson(): String = lock.withLock { stateJsonLocked() }

  /** Complete downloads with their size on disk (OFFL-MANAGE-01); shared objects count once in the total. */
  fun listItems(): OfflineInventory {
    val completed = lock.withLock {
      items.values.filter { it.status == DownloadStatus.COMPLETED }.map { it.id to it.completedAt }
    }
    val inventory = OfflineInventory.compute(completed, { queueStore.loadObjects(it) }, { store.sizeOf(it) })
    Log.i(TAG, "inventory items=${inventory.items.size} totalBytes=${inventory.totalBytes}")
    return inventory
  }

  /** Cancels and deletes every download, finished or not (Settings › "Remove all", OFFL-MANAGE-01). */
  fun removeAll() {
    lock.withLock {
      val ids = items.keys.toList()
      Log.i(TAG, "remove.all count=${ids.size}")
      remove(ids)
    }
  }

  fun networkType(): String {
    val cm = connectivity ?: return "none"
    val net = cm.activeNetwork ?: return "none"
    val caps = cm.getNetworkCapabilities(net) ?: return "none"
    return when {
      caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
      caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
      caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
      else -> "other"
    }
  }

  fun freeBytes(): Long = store.freeBytes()

  /** Object keys of a COMPLETED download, for offline playback checks. */
  fun isCompleted(id: String): Boolean = lock.withLock { items[id]?.status == DownloadStatus.COMPLETED }

  // ---- service plumbing -----------------------------------------------------

  fun onServiceStarted(svc: DownloadService) {
    lock.withLock {
      service = svc
      if (timedOut) {
        svc.shutdown()
        return
      }
      if (!workerRunning) {
        if (items.values.any { it.isActive }) ensureRunningLocked() else svc.shutdown()
      }
    }
  }

  fun onServiceDestroyed(svc: DownloadService) {
    lock.withLock { if (service === svc) service = null }
  }

  /**
   * Android 15+ gives `dataSync` foreground services a time budget (~6 h per 24 h); the system
   * calls `onTimeout` and expects the service to stop. Pause the worker (items stay queued) until
   * the next explicit start (enqueue / retry / app-start resume).
   */
  fun onServiceTimeout() {
    lock.withLock {
      Log.w(TAG, "service.timeout: pausing downloads until the next launch")
      timedOut = true
      netChanged.signalAll()
    }
  }

  /** (title, text, percent 0..100 or -1 for indeterminate) for the foreground notification. */
  fun notificationSummary(): Triple<String, String, Int> = lock.withLock {
    val labels = currentLabelsLocked()
    val active = items.values.filter { it.isActive }
    val current = currentItem ?: active.firstOrNull()
    val title = when {
      active.size > 1 -> labels.activeItemsText(active.size) ?: appContext.getString(R.string.media_proxy_downloads_title_multiple, active.size)
      current != null -> current.title
      else -> labels.title ?: appContext.getString(R.string.media_proxy_downloads_title_default)
    }
    val label = current?.let { describe(it) } ?: ""
    if (!networkAllowed) {
      val reason = if (config?.wifiOnly != false) {
        labels.waitingWifi ?: appContext.getString(R.string.media_proxy_downloads_waiting_wifi)
      } else {
        labels.waitingNetwork ?: appContext.getString(R.string.media_proxy_downloads_waiting_network)
      }
      Triple(title, listOf(reason, label).filter { it.isNotEmpty() }.joinToString(" · "), -1)
    } else {
      val pct = current?.let { percentOf(it) } ?: -1
      val percent = if (pct >= 0) labels.percentText(pct) ?: appContext.getString(R.string.media_proxy_downloads_percent, pct) else ""
      val text = listOf(label, percent).filter { it.isNotEmpty() }.joinToString(" · ")
      Triple(title, text, pct)
    }
  }

  /** Labels for the notification channel (name/description); safe to call from the service. */
  fun currentLabels(): DownloadLabels = lock.withLock { currentLabelsLocked() }

  private fun currentLabelsLocked(): DownloadLabels = config?.labels ?: defaultLabels

  // ---- worker ---------------------------------------------------------------

  private fun ensureRunningLocked() {
    if (workerRunning || timedOut) return
    if (items.values.none { it.isActive }) return
    workerRunning = true
    registerNetworkCallbackLocked()
    try {
      val intent = Intent(appContext, DownloadService::class.java)
      appContext.startForegroundService(intent)
    } catch (e: Throwable) {
      // Background-start restrictions: keep draining without a notification
      // rather than refusing to download.
      Log.w(TAG, "service.start_failed: ${e.message}")
    }
    Thread({ workerLoop() }, "OfflineDownloader").apply { isDaemon = true }.start()
  }

  private fun workerLoop() {
    try {
      while (true) {
        val item = lock.withLock {
          val next = if (timedOut) null else items.values.firstOrNull { it.isActive }
          if (next == null) {
            workerRunning = false
            currentItem = null
            unregisterNetworkCallbackLocked()
            service?.shutdown()
          } else {
            currentItem = next
          }
          next
        } ?: break
        try {
          runItem(item)
        } catch (e: Throwable) {
          Log.e(TAG, "runItem.crash id=${item.id}", e)
          fail(item, DownloadErrorCode.STORAGE, e.message ?: e.javaClass.simpleName)
        }
        // remove() skips deletion for the current item and leaves it to us; a
        // remove that landed after complete()/fail() would otherwise leak the files.
        lock.withLock {
          currentItem = null
          if (item.removed) deleteFilesLocked(item)
        }
      }
    } finally {
      lock.withLock {
        if (workerRunning) {
          workerRunning = false
          currentItem = null
          unregisterNetworkCallbackLocked()
          service?.shutdown()
        }
      }
    }
  }

  private fun runItem(item: DownloadItem) {
    val cfg = lock.withLock { config }
    if (cfg == null || cfg.authToken.isEmpty()) {
      fail(item, DownloadErrorCode.AUTH, "no_auth_token")
      return
    }
    val objects = item.objects ?: queueStore.loadObjects(item.id)
    if (objects == null) {
      fail(item, DownloadErrorCode.STORAGE, "object_list_missing")
      return
    }
    item.objects = objects
    recount(item, objects)
    val pending = objects.filter { !store.has(it.key) }
    if (pending.isEmpty()) {
      complete(item, objects)
      return
    }
    val remainingBytes = pending.sumOf { it.size }
    val free = store.freeBytes()
    if (free < remainingBytes + SPACE_RESERVE_BYTES) {
      fail(item, DownloadErrorCode.INSUFFICIENT_SPACE, "need=$remainingBytes free=$free")
      return
    }

    resetTraffic()
    setStatus(item, DownloadStatus.DOWNLOADING)
    Log.i(TAG, "item.start id=${item.id} pending=${pending.size}/${objects.size} remainingBytes=$remainingBytes")

    val clientRef = AtomicReference(newClient(item, cfg))
    // Open the session and read the silo's report before any object is requested, so the first fetches are already held
    // or paced (STOR-BW-01, STOR-BW-09). A failure here is left to the workers, which retry it as before.
    lock.withLock { lastTrafficPollMs = System.currentTimeMillis() }
    clientRef.get().fetchTraffic()
    val failure = AtomicReference<Pair<String, String>?>(null)
    val next = AtomicInteger(0)
    val pool = Executors.newFixedThreadPool(PARALLEL_FETCHES)
    repeat(PARALLEL_FETCHES) {
      pool.execute {
        while (true) {
          if (item.removed || timedOut || failure.get() != null) return@execute
          val i = next.getAndIncrement()
          if (i >= pending.size) return@execute
          if (!fetchOne(item, pending[i], cfg, clientRef, failure)) return@execute
        }
      }
    }
    pool.shutdown()
    while (!pool.awaitTermination(1, TimeUnit.MINUTES)) { /* drain */ }
    runCatching { clientRef.get().shutdown() }
    resetTraffic()

    if (item.removed) {
      lock.withLock { deleteFilesLocked(item) }
      return
    }
    if (timedOut) {
      // Foreground-service time limit: stop cleanly, keep the files and resume on the next launch.
      setStatus(item, DownloadStatus.QUEUED)
      return
    }
    val f = failure.get()
    if (f != null) {
      fail(item, f.first, f.second)
      return
    }
    complete(item, objects)
  }

  private fun newClient(item: DownloadItem, cfg: DownloadConfig) = StorageTunnelClient(
    gatewayCandidates = item.gatewayCandidates,
    authToken = cfg.authToken,
    appId = cfg.appId,
    // fetchEncrypted never decrypts; downloads stay encrypted at rest.
    masterKey = ByteArray(32),
    clientType = "client-mobile-download",
    purpose = "export",
    spool = null,
    onTrafficReport = ::observeTraffic,
  )

  /** @return false when this worker must stop (removed / failed). */
  private fun fetchOne(
    item: DownloadItem,
    obj: DownloadObject,
    cfg: DownloadConfig,
    clientRef: AtomicReference<StorageTunnelClient>,
    failure: AtomicReference<Pair<String, String>?>,
  ): Boolean {
    var attempt = 0
    while (true) {
      if (item.removed || timedOut || failure.get() != null) return false
      if (!awaitNetwork(item)) return false
      if (shouldPollSilo()) clientRef.get().fetchTraffic()
      if (!awaitSilo(item, obj, cfg, clientRef, failure)) return false
      // High traffic (STOR-BW-01): every object waits for its slot on the shared 4 Mbit/s timeline. Never stopped.
      val paceMs = pacer.reserve(obj.size, traffic.high)
      if (paceMs > 0 && !sleepWhileActive(item, failure, paceMs)) return false
      val client = clientRef.get()
      try {
        val bytes = client.fetchEncrypted(obj.key)
        if (item.removed) return false
        store.write(obj.key, bytes)
        if (item.removed) {
          store.delete(listOf(obj.key))
          return false
        }
        if (obj.size <= 0) pacer.charge(bytes.size.toLong(), traffic.high)
        onObjectDone(item, bytes.size.toLong())
        return true
      } catch (e: Throwable) {
        val msg = e.message ?: e.javaClass.simpleName
        when {
          isNoSpace(e) -> {
            failure.compareAndSet(null, DownloadErrorCode.INSUFFICIENT_SPACE to msg)
            return false
          }
          isAuth(e) -> {
            failure.compareAndSet(null, DownloadErrorCode.AUTH to msg)
            return false
          }
        }
        if (!networkAllowed) continue // the gate closed under us: not a failed attempt
        // A held export read goes silent until its silo lifts (STOR-BW-09): that is not a failed attempt, the silo's
        // own report says so. `awaitSilo` at the top of the loop then waits for it to lift.
        if (DownloadTrafficPolicy.isReadTimeout(e) && client.fetchTraffic()?.saturated == true) {
          Log.i(TAG, "object.held id=${item.id} key=${obj.key}: read timed out while the silo is saturated")
          continue
        }
        attempt += 1
        Log.w(TAG, "object.fetch_failed id=${item.id} key=${obj.key} attempt=$attempt err=$msg")
        if (attempt >= MAX_ATTEMPTS) {
          failure.compareAndSet(null, DownloadErrorCode.NETWORK to msg)
          return false
        }
        // A stale tunnel session (gateway restart) never heals on its own: swap in a fresh client.
        if (e is TunnelHttpException || !(e is IOException)) {
          replaceClient(clientRef, client, item, cfg)
        }
        try {
          Thread.sleep(minOf(8000L, 1000L shl (attempt - 1)))
        } catch (_: InterruptedException) {
          return false
        }
      }
    }
  }

  private fun replaceClient(
    clientRef: AtomicReference<StorageTunnelClient>,
    stale: StorageTunnelClient,
    item: DownloadItem,
    cfg: DownloadConfig,
  ) {
    val fresh = newClient(item, cfg)
    if (clientRef.compareAndSet(stale, fresh)) runCatching { stale.shutdown() } else runCatching { fresh.shutdown() }
  }

  /**
   * Holds while the silo is saturated (STOR-BW-09): nothing is requested, the item stays queued as downloading and the
   * silo is re-read at most once a minute until it lifts. A silo whose report cannot be read is not held (the gateway
   * holds the bytes itself and a read timeout re-checks). The tunnel session may have expired during a long hold, so the
   * worker that sees it lift swaps in a fresh client. @return false when this worker must stop.
   */
  private fun awaitSilo(
    item: DownloadItem,
    obj: DownloadObject,
    cfg: DownloadConfig,
    clientRef: AtomicReference<StorageTunnelClient>,
    failure: AtomicReference<Pair<String, String>?>,
  ): Boolean {
    if (!traffic.saturated) return true
    setHeld(true)
    while (traffic.saturated) {
      if (!sleepWhileActive(item, failure, 1000L)) return false
      if (traffic.saturated && shouldPollSilo()) {
        val report = clientRef.get().fetchTraffic()
        // Unreadable: unknown is not held.
        if (report == null) observeTraffic(traffic.copy(saturated = false))
      }
    }
    if (setHeld(false)) {
      Log.i(TAG, "silo.released id=${item.id} key=${obj.key}")
      replaceClient(clientRef, clientRef.get(), item, cfg)
    }
    return true
  }

  /**
   * True for at most one caller per [DownloadTrafficPolicy.TRAFFIC_POLL_MS], however many workers ask: the workers re-read
   * the silo's report that often while an item downloads, held or not.
   */
  private fun shouldPollSilo(): Boolean = lock.withLock {
    val now = System.currentTimeMillis()
    if (now - lastTrafficPollMs < DownloadTrafficPolicy.TRAFFIC_POLL_MS) return@withLock false
    lastTrafficPollMs = now
    true
  }

  /** @return true when the flag changed (the caller is the one that flipped it). */
  private fun setHeld(held: Boolean): Boolean = lock.withLock {
    if (trafficHeld == held) return@withLock false
    trafficHeld = held
    if (held) lastTrafficPollMs = System.currentTimeMillis()
    Log.i(TAG, "traffic.held=$held")
    emitTrafficLocked()
    true
  }

  /** Sleeps up to [ms] in short slices; false as soon as this worker must stop (removed / timed out / failed). */
  private fun sleepWhileActive(item: DownloadItem, failure: AtomicReference<Pair<String, String>?>, ms: Long): Boolean {
    val deadline = System.nanoTime() + ms * 1_000_000L
    lock.withLock {
      while (true) {
        if (item.removed || timedOut || failure.get() != null) return false
        val leftMs = (deadline - System.nanoTime()) / 1_000_000L
        if (leftMs <= 0) return true
        netChanged.await(minOf(leftMs, 1000L), TimeUnit.MILLISECONDS)
      }
    }
  }

  /** Every load report the current item's tunnel client learns (session response, ack, `GET /storage/traffic`). */
  private fun observeTraffic(report: TrafficReport) {
    lock.withLock {
      if (report == traffic) return
      Log.i(TAG, "traffic.report high=${report.high} saturated=${report.saturated} bufferSeconds=${report.playbackBufferSeconds}")
      traffic = report
      emitTrafficLocked()
    }
  }

  private fun resetTraffic() {
    lock.withLock {
      traffic = TrafficReport.NORMAL
      trafficHeld = false
      pacer = DownloadPacer()
      emitTrafficLocked()
    }
  }

  private fun trafficStateLocked(): String =
    DownloadTrafficState.of(held = trafficHeld, slowed = traffic.high && currentItem != null)

  private fun emitTrafficLocked() {
    val state = trafficStateLocked()
    if (state == lastTrafficState) return
    lastTrafficState = state
    emitLocked(force = true)
  }

  // ---- self-healing (DECOM-02) ------------------------------------------------

  /** Arms one retry of the failed items whose cause heals by itself; the delay grows while they keep failing. */
  private fun scheduleHealLocked() {
    if (healScheduled) return
    if (items.values.none { it.status == DownloadStatus.FAILED && DownloadTrafficPolicy.isHealable(it.errorCode) }) return
    healScheduled = true
    healFailures += 1
    val delayMs = DownloadTrafficPolicy.healDelayMs(healFailures)
    Log.i(TAG, "heal.scheduled inMs=$delayMs consecutive=$healFailures")
    healer.schedule({ healFailed() }, delayMs, TimeUnit.MILLISECONDS)
  }

  private fun healFailed() {
    lock.withLock {
      healScheduled = false
      var requeued = 0
      for (item in items.values) {
        if (item.status == DownloadStatus.FAILED && DownloadTrafficPolicy.isHealable(item.errorCode)) {
          requeueLocked(item)
          requeued += 1
        }
      }
      if (requeued == 0) {
        healFailures = 0
        return
      }
      Log.i(TAG, "heal.retry items=$requeued")
      persistLocked()
      emitLocked(force = true)
      ensureRunningLocked()
    }
  }

  private fun awaitNetwork(item: DownloadItem): Boolean {
    lock.withLock {
      while (!networkAllowed && !item.removed && !timedOut) {
        if (item.status == DownloadStatus.DOWNLOADING) {
          item.status = DownloadStatus.WAITING_NETWORK
          persistLocked()
          emitLocked(force = true)
          notifyLocked(force = true)
        }
        netChanged.await(5, TimeUnit.SECONDS)
        refreshNetworkLocked()
      }
      if (item.removed || timedOut) return false
      if (item.status == DownloadStatus.WAITING_NETWORK) {
        item.status = DownloadStatus.DOWNLOADING
        persistLocked()
        emitLocked(force = true)
        notifyLocked(force = true)
      }
      return true
    }
  }

  private fun onObjectDone(item: DownloadItem, bytes: Long) {
    lock.withLock {
      healFailures = 0
      item.doneBytes += bytes
      item.doneObjects += 1
      val now = System.currentTimeMillis()
      if (now - lastPersistMs > PERSIST_INTERVAL_MS) persistLocked()
      emitLocked(force = false)
      notifyLocked(force = false)
    }
  }

  private fun setStatus(item: DownloadItem, status: String) {
    lock.withLock {
      item.status = status
      if (status == DownloadStatus.DOWNLOADING) {
        item.errorCode = null
        item.errorMessage = null
      }
      persistLocked()
      emitLocked(force = true)
      notifyLocked(force = true)
    }
  }

  private fun complete(item: DownloadItem, objects: List<DownloadObject>) {
    val stored = objects.sumOf { store.sizeOf(it.key) }
    lock.withLock {
      if (item.removed) {
        deleteFilesLocked(item)
        return
      }
      item.storedBytes = stored
      item.doneBytes = stored
      item.doneObjects = objects.size
      item.status = DownloadStatus.COMPLETED
      item.errorCode = null
      item.errorMessage = null
      item.completedAt = System.currentTimeMillis()
      healFailures = 0
      item.objects = null
      persistLocked()
      emitLocked(force = true)
      notifyLocked(force = true)
    }
    Log.i(TAG, "item.completed id=${item.id} storedBytes=$stored objects=${objects.size}")
  }

  private fun fail(item: DownloadItem, code: String, message: String) {
    lock.withLock {
      if (item.removed) {
        deleteFilesLocked(item)
        return
      }
      item.status = DownloadStatus.FAILED
      item.errorCode = code
      item.errorMessage = message
      persistLocked()
      emitLocked(force = true)
      notifyLocked(force = true)
      scheduleHealLocked()
    }
    Log.w(TAG, "item.failed id=${item.id} code=$code message=$message")
  }

  // ---- helpers --------------------------------------------------------------

  private fun requeueLocked(item: DownloadItem) {
    item.status = DownloadStatus.QUEUED
    item.errorCode = null
    item.errorMessage = null
    val objects = item.objects ?: queueStore.loadObjects(item.id)
    if (objects == null) {
      item.status = DownloadStatus.FAILED
      item.errorCode = DownloadErrorCode.STORAGE
      item.errorMessage = "object_list_missing"
    } else {
      item.objects = objects
      recount(item, objects)
    }
  }

  private fun recount(item: DownloadItem, objects: List<DownloadObject>) {
    var n = 0
    var bytes = 0L
    for (o in objects) {
      val f = store.file(o.key)
      if (f.isFile) {
        n += 1
        bytes += f.length()
      }
    }
    item.doneObjects = n
    item.doneBytes = bytes
  }

  private fun deleteFilesLocked(item: DownloadItem) {
    val objects = item.objects ?: queueStore.loadObjects(item.id)
    if (objects != null) {
      // Audio / subtitle objects are shared by every episode of a title: only
      // delete the keys no other download (queued, active, failed or completed)
      // still lists. A re-enqueue of the same id counts as "another" item too.
      val others = items.values.asSequence()
        .filter { it !== item }
        .mapNotNull { other -> other.objects ?: queueStore.loadObjects(other.id) }
      val doomed = OfflineInventory.keysToDelete(objects, others.asIterable())
      Log.i(TAG, "delete.files id=${item.id} objects=${objects.size} deleting=${doomed.size} shared=${objects.size - doomed.size}")
      store.delete(doomed)
    }
    // A re-enqueue of the same id may already have saved its object list here.
    val replacement = items[item.id]
    if (replacement == null || replacement === item) queueStore.deleteObjects(item.id)
  }

  private fun percentOf(item: DownloadItem): Int {
    if (item.status == DownloadStatus.COMPLETED) return 100
    val byBytes = if (item.estimatedBytes > 0) item.doneBytes.toDouble() / item.estimatedBytes else 0.0
    val byCount = if (item.totalObjects > 0) item.doneObjects.toDouble() / item.totalObjects else 0.0
    val frac = if (item.estimatedBytes > 0) byBytes else byCount
    return (frac * 100).toInt().coerceIn(0, 99)
  }

  private fun describe(item: DownloadItem): String =
    if (item.kind == "episode" && item.seasonNumber != null && item.episodeNumber != null) {
      "S${item.seasonNumber}E${item.episodeNumber}"
    } else {
      ""
    }

  private fun isAuth(e: Throwable): Boolean {
    if (e is TunnelHttpException) return e.code == 401 || e.code == 403
    val m = e.message ?: return false
    return AUTH_REGEX.containsMatchIn(m)
  }

  private fun isNoSpace(e: Throwable): Boolean {
    var cur: Throwable? = e
    while (cur != null) {
      val m = cur.message
      if (cur is IOException && m != null && (m.contains("ENOSPC") || m.contains("No space left"))) return true
      cur = cur.cause
    }
    return false
  }

  private fun stateJsonLocked(): String {
    val root = JSONObject()
    root.put("items", JSONArray().also { arr -> items.values.forEach { arr.put(it.toJson().apply { remove("gatewayCandidates") }) } })
    root.put("networkAllowed", networkAllowed)
    root.put("wifiOnly", config?.wifiOnly ?: true)
    root.put("traffic", trafficStateLocked())
    return root.toString()
  }

  private fun persistLocked() {
    lastPersistMs = System.currentTimeMillis()
    try {
      queueStore.save(config, items.values)
    } catch (e: Throwable) {
      Log.e(TAG, "persist.failed", e)
    }
  }

  private fun emitLocked(force: Boolean) {
    val now = System.currentTimeMillis()
    if (!force && now - lastEmitMs < EMIT_INTERVAL_MS) return
    lastEmitMs = now
    listener?.invoke(stateJsonLocked())
  }

  private fun notifyLocked(force: Boolean) {
    val now = System.currentTimeMillis()
    if (!force && now - lastNotifyMs < NOTIFY_INTERVAL_MS) return
    lastNotifyMs = now
    service?.refreshNotification()
  }

  // ---- network --------------------------------------------------------------

  private fun refreshNetwork() = lock.withLock { refreshNetworkLocked() }

  private fun refreshNetworkLocked() {
    val allowed = computeNetworkAllowed()
    if (allowed != networkAllowed) {
      networkAllowed = allowed
      Log.i(TAG, "network.allowed=$allowed type=${networkType()} wifiOnly=${config?.wifiOnly}")
      netChanged.signalAll()
      emitLocked(force = true)
      notifyLocked(force = true)
    }
  }

  private fun computeNetworkAllowed(): Boolean {
    val cm = connectivity ?: return false
    val net = cm.activeNetwork ?: return false
    val caps = cm.getNetworkCapabilities(net) ?: return false
    if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return false
    val wifiOnly = config?.wifiOnly ?: true
    if (!wifiOnly) return true
    return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
      caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
  }

  private fun registerNetworkCallbackLocked() {
    if (netCallback != null) return
    val cm = connectivity ?: return
    val cb = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) = refreshNetwork()
      override fun onLost(network: Network) = refreshNetwork()
      override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = refreshNetwork()
    }
    try {
      cm.registerDefaultNetworkCallback(cb)
      netCallback = cb
    } catch (e: Throwable) {
      Log.w(TAG, "network.callback_register_failed: ${e.message}")
    }
    refreshNetworkLocked()
  }

  private fun unregisterNetworkCallbackLocked() {
    val cb = netCallback ?: return
    netCallback = null
    runCatching { connectivity?.unregisterNetworkCallback(cb) }
  }

  companion object {
    private const val TAG = "DownloadEngine"
    private const val PARALLEL_FETCHES = 3
    private const val MAX_ATTEMPTS = 5
    private const val SPACE_RESERVE_BYTES = 100L * 1024L * 1024L
    private const val PERSIST_INTERVAL_MS = 2000L
    private const val EMIT_INTERVAL_MS = 500L
    private const val NOTIFY_INTERVAL_MS = 1000L
    private val AUTH_REGEX = Regex("tunnel_(session_failed|session_start_failed|download_failed): (401|403)")

    @Volatile private var instance: DownloadEngine? = null

    fun get(context: Context): DownloadEngine =
      instance ?: synchronized(this) {
        instance ?: DownloadEngine(context).also { instance = it }
      }
  }
}
