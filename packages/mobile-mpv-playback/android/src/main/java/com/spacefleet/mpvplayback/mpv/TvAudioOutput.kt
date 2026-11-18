package com.spacefleet.mpvplayback.mpv

import android.content.Context
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Build
import android.util.Log
import `is`.xyz.mpv.MPVLib
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap

/**
 * TV audio output (MPV-TV-03), native half: reports what the box says about its audio sink, and applies the plan the
 * shared JS planner (`src/tvAudioOutput.ts`) makes from it. The decision lives in JS; this file reads and sets only.
 */
internal object TvAudioOutput {
  private const val TAG = "MpvPlayback"

  // AudioFormat encoding constants by value: E_AC3_JOC (API 28) and DOLBY_TRUEHD (API 25) are newer than minSdk 26 / 24.
  private val ENCODING_NAMES = mapOf(
    2 to "pcm",
    3 to "pcm",
    4 to "pcm",
    5 to "ac3",
    6 to "eac3",
    7 to "dts",
    8 to "dts_hd",
    14 to "truehd",
    18 to "eac3_joc",
  )

  private fun encodingName(encoding: Int): String = ENCODING_NAMES[encoding] ?: "other$encoding"

  private fun deviceType(type: Int): String = when (type) {
    AudioDeviceInfo.TYPE_HDMI -> "hdmi"
    AudioDeviceInfo.TYPE_HDMI_ARC -> "hdmi_arc"
    29 -> "hdmi_earc" // AudioDeviceInfo.TYPE_HDMI_EARC, API 31
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bluetooth"
    AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_HEADSET -> "usb"
    else -> "other"
  }

  /** Same shape as JS `TvAudioReport` (platform `android`). */
  fun report(context: Context): WritableMap {
    val audio = context.getSystemService(AudioManager::class.java)
    val devices = Arguments.createArray()
    audio?.getDevices(AudioManager.GET_DEVICES_OUTPUTS)?.forEach { d ->
      val map = Arguments.createMap()
      map.putString("type", deviceType(d.type))
      val enc = Arguments.createArray()
      d.encodings.map(::encodingName).distinct().forEach(enc::pushString)
      map.putArray("encodings", enc)
      val ch = Arguments.createArray()
      d.channelCounts.forEach(ch::pushInt)
      map.putArray("channelCounts", ch)
      devices.pushMap(map)
    }
    val out = Arguments.createMap()
    out.putString("platform", "android")
    out.putInt("sdk", Build.VERSION.SDK_INT)
    out.putArray("devices", devices)

    // Sticky broadcast: the last HDMI audio plug state, with the sink's encodings (Fire TV and older boxes report here).
    val plug = try {
      val filter = IntentFilter(AudioManager.ACTION_HDMI_AUDIO_PLUG)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        context.registerReceiver(null, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        context.registerReceiver(null, filter)
      }
    } catch (e: Exception) {
      Log.w(TAG, "playback.audio hdmi plug read failed: ${e.message}")
      null
    }
    if (plug == null) {
      out.putNull("hdmiPlug")
    } else {
      val map = Arguments.createMap()
      map.putBoolean("plugged", plug.getIntExtra(AudioManager.EXTRA_AUDIO_PLUG_STATE, 0) == 1)
      val enc = Arguments.createArray()
      (plug.getIntArrayExtra(AudioManager.EXTRA_ENCODINGS) ?: IntArray(0)).map(::encodingName).distinct().forEach(enc::pushString)
      map.putArray("encodings", enc)
      map.putInt("maxChannels", plug.getIntExtra(AudioManager.EXTRA_MAX_CHANNEL_COUNT, 0))
      out.putMap("hdmiPlug", map)
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val attrs = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build()
      val direct = Arguments.createArray()
      for ((encoding, name) in listOf(5 to "ac3", 6 to "eac3", 7 to "dts", 8 to "dts_hd", 14 to "truehd")) {
        val format = AudioFormat.Builder()
          .setEncoding(encoding)
          .setSampleRate(48_000)
          .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
          .build()
        val ok = try {
          AudioTrack.isDirectPlaybackSupported(format, attrs)
        } catch (e: Exception) {
          false
        }
        if (ok) direct.pushString(name)
      }
      out.putArray("direct", direct)
    } else {
      out.putNull("direct")
    }
    return out
  }

  /** The last plan from JS (spdif, channels): kept so a core created after the call starts with it ([initOptions]). */
  @Volatile private var plan: Pair<String, String>? = null

  /** TV only, between `MPVLib.create` and `MPVLib.init` ([MpvSurfaceView.initOptions]). */
  fun applyStoredOptions() {
    val (spdif, channels) = plan ?: return
    MPVLib.setOptionString("audio-spdif", spdif)
    MPVLib.setOptionString("audio-channels", channels)
  }

  /**
   * Stores the JS plan and applies it to the live core when there is one (mpv reopens audio on the change), else the
   * next core starts with it. Logs the chosen path once (release builds included).
   */
  fun apply(spdif: String, channels: String, reason: String) {
    plan = spdif to channels
    val applied = runCatching {
      MpvGuard.setPropertyString("audio-spdif", spdif)
      MpvGuard.setPropertyString("audio-channels", channels)
    }.isSuccess
    val ao = if (applied) MpvGuard.getPropertyString("ao").orEmpty() else "audiotrack,opensles"
    Log.i(
      TAG,
      "playback.audio ao=$ao passthrough=${spdif.ifEmpty { "none" }} pcm-channels=$channels " +
        "applied=${if (applied) "live" else "next-core"} $reason",
    )
  }
}
