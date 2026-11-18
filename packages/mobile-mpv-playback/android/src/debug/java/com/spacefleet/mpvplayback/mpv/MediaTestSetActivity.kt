package com.spacefleet.mpvplayback.mpv

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Log
import android.view.PixelCopy
import android.view.SurfaceHolder
import android.view.WindowManager
import android.widget.FrameLayout
import `is`.xyz.mpv.MPVLib
import java.io.File
import java.io.FileOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONArray
import org.json.JSONObject

/**
 * DEBUG/PROFILE-ONLY runner of the media format test set (REL-DEPS-11, packages/media-deps/src/mediaTestSet.ts).
 *
 * Plays every fixture of `expectations.json` through the app's own libmpv with the app's own options
 * ([MpvSurfaceView.initOptions]) and checks what mpv reports against the expectation: demuxed codec + size, decoded
 * video size and progress, hardware decoder where required, decoded audio parameters, subtitle text and on-screen
 * pixels (screenshot with the subtitle minus screenshot without it). HLS fixtures go through a loopback HTTP server,
 * like the app's playback proxy; sidecar subtitles through `sub-add`, like the app.
 *
 * Driven by packages/media-deps/scripts/run-media-test-set-android.ts:
 *   adb shell am start -S -W -n com.spacebadger.mobile/com.spacefleet.mpvplayback.mpv.MediaTestSetActivity \
 *     [--es dir <set dir>] [--es only id,id]
 * Default set dir: <external files dir>/media-test-set (adb-writable). Writes `<dir>/report.json` (+ `shots/<id>.png` for
 * subtitle fixtures and failures), logs one `MediaTestSet` line per fixture and `MediaTestSet DONE {...}` at the end,
 * then finishes. libmpv is process-global: never start this while the app's player is open (`am start -S` kills it).
 */
class MediaTestSetActivity : Activity() {
  private lateinit var view: MpvSurfaceView
  private val surfaceReady = CountDownLatch(1)
  private val worker = HandlerThread("MediaTestSet").apply { start() }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    view = MpvSurfaceView(this)
    view.holder.addCallback(object : SurfaceHolder.Callback {
      override fun surfaceCreated(holder: SurfaceHolder) = surfaceReady.countDown()
      override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) = Unit
      override fun surfaceDestroyed(holder: SurfaceHolder) = Unit
    })
    // Same core setup as MpvEngine.attach, before the view's surface callback touches MPVLib.
    MpvFontConfig.install(applicationContext)
    MPVLib.create(applicationContext)
    view.initOptions()
    MPVLib.init()
    MPVLib.setOptionString("msg-level", "all=warn")
    MPVLib.addLogObserver(MpvLogBridge)
    setContentView(FrameLayout(this).apply { addView(view) })

    val dir = File(intent.getStringExtra("dir") ?: File(getExternalFilesDir(null), "media-test-set").path)
    val only = intent.getStringExtra("only")?.split(",")?.map { it.trim() }?.filter { it.isNotEmpty() }?.toSet()
    Handler(worker.looper).post {
      val report = try {
        if (!surfaceReady.await(10, TimeUnit.SECONDS)) error("surface never created")
        Runner(dir, only).run()
      } catch (e: Throwable) {
        Log.e(TAG, "runner crashed", e)
        JSONObject().put("crash", Log.getStackTraceString(e))
      }
      File(dir, "report.json").writeText(report.toString(2))
      Log.i(TAG, "DONE ${report.optJSONObject("summary") ?: report.optString("crash")} report=${File(dir, "report.json")}")
      runOnUiThread { finish() }
    }
  }

  override fun onDestroy() {
    super.onDestroy()
    worker.quitSafely()
    // The process is killed by the next `am start -S`; tearing libmpv down under a live surface aborts (MpvEngine.destroy).
  }

  /** Counts libmpv events so the worker can wait for "the next FILE_LOADED after this point". */
  private object Events : MPVLib.EventObserver {
    val counts = Array(32) { AtomicInteger() }
    override fun eventProperty(property: String) = Unit
    override fun eventProperty(property: String, value: Long) = Unit
    override fun eventProperty(property: String, value: Boolean) = Unit
    override fun eventProperty(property: String, value: String) = Unit
    override fun eventProperty(property: String, value: Double) = Unit
    override fun event(eventId: Int) {
      if (eventId in counts.indices) counts[eventId].incrementAndGet()
    }
  }

  /** mpv warnings and errors of the fixture being played. */
  private object Logs : MPVLib.LogObserver {
    @Volatile var sink: MutableList<String>? = null
    override fun logMessage(prefix: String, level: Int, text: String) {
      if (level <= MPVLib.MpvLogLevel.MPV_LOG_LEVEL_WARN) sink?.let { synchronized(it) { if (it.size < 40) it.add("[$prefix] ${text.trimEnd()}") } }
    }
  }

  private inner class Runner(private val dir: File, private val only: Set<String>?) {
    private val shots = File(dir, "shots").apply { mkdirs() }
    private val http = LoopbackHttp(dir)

    fun run(): JSONObject {
      val expectations = JSONObject(File(dir, "expectations.json").readText())
      val fixtures = expectations.getJSONArray("fixtures")
      MPVLib.addObserver(Events)
      MPVLib.addLogObserver(Logs)
      val results = JSONArray()
      var passed = 0
      Log.i(TAG, "START dir=$dir fixtures=${fixtures.length()} only=$only device=${Build.MANUFACTURER} ${Build.MODEL} sdk=${Build.VERSION.SDK_INT} http=${http.port}")
      for (i in 0 until fixtures.length()) {
        val fixture = fixtures.getJSONObject(i)
        if (only != null && fixture.getString("id") !in only) continue
        val result = runFixture(fixture)
        if (result.getBoolean("pass")) passed++
        results.put(result)
        Log.i(TAG, "${if (result.getBoolean("pass")) "PASS" else "FAIL"} ${fixture.getString("id")} $result")
      }
      http.close()
      return JSONObject()
        .put("version", expectations.getInt("version"))
        .put("generatedBy", expectations.optString("generatedBy"))
        .put("device", JSONObject().put("manufacturer", Build.MANUFACTURER).put("model", Build.MODEL).put("sdk", Build.VERSION.SDK_INT).put("abi", Build.SUPPORTED_ABIS.firstOrNull()))
        .put("mpvVersion", MPVLib.getPropertyString("mpv-version"))
        .put("ffmpegVersion", MPVLib.getPropertyString("ffmpeg-version"))
        .put("summary", JSONObject().put("total", results.length()).put("passed", passed).put("failed", results.length() - passed))
        .put("fixtures", results)
    }

    private fun runFixture(fixture: JSONObject): JSONObject {
      val id = fixture.getString("id")
      val expect = fixture.getJSONObject("expect")
      val video = expect.optJSONObject("video")
      val audio = expect.optJSONObject("audio")
      val sub = expect.optJSONObject("subtitle")
      val image = expect.optBoolean("image")
      val failures = mutableListOf<String>()
      val observed = JSONObject()
      val log = mutableListOf<String>()
      Logs.sink = log
      val result = JSONObject().put("id", id)
      try {
        val url = if (expect.getString("transport") == "hls") "http://127.0.0.1:${http.port}/${fixture.getString("file")}" else File(dir, fixture.getString("file")).path
        val loaded = Events.counts[MPVLib.MpvEvent.MPV_EVENT_FILE_LOADED].get()
        val ended = Events.counts[MPVLib.MpvEvent.MPV_EVENT_END_FILE].get()
        MPVLib.setPropertyBoolean("pause", sub != null)
        val t0 = System.nanoTime()
        view.loadSource(url)
        // FILE_LOADED on success; END_FILE (without FILE_LOADED) when lavf/mpv cannot open it.
        waitFor(10_000) { Events.counts[MPVLib.MpvEvent.MPV_EVENT_FILE_LOADED].get() > loaded || Events.counts[MPVLib.MpvEvent.MPV_EVENT_END_FILE].get() > ended }
        result.put("loadMs", (System.nanoTime() - t0) / 1_000_000)
        if (Events.counts[MPVLib.MpvEvent.MPV_EVENT_FILE_LOADED].get() == loaded) {
          failures += "file never loaded"
          return result
        }
        val tracks = JSONArray(MPVLib.getPropertyString("track-list") ?: "[]")
        observed.put("fileFormat", MPVLib.getPropertyString("file-format"))
        observed.put("tracks", tracks)
        fun track(type: String): JSONObject? = (0 until tracks.length()).map { tracks.getJSONObject(it) }.firstOrNull { it.optString("type") == type }

        if (sub != null) checkSubtitle(id, sub, track("sub"), observed, failures)
        else checkPlayback(id, image, video != null, observed, failures)

        if (video != null) {
          val t = track("video")
          if (t == null) failures += "no video track"
          else {
            if (t.optString("codec") != video.getString("codec")) failures += "video codec ${t.optString("codec")}, expected ${video.getString("codec")}"
            val w = MPVLib.getPropertyInt("video-params/w")
            val h = MPVLib.getPropertyInt("video-params/h")
            observed.put("videoParams", "${w}x$h ${MPVLib.getPropertyString("video-params/pixelformat")} hw=${MPVLib.getPropertyString("video-params/hw-pixelformat")}")
            if (w != video.getInt("width") || h != video.getInt("height")) failures += "decoded ${w}x$h, expected ${video.getInt("width")}x${video.getInt("height")}"
            val hwdec = MPVLib.getPropertyString("hwdec-current")
            observed.put("hwdec", hwdec)
            if (video.optBoolean("platformHwdec") && hwdec?.startsWith("mediacodec") != true) failures += "hwdec-current=$hwdec, expected mediacodec"
          }
        }
        if (audio != null) {
          val t = track("audio")
          if (t == null) failures += "no audio track"
          else {
            if (t.optString("codec") != audio.getString("codec")) failures += "audio codec ${t.optString("codec")}, expected ${audio.getString("codec")}"
            val channels = MPVLib.getPropertyInt("audio-params/channel-count")
            val rate = MPVLib.getPropertyInt("audio-params/samplerate")
            observed.put("audioParams", "${MPVLib.getPropertyString("audio-codec-name")} ch=$channels rate=$rate fmt=${MPVLib.getPropertyString("audio-params/format")} out=${MPVLib.getPropertyString("audio-out-params/samplerate")}")
            if (channels != audio.getInt("channels")) failures += "decoded $channels ch, expected ${audio.getInt("channels")}"
            if (rate != audio.getInt("sampleRate")) failures += "decoded $rate Hz, expected ${audio.getInt("sampleRate")}"
          }
        }
      } catch (e: Throwable) {
        failures += "exception ${e.javaClass.simpleName}: ${e.message}"
        Log.e(TAG, "$id threw", e)
      } finally {
        val ended = Events.counts[MPVLib.MpvEvent.MPV_EVENT_END_FILE].get()
        MPVLib.command(arrayOf("stop"))
        waitFor(3_000) { Events.counts[MPVLib.MpvEvent.MPV_EVENT_END_FILE].get() > ended }
        Logs.sink = null
        result.put("pass", failures.isEmpty()).put("failures", JSONArray(failures)).put("observed", observed).put("mpvLog", JSONArray(synchronized(log) { log.toList() }))
      }
      return result
    }

    /** Plays until 1.5 s (or the end of shorter media) and checks the picture moved through the decoder onto the surface. */
    private fun checkPlayback(id: String, image: Boolean, hasVideo: Boolean, observed: JSONObject, failures: MutableList<String>) {
      val duration = MPVLib.getPropertyDouble("duration")
      val target = if (image || duration == null) 0.0 else minOf(1.5, duration * 0.8)
      val t0 = System.nanoTime()
      val reached = waitFor(15_000) {
        if (image) MPVLib.getPropertyInt("video-params/w") != null
        else (MPVLib.getPropertyDouble("time-pos") ?: 0.0) >= target || MPVLib.getPropertyBoolean("eof-reached") == true
      }
      if (image) Thread.sleep(400) // let the vo present the still
      observed.put("durationS", duration).put("timePos", MPVLib.getPropertyDouble("time-pos")).put("reachMs", (System.nanoTime() - t0) / 1_000_000)
      observed.put("frameDrops", MPVLib.getPropertyInt("frame-drop-count")).put("decoderFrameDrops", MPVLib.getPropertyInt("decoder-frame-drop-count"))
      observed.put("estimatedVfFps", MPVLib.getPropertyDouble("estimated-vf-fps"))
      if (!reached) failures += "playback stalled at ${MPVLib.getPropertyDouble("time-pos")} s (target $target s)"
      if (!hasVideo) return
      val shot = capture()
      if (shot == null) {
        failures += "screenshot failed"
        return
      }
      val lit = litFraction(shot)
      observed.put("litFraction", lit)
      if (lit < 0.10) {
        failures += "picture blank (lit fraction $lit)"
        save(shot, "$id.png")
      }
    }

    /**
     * Selects the track, plays from the start into the cue and pauses there, then screenshots with and without it: the
     * subtitle must change pixels (text and bitmap alike) and, for text formats, `sub-text` must carry the cue.
     * Plays rather than seeks: mpv 0.41 does not show a PGS cue (.sup: one packet per segment) that is already on
     * screen at a seek target until the next display set (desktop mpv too); the phone showed the same for DVB.
     */
    private fun checkSubtitle(id: String, sub: JSONObject, embedded: JSONObject?, observed: JSONObject, failures: MutableList<String>) {
      val sidecar = sub.optString("sidecar").takeIf { it.isNotEmpty() }
      val track = if (sidecar != null) {
        val before = JSONArray(MPVLib.getPropertyString("track-list") ?: "[]").length()
        MPVLib.command(arrayOf("sub-add", File(dir, sidecar).path, "select"))
        waitFor(3_000) { JSONArray(MPVLib.getPropertyString("track-list") ?: "[]").length() > before }
        val tracks = JSONArray(MPVLib.getPropertyString("track-list") ?: "[]")
        observed.put("tracks", tracks)
        (0 until tracks.length()).map { tracks.getJSONObject(it) }.lastOrNull { it.optString("type") == "sub" }
      } else embedded
      if (track == null) {
        failures += "no subtitle track"
        return
      }
      if (track.optString("codec") != sub.getString("codec")) failures += "subtitle codec ${track.optString("codec")}, expected ${sub.getString("codec")}"
      MPVLib.setPropertyInt("sid", track.getInt("id"))
      MPVLib.setPropertyBoolean("pause", false)
      val atS = sub.getDouble("atS")
      if (!waitFor(10_000) { (MPVLib.getPropertyDouble("time-pos") ?: 0.0) >= atS }) failures += "playback never reached the cue at $atS s"
      MPVLib.setPropertyBoolean("pause", true)
      Thread.sleep(700) // vo presents the paused frame with the cue
      val text = MPVLib.getPropertyString("sub-text")
      observed.put("sid", MPVLib.getPropertyString("sid")).put("timePos", MPVLib.getPropertyDouble("time-pos")).put("subText", text)
      val withSub = capture()
      MPVLib.setPropertyString("sid", "no")
      Thread.sleep(500)
      val without = capture()
      if (withSub == null || without == null) {
        failures += "screenshot failed"
        return
      }
      val changed = changedFraction(withSub, without)
      observed.put("subPixelsChanged", changed)
      save(withSub, "$id.png")
      if (changed < 0.002) failures += "subtitle not drawn (changed fraction $changed)"
      val expected = sub.optString("text")
      if (expected.isNotEmpty() && text?.contains(expected) != true) failures += "sub-text '$text', expected '$expected'"
    }

    private fun capture(): Bitmap? {
      val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
      val done = CountDownLatch(1)
      var status = -1
      PixelCopy.request(view, bitmap, { status = it; done.countDown() }, Handler(Looper.getMainLooper()))
      return if (done.await(3, TimeUnit.SECONDS) && status == PixelCopy.SUCCESS) bitmap else null
    }

    private fun save(bitmap: Bitmap, name: String) {
      FileOutputStream(File(shots, name)).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    /** Share of sampled pixels brighter than near-black (letterbox bars stay black). */
    private fun litFraction(bitmap: Bitmap): Double {
      var lit = 0
      var total = 0
      for (y in 0 until bitmap.height step 8) for (x in 0 until bitmap.width step 8) {
        val c = bitmap.getPixel(x, y)
        if (Color.red(c) + Color.green(c) + Color.blue(c) > 3 * 24) lit++
        total++
      }
      return lit.toDouble() / total
    }

    private fun changedFraction(a: Bitmap, b: Bitmap): Double {
      var changed = 0
      var total = 0
      for (y in 0 until a.height step 4) for (x in 0 until a.width step 4) {
        val p = a.getPixel(x, y)
        val q = b.getPixel(x, y)
        if (Math.abs(Color.red(p) - Color.red(q)) + Math.abs(Color.green(p) - Color.green(q)) + Math.abs(Color.blue(p) - Color.blue(q)) > 60) changed++
        total++
      }
      return changed.toDouble() / total
    }

    private fun waitFor(timeoutMs: Long, condition: () -> Boolean): Boolean {
      val deadline = System.currentTimeMillis() + timeoutMs
      while (System.currentTimeMillis() < deadline) {
        if (condition()) return true
        Thread.sleep(20)
      }
      return condition()
    }
  }

  /** Minimal static GET server on 127.0.0.1 for the HLS fixtures (the app's proxy serves HLS the same way). */
  private class LoopbackHttp(private val root: File) {
    // 127.0.0.1 explicitly: Android's InetAddress.getLoopbackAddress() is ::1, which http://127.0.0.1 never reaches.
    private val server = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
    val port: Int = server.localPort
    private val thread = Thread({ while (!server.isClosed) runCatching { serve(server.accept()) } }, "MediaTestSetHttp").apply { isDaemon = true; start() }

    private fun serve(socket: Socket) = Thread {
      socket.use { s ->
        val request = s.getInputStream().bufferedReader().readLine() ?: return@use
        val path = request.split(" ").getOrNull(1)?.substringBefore('?') ?: "/"
        val file = File(root, path.removePrefix("/")).canonicalFile
        val out = s.getOutputStream()
        if (!file.path.startsWith(root.canonicalPath) || !file.isFile) {
          out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
          Log.w(TAG, "http 404 $path")
          return@use
        }
        val type = when (file.extension) {
          "m3u8" -> "application/vnd.apple.mpegurl"
          "ts" -> "video/mp2t"
          "m4s", "mp4" -> "video/mp4"
          else -> "application/octet-stream"
        }
        out.write("HTTP/1.1 200 OK\r\nContent-Type: $type\r\nContent-Length: ${file.length()}\r\nConnection: close\r\n\r\n".toByteArray())
        file.inputStream().use { it.copyTo(out) }
        out.flush()
      }
    }.start()

    fun close() {
      server.close()
      thread.interrupt()
    }
  }

  companion object {
    private const val TAG = "MediaTestSet"
  }
}
