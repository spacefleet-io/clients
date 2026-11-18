package com.spacefleet.mediaproxy.downloads

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import com.spacefleet.mediaproxy.R

/**
 * Foreground service (type `dataSync`) that keeps the process alive and shows
 * the progress notification while [DownloadEngine] drains the queue. The
 * engine owns all the work; the service only hosts the notification and is
 * stopped by the engine when the queue is empty ([shutdown]).
 *
 * START_STICKY: if the system kills the process mid-download it restarts the
 * service with a null intent; [DownloadEngine.get] reloads the persisted queue
 * and [DownloadEngine.onServiceStarted] resumes it (chunk-level).
 */
class DownloadService : Service() {
  private lateinit var engine: DownloadEngine

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    engine = DownloadEngine.get(applicationContext)
    updateChannel(engine.currentLabels())
    val (title, text, pct) = engine.notificationSummary()
    val notification = buildNotification(title, text, pct)
    try {
      if (Build.VERSION.SDK_INT >= 29) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (e: Throwable) {
      // e.g. ForegroundServiceStartNotAllowedException after the dataSync budget ran out: the
      // worker pauses and resumes at the next launch instead of crashing the process.
      Log.e(TAG, "startForeground.failed: ${e.message}")
      engine.onServiceTimeout()
      stopSelf()
      return START_NOT_STICKY
    }
    engine.onServiceStarted(this)
    return START_STICKY
  }

  /**
   * Android 15+: the `dataSync` time budget is exhausted. The system gives a few seconds to stop
   * or the app is killed with an ANR/crash, so stop at once and let the engine pause its worker.
   */
  override fun onTimeout(startId: Int, fgsType: Int) {
    Log.w(TAG, "onTimeout startId=$startId fgsType=$fgsType")
    if (::engine.isInitialized) engine.onServiceTimeout()
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onDestroy() {
    if (::engine.isInitialized) engine.onServiceDestroyed(this)
    super.onDestroy()
  }

  fun refreshNotification() {
    val (title, text, pct) = engine.notificationSummary()
    getSystemService(NotificationManager::class.java)
      .notify(NOTIFICATION_ID, buildNotification(title, text, pct))
  }

  /** Called by the engine (under its lock) when nothing is left to download. */
  fun shutdown() {
    Log.i(TAG, "shutdown")
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  /**
   * Creates the channel or, when it already exists, updates its name/description (Android applies
   * both to an existing channel id; importance and badge stay as first created). Called at service
   * start and by the engine when `configure` brings changed labels, never per progress tick. Without
   * labels from JS the string resources apply, in the phone's language.
   */
  fun updateChannel(labels: DownloadLabels) {
    val nm = getSystemService(NotificationManager::class.java)
    nm.createNotificationChannel(
      NotificationChannel(
        CHANNEL_ID,
        labels.title ?: getString(R.string.media_proxy_downloads_channel_name),
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = labels.channelDescription ?: getString(R.string.media_proxy_downloads_channel_description)
        setShowBadge(false)
      }
    )
    Log.i(TAG, "channel.updated")
  }

  private fun buildNotification(title: String, text: String, pct: Int): Notification {
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = launch?.let {
      PendingIntent.getActivity(
        this,
        0,
        it,
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
    }
    return Notification.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle(title)
      .setContentText(text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(Notification.CATEGORY_PROGRESS)
      .setProgress(100, pct.coerceAtLeast(0), pct < 0)
      .apply { if (contentIntent != null) setContentIntent(contentIntent) }
      .build()
  }

  companion object {
    private const val TAG = "DownloadService"
    private const val CHANNEL_ID = "offline_downloads"
    private const val NOTIFICATION_ID = 7401
  }
}
