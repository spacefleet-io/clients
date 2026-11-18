package com.spacefleet.mpvplayback.mpv

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import com.spacefleet.mediaproxy.NetworkMeter
import com.spacefleet.mediaproxy.NetworkThrottle
import `is`.xyz.mpv.MPVLib
import org.json.JSONArray
import org.json.JSONObject

/**
 * DEBUG-BUILD-ONLY player state probe for the phone e2e/perf harness
 * (apps/badger/mobile/e2e-phone). The release variant of this object
 * (src/release) is an empty stub, so none of this ships.
 *
 * Transports:
 *  - `adb shell am broadcast -a com.spacefleet.mpvplayback.probe.QUERY -p <appId>` -> the
 *    receiver sets the broadcast result data to the JSON snapshot (`data="{...}"`).
 *  - `...probe.UI` -> JSON dump of visible on-screen views with text/desc/testID + bounds (MpvProbeUi).
 *  - `...probe.RESET` clears the stall/freeze counters + event log (per scenario).
 *  - `...probe.MSGLEVEL --es level "all=warn,demux=v,ffmpeg=v"` sets libmpv's `msg-level` at runtime (lines show up
 *    in logcat tag `MpvCore`); `--es level ""` restores `all=warn`. Diagnostics only, never used by the harness.
 *  - `...probe.SETOPT --es name cache-secs --es value 5` sets one mpv option at runtime (A/B experiments without a rebuild).
 *  - `...probe.NETTHROTTLE --ei kbps 1500` caps the upstream fetch rate of the local playback proxy (deterministic
 *    network shaping for the ABR scenarios, shared by every fetch thread); `--ei kbps 0` removes the cap.
 *  - `...probe.SETTEXT --es testId login-email --es text64 <base64 UTF-8>` sets the text of the on-screen text field
 *    with that testID (MpvProbeUi.setText): the harness's text entry. `adb shell input text` drops keys in RN fields
 *    and cannot type accented letters (a French key word like `irréel`).
 *  - logcat tag `SBProbe`: one JSON snapshot per second while a player is attached and one
 *    JSON line per event (seek, restart, track change, stall, freeze) as it happens.
 *
 * Snapshot (`v`:1) while idle (no player attached): `{"v":1,"state":"idle","ts":..,"last":{..}}`.
 * All timestamps are device epoch milliseconds (System.currentTimeMillis).
 */
object MpvProbe {
  private const val TAG = "SBProbe"
  const val ACTION_QUERY = "com.spacefleet.mpvplayback.probe.QUERY"
  const val ACTION_RESET = "com.spacefleet.mpvplayback.probe.RESET"
  const val ACTION_UI = "com.spacefleet.mpvplayback.probe.UI"
  const val ACTION_MSGLEVEL = "com.spacefleet.mpvplayback.probe.MSGLEVEL"
  const val ACTION_SETOPT = "com.spacefleet.mpvplayback.probe.SETOPT"
  const val ACTION_NETTHROTTLE = "com.spacefleet.mpvplayback.probe.NETTHROTTLE"
  const val ACTION_SETTEXT = "com.spacefleet.mpvplayback.probe.SETTEXT"
  private const val POLL_MS = 250L
  private const val LOG_EVERY_TICKS = 4
  private const val FREEZE_MS = 750L
  private const val MAX_EVENTS = 200

  private val lock = Any()
  private var receiverInstalled = false
  private var thread: HandlerThread? = null
  private var handler: Handler? = null
  private var observer: MPVLib.EventObserver? = null
  private var attached = false
  private var ticks = 0

  // Per-session state (guarded by lock).
  private var startFileAt = 0L
  private var fileLoadedAt = 0L
  private var firstFrameAt = 0L
  private var lastRestartAt = 0L
  private var lastSeekAt = 0L
  private var seeking = false
  private var stalls = 0
  private var stallOpenAt = 0L
  private var stallTotalMs = 0L
  private var freezes = 0
  private var freezeKind: String? = null
  private var lastPos = Double.NaN
  private var lastPosAt = 0L
  private var lastFrameNo = -1L
  private var lastFrameAt = 0L
  private var lastAid: Any? = null
  private var lastSid: Any? = null
  private var lastVid: String? = null
  private var lastSnapshot: JSONObject? = null
  private val events = ArrayDeque<JSONObject>()

  /** Called once at process start (MpvProbeProvider): lets a query answer "idle" before any player exists. */
  fun installReceiver(context: Context) {
    synchronized(lock) {
      if (receiverInstalled) return
      receiverInstalled = true
    }
    val filter = IntentFilter().apply {
      addAction(ACTION_QUERY)
      addAction(ACTION_RESET)
      addAction(ACTION_UI)
      addAction(ACTION_MSGLEVEL)
      addAction(ACTION_SETOPT)
      addAction(ACTION_NETTHROTTLE)
      addAction(ACTION_SETTEXT)
    }
    (context as? android.app.Application)?.let { MpvProbeUi.track(it) }
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(ctx: Context, intent: Intent) {
        when (intent.action) {
          ACTION_RESET -> {
            reset()
            if (isOrderedBroadcast) setResultData("{\"v\":1,\"reset\":true}")
          }
          ACTION_UI -> if (isOrderedBroadcast) setResultData(MpvProbeUi.dump().toString())
          ACTION_SETTEXT -> {
            val testId = intent.getStringExtra("testId").orEmpty()
            val text = intent.getStringExtra("text64")
              ?.let { runCatching { String(android.util.Base64.decode(it, android.util.Base64.DEFAULT), Charsets.UTF_8) }.getOrNull() }
            val res = if (testId.isBlank() || text == null) {
              JSONObject().put("v", 1).put("ok", false).put("error", "testId and text64 (base64 UTF-8) are required")
            } else {
              MpvProbeUi.setText(testId, text)
            }
            Log.i(TAG, "{\"v\":1,\"evt\":\"settext\",\"testId\":${JSONObject.quote(testId)},\"chars\":${text?.length ?: -1},\"ok\":${res.optBoolean("ok")}}")
            if (isOrderedBroadcast) setResultData(res.toString())
          }
          ACTION_MSGLEVEL -> {
            val level = intent.getStringExtra("level")?.takeIf { it.isNotBlank() } ?: "all=warn"
            val ok = try {
              MpvGuard.setPropertyString("options/msg-level", level)
              true
            } catch (e: Throwable) {
              Log.w(TAG, "msg-level set failed: ${e.message}")
              false
            }
            Log.i(TAG, "{\"v\":1,\"evt\":\"msg-level\",\"level\":\"$level\",\"ok\":$ok}")
            if (isOrderedBroadcast) setResultData("{\"v\":1,\"msgLevel\":\"$level\",\"ok\":$ok}")
          }
          ACTION_SETOPT -> {
            val name = intent.getStringExtra("name").orEmpty()
            val value = intent.getStringExtra("value").orEmpty()
            val ok = name.isNotBlank() && try {
              MpvGuard.setPropertyString("options/$name", value)
              true
            } catch (e: Throwable) {
              Log.w(TAG, "setopt failed: ${e.message}")
              false
            }
            Log.i(TAG, "{\"v\":1,\"evt\":\"setopt\",\"name\":\"$name\",\"value\":\"$value\",\"ok\":$ok}")
            if (isOrderedBroadcast) setResultData("{\"v\":1,\"setopt\":\"$name\",\"ok\":$ok}")
          }
          ACTION_NETTHROTTLE -> {
            val kbps = intent.getIntExtra("kbps", 0).coerceAtLeast(0)
            NetworkThrottle.bytesPerSecond = kbps * 1000L / 8
            Log.i(TAG, "{\"v\":1,\"evt\":\"net-throttle\",\"kbps\":$kbps,\"ts\":${System.currentTimeMillis()}}")
            if (isOrderedBroadcast) setResultData("{\"v\":1,\"netThrottleKbps\":$kbps}")
          }
          ACTION_QUERY -> {
            val json = snapshot().toString()
            Log.i(TAG, json)
            if (isOrderedBroadcast) setResultData(json)
          }
        }
      }
    }
    if (Build.VERSION.SDK_INT >= 33) {
      context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
    } else {
      context.registerReceiver(receiver, filter)
    }
    Log.i(TAG, "{\"v\":1,\"evt\":\"probe-installed\",\"ts\":${System.currentTimeMillis()}}")
  }

  /** Hook from [MpvEngine.attach]: libmpv is initialised, property observers are registered. */
  fun attach(context: Context) {
    installReceiver(context.applicationContext)
    synchronized(lock) {
      if (attached) return
      attached = true
      resetLocked()
      ticks = 0
      val t = HandlerThread("SBProbe").also { it.start() }
      thread = t
      val h = Handler(t.looper)
      handler = h
      val obs = object : MPVLib.EventObserver {
        override fun eventProperty(property: String) = onProp(property, null)
        override fun eventProperty(property: String, value: Long) = onProp(property, value)
        override fun eventProperty(property: String, value: Boolean) = onProp(property, value)
        override fun eventProperty(property: String, value: String) = onProp(property, value)
        override fun eventProperty(property: String, value: Double) = onProp(property, value)
        override fun event(eventId: Int) = onEvent(eventId)
      }
      observer = obs
      h.postDelayed(pollTask, POLL_MS)
    }
    MPVLib.addObserver(observer ?: return)
    Log.i(TAG, "{\"v\":1,\"evt\":\"attached\",\"ts\":${System.currentTimeMillis()}}")
  }

  /** Hook from [MpvEngine.destroy], BEFORE `MPVLib.destroy()`: after this returns no mpv call is in flight. */
  fun detach() {
    val t: HandlerThread?
    val obs: MPVLib.EventObserver?
    // Taking the lock waits out an in-flight poll tick; once attached=false no tick/event touches mpv.
    synchronized(lock) {
      if (!attached) return
      lastSnapshot = snapshotLocked(readMpv = true).also { it.put("state", "ended") }
      attached = false
      obs = observer
      observer = null
      handler?.removeCallbacksAndMessages(null)
      handler = null
      t = thread
      thread = null
    }
    // Outside the lock: MPVLib's observer list lock is held while it dispatches into onProp/onEvent (which take ours).
    obs?.let { MPVLib.removeObserver(it) }
    t?.quitSafely()
    Log.i(TAG, "{\"v\":1,\"evt\":\"detached\",\"ts\":${System.currentTimeMillis()}}")
  }

  private val pollTask = object : Runnable {
    override fun run() {
      synchronized(lock) {
        if (!attached) return
        tickLocked(System.currentTimeMillis())
        ticks++
        if (ticks % LOG_EVERY_TICKS == 0 && fileLoadedAt != 0L) {
          Log.i(TAG, snapshotLocked(readMpv = true).toString())
        }
        handler?.postDelayed(this, POLL_MS)
      }
    }
  }

  private fun reset() = synchronized(lock) { resetLocked() }

  private fun resetLocked() {
    startFileAt = 0L
    fileLoadedAt = 0L
    firstFrameAt = 0L
    lastRestartAt = 0L
    lastSeekAt = 0L
    seeking = false
    stalls = 0
    stallOpenAt = 0L
    stallTotalMs = 0L
    freezes = 0
    freezeKind = null
    lastVid = null
    lastPos = Double.NaN
    lastPosAt = 0L
    lastFrameNo = -1L
    lastFrameAt = 0L
    events.clear()
  }

  private fun addEventLocked(name: String, value: Any? = null, ts: Long = System.currentTimeMillis()) {
    val e = JSONObject().put("t", ts).put("e", name)
    if (value != null) e.put("v", value)
    events.addLast(e)
    while (events.size > MAX_EVENTS) events.removeFirst()
    Log.i(TAG, JSONObject().put("v", 1).put("evt", name).put("val", value ?: JSONObject.NULL).put("ts", ts).toString())
  }

  private fun onProp(property: String, value: Any?) {
    val now = System.currentTimeMillis()
    synchronized(lock) {
      if (!attached) return
      when (property) {
        "paused-for-cache" -> {
          val on = value == true
          if (on && stallOpenAt == 0L) {
            // A buffering pause right after load/seek is the start-up wait, not a stall.
            if (firstFrameAt != 0L && !seeking) {
              stalls++
              stallOpenAt = now
              addEventLocked("stall-begin", null, now)
            }
          } else if (!on && stallOpenAt != 0L) {
            stallTotalMs += now - stallOpenAt
            addEventLocked("stall-end", now - stallOpenAt, now)
            stallOpenAt = 0L
          }
        }
        "aid" -> if (value != lastAid) { lastAid = value; addEventLocked("aid", value, now) }
        "sid" -> if (value != lastSid) { lastSid = value; addEventLocked("sid", value, now) }
        "pause" -> addEventLocked("pause", value, now)
      }
    }
  }

  private fun onEvent(eventId: Int) {
    val now = System.currentTimeMillis()
    synchronized(lock) {
      if (!attached) return
      when (eventId) {
        MPVLib.MpvEvent.MPV_EVENT_START_FILE -> {
          resetPerFileLocked()
          startFileAt = now
          addEventLocked("start-file", null, now)
        }
        MPVLib.MpvEvent.MPV_EVENT_FILE_LOADED -> {
          fileLoadedAt = now
          addEventLocked("file-loaded", null, now)
        }
        MPVLib.MpvEvent.MPV_EVENT_END_FILE -> addEventLocked("end-file", null, now)
        MPVLib.MpvEvent.MPV_EVENT_SEEK -> {
          seeking = true
          lastSeekAt = now
          addEventLocked("seek", null, now)
        }
        MPVLib.MpvEvent.MPV_EVENT_PLAYBACK_RESTART -> {
          seeking = false
          lastRestartAt = now
          lastPosAt = now
          if (firstFrameAt == 0L) firstFrameAt = now
          addEventLocked("restart", if (lastSeekAt != 0L) now - lastSeekAt else null, now)
        }
      }
    }
  }

  private fun resetPerFileLocked() {
    firstFrameAt = 0L
    fileLoadedAt = 0L
    lastRestartAt = 0L
    lastSeekAt = 0L
    seeking = false
    lastPos = Double.NaN
    lastFrameNo = -1L
  }

  /** One 250 ms tick: freeze detection (position stuck, or video frame counter stuck while position moves). */
  private fun tickLocked(now: Long) {
    if (fileLoadedAt == 0L) return
    val pos = MPVLib.getPropertyDouble("time-pos") ?: return
    val paused = MPVLib.getPropertyBoolean("pause") == true
    val pfc = MPVLib.getPropertyBoolean("paused-for-cache") == true
    val eof = MPVLib.getPropertyBoolean("eof-reached") == true
    val idleOk = paused || pfc || seeking || eof
    if (lastPosAt == 0L || pos != lastPos || idleOk) {
      val advanced = lastPosAt == 0L || pos != lastPos
      lastPos = pos
      lastPosAt = now
      if (advanced && freezeKind == "position") endFreezeLocked(now)
    } else if (now - lastPosAt >= FREEZE_MS && freezeKind == null) {
      freezeKind = "position"
      freezes++
      addEventLocked("freeze-begin", "position", now)
    }
    // Video-only freeze: position advances (audio clock) but the decoded frame counter does not.
    val vid = MPVLib.getPropertyString("vid")
    if (vid != lastVid) {
      lastVid = vid
      addEventLocked("vid", vid, now)
    }
    val hasVideo = vid?.let { it != "no" } == true
    val frameNo = MPVLib.getPropertyInt("estimated-frame-number")?.toLong()
    if (hasVideo && frameNo != null && !idleOk) {
      if (frameNo != lastFrameNo) {
        lastFrameNo = frameNo
        lastFrameAt = now
        if (freezeKind == "video") endFreezeLocked(now)
      } else if (lastFrameAt != 0L && now - lastFrameAt >= FREEZE_MS && freezeKind == null) {
        freezeKind = "video"
        freezes++
        addEventLocked("freeze-begin", "video", now)
      }
    } else {
      lastFrameAt = now
      lastFrameNo = frameNo?.toLong() ?: -1L
    }
  }

  private fun endFreezeLocked(now: Long) {
    addEventLocked("freeze-end", freezeKind, now)
    freezeKind = null
  }

  private fun snapshot(): JSONObject = synchronized(lock) { snapshotLocked(readMpv = attached) }

  /** Video tracks mpv exposes, `id:WxH:hlsBitrate[*]` (`*` = selected): shows which HLS variants `vid` can actually address. */
  private fun videoTrackSummary(): String = runCatching {
    val arr = org.json.JSONArray(MPVLib.getPropertyString("track-list") ?: "[]")
    (0 until arr.length()).map { arr.getJSONObject(it) }.filter { it.optString("type") == "video" }.joinToString(",") {
      "${it.optInt("id")}:${it.optInt("demux-w")}x${it.optInt("demux-h")}:${it.optLong("hls-bitrate")}${if (it.optBoolean("selected")) "*" else ""}"
    }
  }.getOrDefault("")

  private fun snapshotLocked(readMpv: Boolean): JSONObject {
    val now = System.currentTimeMillis()
    val o = JSONObject().put("v", 1).put("ts", now)
    if (!readMpv) {
      o.put("state", "idle")
      lastSnapshot?.let { o.put("last", it) }
      return o
    }
    val loaded = fileLoadedAt != 0L
    val paused = MPVLib.getPropertyBoolean("pause")
    val pfc = MPVLib.getPropertyBoolean("paused-for-cache")
    o.put(
      "state",
      when {
        !loaded -> "attached"
        pfc == true -> "buffering"
        paused == true -> "paused"
        else -> "playing"
      },
    )
    o.put("pos", MPVLib.getPropertyDouble("time-pos") ?: JSONObject.NULL)
    o.put("dur", MPVLib.getPropertyDouble("duration") ?: JSONObject.NULL)
    o.put("paused", paused ?: JSONObject.NULL)
    o.put("vid", MPVLib.getPropertyString("vid") ?: JSONObject.NULL)
    o.put("aid", MPVLib.getPropertyString("aid") ?: JSONObject.NULL)
    o.put("sid", MPVLib.getPropertyString("sid") ?: JSONObject.NULL)
    o.put("hwdec", MPVLib.getPropertyString("hwdec-current") ?: JSONObject.NULL)
    o.put("vo", MPVLib.getPropertyString("current-vo") ?: JSONObject.NULL)
    o.put("avsync", MPVLib.getPropertyDouble("avsync") ?: JSONObject.NULL)
    o.put("netKbps", NetworkMeter.bitsPerSecond() / 1000.0)
    o.put("throttleKbps", NetworkThrottle.bytesPerSecond * 8 / 1000)
    o.put("cacheDur", MPVLib.getPropertyDouble("demuxer-cache-duration") ?: JSONObject.NULL)
    o.put("vtracks", videoTrackSummary())
    o.put("vcodec", MPVLib.getPropertyString("video-codec") ?: JSONObject.NULL)
    o.put("vformat", MPVLib.getPropertyString("video-format") ?: JSONObject.NULL)
    o.put("acodec", MPVLib.getPropertyString("audio-codec-name") ?: JSONObject.NULL)
    o.put("achannels", MPVLib.getPropertyString("audio-params/channel-count") ?: JSONObject.NULL)
    o.put("ao", MPVLib.getPropertyString("current-ao") ?: JSONObject.NULL)
    o.put("w", MPVLib.getPropertyInt("video-params/w") ?: JSONObject.NULL)
    o.put("h", MPVLib.getPropertyInt("video-params/h") ?: JSONObject.NULL)
    o.put("fps", MPVLib.getPropertyDouble("estimated-vf-fps") ?: JSONObject.NULL)
    o.put("drop", MPVLib.getPropertyInt("frame-drop-count") ?: JSONObject.NULL)
    o.put("ddrop", MPVLib.getPropertyInt("decoder-frame-drop-count") ?: JSONObject.NULL)
    o.put("vdelayed", MPVLib.getPropertyInt("vo-delayed-frame-count") ?: JSONObject.NULL)
    o.put("frameNo", MPVLib.getPropertyInt("estimated-frame-number") ?: JSONObject.NULL)
    o.put("pfc", pfc ?: JSONObject.NULL)
    o.put("cacheBuf", MPVLib.getPropertyInt("cache-buffering-state") ?: JSONObject.NULL)
    o.put("cacheTime", MPVLib.getPropertyDouble("demuxer-cache-time") ?: JSONObject.NULL)
    o.put("seeking", seeking)
    o.put("path", MPVLib.getPropertyString("path")?.take(160) ?: JSONObject.NULL)
    o.put("startFileAt", startFileAt)
    o.put("fileLoadedAt", fileLoadedAt)
    o.put("firstFrameAt", firstFrameAt)
    o.put("lastSeekAt", lastSeekAt)
    o.put("lastRestartAt", lastRestartAt)
    o.put("stalls", stalls)
    o.put("stallMs", stallTotalMs + if (stallOpenAt != 0L) now - stallOpenAt else 0L)
    o.put("freezes", freezes)
    o.put("freezeOpen", freezeKind ?: JSONObject.NULL)
    o.put("events", JSONArray(events.toList()))
    return o
  }
}
