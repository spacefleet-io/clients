package com.spacefleet.mpvplayback.mpv

import android.util.Log
import com.spacefleet.mediaproxy.PlaybackHttpServer

/**
 * The one way to build an mpv `loadfile` command: [options] (comma-joined per-file `key=value`, may be null) plus the
 * decoder options the playback proxy registered for [url] ([PlaybackHttpServer.perFileDecoderOptions]: the MediaCodec
 * operating rate that keeps a timeline seek's keyframe-to-target decode under the 1 s budget).
 */
internal object MpvLoadfile {
  private const val TAG = "MpvPlayback"

  fun args(url: String, options: String?): Array<String> {
    val decoder = PlaybackHttpServer.perFileDecoderOptions(url)
    val all = listOfNotNull(options?.takeIf { it.isNotBlank() }, decoder).joinToString(",")
    Log.i(TAG, "loadfile.options decoder=${decoder ?: "none"} options=$all")
    return if (all.isEmpty()) arrayOf("loadfile", url, "replace") else arrayOf("loadfile", url, "replace", "0", all)
  }
}
