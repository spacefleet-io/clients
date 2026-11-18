package com.spacefleet.mpvplayback.mpv

import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.os.Build
import android.util.Log
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.WritableNativeArray
import com.facebook.react.bridge.WritableNativeMap
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * What this phone can really decode, read from Android's `MediaCodecList(REGULAR_CODECS)` (the start-quality decision, D3).
 *
 * Per mime: the best hardware and the best software decoder (max width/height, frame rate at that size, 10-bit profile).
 * Per probe the JS side asks about (a version's mime + size + frame rate + bit depth): whether any hardware / any software
 * decoder reports `VideoCapabilities.areSizeAndRateSupported`. Only what the device reports; nothing is guessed here.
 * The full table is logged once per process as `playback.decoder.caps` (tag [TAG]).
 */
object DecoderCaps {
  private const val TAG = "MpvPlayback"

  /** Codecs the ladder can contain (avc, hevc) plus the two the log also shows. */
  private val MIMES = listOf("video/avc", "video/hevc", "video/x-vnd.on2.vp9", "video/av01")

  // MediaCodecInfo.CodecProfileLevel values (literals: the HDR10/HDR10+ constants need API 29, minSdk is 26).
  private val HEVC_10BIT = setOf(0x2, 0x1000, 0x2000)
  private val AVC_10BIT = setOf(0x10, 0x20, 0x40)

  private val logged = AtomicBoolean(false)

  private class Decoder(val info: MediaCodecInfo, val mime: String, val caps: MediaCodecInfo.CodecCapabilities) {
    val video: MediaCodecInfo.VideoCapabilities? = caps.videoCapabilities
    val hardware: Boolean = isHardware(info)
    val tenBit: Boolean = caps.profileLevels.any { level ->
      when (mime) {
        "video/hevc" -> level.profile in HEVC_10BIT
        "video/avc" -> level.profile in AVC_10BIT
        else -> false
      }
    }
  }

  private class Limits(val name: String, val maxWidth: Int, val maxHeight: Int, val maxFps: Int?, val tenBit: Boolean)

  /** API 29+ says so; before that the AOSP software decoder names are the only signal. */
  private fun isHardware(info: MediaCodecInfo): Boolean =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      info.isHardwareAccelerated && !info.isSoftwareOnly
    } else {
      val name = info.name
      !(name.startsWith("OMX.google.") || name.startsWith("c2.android.") || name.startsWith("c2.google."))
    }

  /**
   * The device's codec table, built once per process: `MediaCodecList` queries every codec's capabilities, and the
   * hardware does not change while the app runs. `by lazy` is synchronized.
   */
  private val codecInfos: Array<MediaCodecInfo> by lazy { MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos }

  /** [decodersFor] answers, once per mime: every play start asks again for the same four mimes. */
  private val decodersByMime = ConcurrentHashMap<String, List<Decoder>>()

  private fun decodersFor(mime: String): List<Decoder> =
    decodersByMime.computeIfAbsent(mime) { readDecoders(it) }

  private fun readDecoders(mime: String): List<Decoder> =
    codecInfos.mapNotNull { info ->
      if (info.isEncoder || info.supportedTypes.none { it.equals(mime, ignoreCase = true) }) return@mapNotNull null
      try {
        Decoder(info, mime, info.getCapabilitiesForType(mime))
      } catch (e: IllegalArgumentException) {
        null
      }
    }.filter { it.video != null }

  private fun limitsOf(decoders: List<Decoder>): Limits? {
    val best = decoders.maxByOrNull { (it.video!!.supportedWidths.upper.toLong()) * it.video.supportedHeights.upper } ?: return null
    val video = best.video!!
    val width = video.supportedWidths.upper
    val height = video.supportedHeights.upper
    val fps = try {
      video.getSupportedFrameRatesFor(width, height).upper.toInt()
    } catch (e: IllegalArgumentException) {
      null
    }
    return Limits(best.info.name, width, height, fps, decoders.any { it.tenBit })
  }

  private fun supports(decoders: List<Decoder>, width: Int, height: Int, fps: Double, tenBit: Boolean): Boolean =
    decoders.any { decoder ->
      try {
        decoder.video!!.areSizeAndRateSupported(width, height, fps) && (!tenBit || decoder.tenBit)
      } catch (e: IllegalArgumentException) {
        false
      }
    }

  private fun putLimits(parent: WritableMap, key: String, limits: Limits?) {
    if (limits == null) {
      parent.putNull(key)
      return
    }
    val map = WritableNativeMap()
    map.putString("name", limits.name)
    map.putInt("maxWidth", limits.maxWidth)
    map.putInt("maxHeight", limits.maxHeight)
    if (limits.maxFps != null) map.putInt("maxFps", limits.maxFps) else map.putNull("maxFps")
    map.putBoolean("tenBit", limits.tenBit)
    parent.putMap(key, map)
  }

  private fun limitsText(limits: Limits?): String =
    if (limits == null) "none" else "${limits.maxWidth}x${limits.maxHeight}${limits.maxFps?.let { "@$it" } ?: ""}${if (limits.tenBit) "+10bit" else ""}(${limits.name})"

  private val operatingRates = ConcurrentHashMap<String, Int>()

  /** Operating rates tried, highest first (240 measured on the OnePlus 6 at 1920x804; 60 is the usual 4K point). */
  private val OPERATING_RATES = listOf(480, 240, 120, 60)

  /** Mime of an HLS `CODECS` entry (`hvc1.1.6.L120.90` -> `video/hevc`), or null for codecs the ladder does not use. */
  fun mimeForCodecString(codecString: String?): String? =
    when (codecString?.substringBefore('.')?.lowercase()) {
      "hvc1", "hev1" -> "video/hevc"
      "avc1", "avc3" -> "video/avc"
      "vp09" -> "video/x-vnd.on2.vp9"
      "av01" -> "video/av01"
      else -> null
    }

  /**
   * MediaCodec `operating-rate` (fps) that every hardware [mime] decoder accepts at [width]x[height], or null when that is
   * unknown (API < 29, a decoder without performance points, or no point covering the size).
   *
   * Why: a timeline seek decodes from the segment's keyframe to the target (up to ~290 frames on 12 s GOPs) and MediaCodec
   * paces that at real time unless told an operating rate; at 240 the OnePlus 6 decoded it in ~580 ms instead of ~1050 ms.
   * A rate above the decoder's performance point makes configure() fail and mpv fall back to SOFTWARE decoding (480 at
   * 1920x804 did, and the 4K point is only 60), so the rate is the highest of [OPERATING_RATES] that one of the decoder's
   * own performance points covers at the size (PerformancePoint has no getters before API 31; `covers` is API 29). The
   * minimum across hardware decoders is taken because ffmpeg, not us, picks which one is opened.
   */
  fun operatingRateFor(mime: String, width: Int, height: Int): Int? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || width <= 0 || height <= 0) return null
    val cacheKey = "$mime ${width}x$height"
    operatingRates[cacheKey]?.let { return it.takeIf { rate -> rate > 0 } }
    val hardware = decodersFor(mime).filter { it.hardware }
    val perDecoder: List<Int?> = hardware.map { decoder ->
      val points: List<MediaCodecInfo.VideoCapabilities.PerformancePoint>? = decoder.video?.supportedPerformancePoints
      val best = OPERATING_RATES.firstOrNull { rate ->
        val wanted = MediaCodecInfo.VideoCapabilities.PerformancePoint(width, height, rate)
        points?.any { point -> point.covers(wanted) } == true
      }
      Log.i(TAG, "playback.decoder.operating_rate.candidate mime=$mime size=${width}x$height decoder=${decoder.info.name} points=${points?.joinToString("|") ?: "none"} best=${best ?: "none"}")
      best
    }
    val rate = if (perDecoder.isEmpty() || perDecoder.any { it == null }) null else perDecoder.filterNotNull().min()
    Log.i(TAG, "playback.decoder.operating_rate mime=$mime size=${width}x$height decoders=${hardware.size} rate=${rate ?: "none"}")
    operatingRates[cacheKey] = rate ?: 0
    return rate
  }

  /** Full report for JS; [probes] is `[{id, mime, width, height, fps, tenBit}]` (may be null: table only). */
  fun report(probes: ReadableArray?): WritableMap {
    val byMime = MIMES.associateWith { decodersFor(it) }
    val codecs: WritableArray = WritableNativeArray()
    val logParts = mutableListOf<String>()
    for (mime in MIMES) {
      val all = byMime.getValue(mime)
      val hardware = limitsOf(all.filter { it.hardware })
      val software = limitsOf(all.filter { !it.hardware })
      val entry = WritableNativeMap()
      entry.putString("mime", mime)
      putLimits(entry, "hardware", hardware)
      putLimits(entry, "software", software)
      codecs.pushMap(entry)
      logParts += "$mime hw=${limitsText(hardware)} sw=${limitsText(software)}"
    }
    if (logged.compareAndSet(false, true)) {
      Log.i(TAG, "playback.decoder.caps sdk=${Build.VERSION.SDK_INT} ${Build.MANUFACTURER} ${Build.MODEL} ${logParts.joinToString("; ")}")
    }

    val answers: WritableArray = WritableNativeArray()
    if (probes != null) {
      for (index in 0 until probes.size()) {
        val probe = probes.getMap(index) ?: continue
        val mime = probe.getString("mime") ?: continue
        val decoders = byMime[mime] ?: decodersFor(mime)
        val width = probe.getInt("width")
        val height = probe.getInt("height")
        val fps = probe.getDouble("fps")
        val tenBit = probe.hasKey("tenBit") && probe.getBoolean("tenBit")
        val answer = WritableNativeMap()
        answer.putString("id", probe.getString("id") ?: "")
        answer.putBoolean("hardware", supports(decoders.filter { it.hardware }, width, height, fps, tenBit))
        answer.putBoolean("software", supports(decoders.filter { !it.hardware }, width, height, fps, tenBit))
        answers.pushMap(answer)
      }
    }

    val out = WritableNativeMap()
    out.putInt("sdk", Build.VERSION.SDK_INT)
    out.putArray("codecs", codecs)
    out.putArray("probes", answers)
    return out
  }
}
