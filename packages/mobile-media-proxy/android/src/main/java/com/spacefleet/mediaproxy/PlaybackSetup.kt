package com.spacefleet.mediaproxy

import android.content.Context
import android.util.Log
import com.facebook.react.bridge.ReadableMap
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import kotlin.math.max

/**
 * What every native HLS server of this package is built from, shared by the loopback playback proxy
 * ([PlaybackBridge]) and the LAN cast server ([CastServerModule]): the ingest metadata -> [HlsSession] parser and the
 * [ChunkFetcher] (storage tunnel with the offline store in front, or offline only).
 */
internal object PlaybackSetup {
  private const val TAG = "PlaybackSetup"

  fun buildChunkFetcher(
    context: Context,
    config: ReadableMap,
    masterKey: ByteArray,
    /** Directory under the cache dir holding this server's plaintext spool: each server owns one, it wipes it on start and stop. */
    spoolDir: String = "playback-spool",
    /** STOR-BW-11: the streaming profile the tunnel session is opened for (null for offline). */
    profileId: String? = null,
    onTraffic: ((String) -> Unit)? = null,
    /** Each object the tunnel downloaded for the player: its size and download time (see [StorageTunnelClient]). */
    onDownloaded: ((Long, Long) -> Unit)? = null,
  ): ChunkFetcher {
    val kind = config.getString("clientKind") ?: "storage-tunnel"
    // One spool per proxy, shared by the tunnel and the offline store: large objects (subtitle sidecars) are
    // decrypted to disk there instead of into the heap.
    val spool = PlaintextSpool(File(context.cacheDir, spoolDir))
    return when (kind) {
      "storage-tunnel" -> {
        // Phase 2B: prefer the array form `gatewayBaseUrls`. Fall back to
        // the singular `gatewayBaseUrl` so existing callers keep working
        // with no waterfall (single-element candidate list).
        val candidates: List<String> = if (config.hasKey("gatewayBaseUrls")) {
          val arr = config.getArray("gatewayBaseUrls")
            ?: throw IllegalStateException("playback_config_invalid: gatewayBaseUrls")
          buildList(arr.size()) {
            for (i in 0 until arr.size()) {
              val entry = arr.getString(i)
              if (!entry.isNullOrBlank()) add(entry.trimEnd('/'))
            }
          }
        } else {
          val single = config.getString("gatewayBaseUrl")
            ?: throw IllegalStateException("playback_config_missing: gatewayBaseUrl(s)")
          listOf(single.trimEnd('/'))
        }
        if (candidates.isEmpty()) {
          throw IllegalStateException("playback_config_invalid: empty gateway candidate list")
        }
        val authToken = config.getString("authToken")
          ?: throw IllegalStateException("playback_config_missing: authToken")
        val appId = config.getString("appId") ?: "badger"
        val clientType = if (config.hasKey("clientType")) config.getString("clientType") else null
        val clientVersion = if (config.hasKey("clientVersion")) config.getString("clientVersion") else null
        Log.i(TAG, "startProxy.profile profileId=$profileId")
        val tunnel = StorageTunnelClient(
          gatewayCandidates = candidates,
          authToken = authToken,
          appId = appId,
          masterKey = masterKey,
          clientType = clientType ?: "client-mobile-playback",
          clientVersion = clientVersion ?: "spacebadger-mobile",
          profileId = profileId,
          spool = spool,
          onTraffic = onTraffic,
          onDownloaded = onDownloaded,
        )
        // Downloaded objects are served from disk first; everything else (not
        // downloaded, or a partially downloaded title) goes through the tunnel.
        OfflineChunkFetcher(OfflineStore(context), masterKey, spool, tunnel)
      }
      // Offline playback (downloaded media): chunks come from the encrypted
      // on-disk store, no network involved. See downloads/OfflineChunkFetcher.
      "offline" -> OfflineChunkFetcher(OfflineStore(context), masterKey, spool)
      else -> throw IllegalStateException("playback_config_unknown_kind: $kind")
    }
  }

  // ---- metadata.json -> HlsSession -----------------------------------------

  fun parseSession(metadataJson: String): HlsSession {
    val root = JSONObject(metadataJson)

    val videosArr = if (root.has("videos") && !root.isNull("videos")) {
      root.getJSONArray("videos")
    } else if (root.has("video") && !root.isNull("video")) {
      Log.w(TAG, "parseSession.legacy_single_video — re-ingest with the multi-track script")
      val arr = JSONArray()
      arr.put(root.getJSONObject("video"))
      arr
    } else {
      throw IllegalStateException("playback_metadata_missing_videos")
    }

    val videos = mutableListOf<HlsVideoVariant>()
    for (i in 0 until videosArr.length()) {
      val vo = videosArr.getJSONObject(i)
      val track = parseTrack(
        initKey = vo.optString("initKey", ""),
        codecString = if (vo.isNull("codecString")) null else vo.optString("codecString", ""),
        durationSeconds = vo.optDouble("durationSeconds", 0.0),
        chunks = vo.getJSONArray("chunks"),
      )
      videos.add(
        HlsVideoVariant(
          id = vo.optString("id", "video-$i"),
          quality = vo.optString("quality", ""),
          bitrateKbps = if (vo.has("bitrateKbps") && !vo.isNull("bitrateKbps")) vo.optInt("bitrateKbps") else null,
          width = if (vo.has("width") && !vo.isNull("width")) vo.optInt("width") else null,
          height = if (vo.has("height") && !vo.isNull("height")) vo.optInt("height") else null,
          track = track,
        )
      )
    }

    val audioArr = root.optJSONArray("audioTracks") ?: JSONArray()
    val audio = mutableListOf<HlsAudioVariant>()
    for (i in 0 until audioArr.length()) {
      val ao = audioArr.getJSONObject(i)
      val track = parseTrack(
        initKey = ao.optString("initKey", ""),
        codecString = if (ao.isNull("codecString")) null else ao.optString("codecString", ""),
        durationSeconds = ao.optDouble("durationSeconds", 0.0),
        chunks = ao.getJSONArray("chunks"),
      )
      audio.add(
        HlsAudioVariant(
          id = ao.optString("id", "audio-$i"),
          language = ao.optString("language", "und"),
          label = ao.optString("label", ao.optString("language", "und")),
          isDefault = ao.optBoolean("isDefault", false),
          track = track,
        )
      )
    }

    val subsArr = root.optJSONArray("subtitleTracks") ?: JSONArray()
    val subtitles = mutableListOf<HlsSubtitleVariant>()
    val canonicalDuration = videos.firstOrNull()?.track?.let { tr ->
      tr.segments.fold(0.0) { acc, seg -> acc + seg.durationSeconds }
    } ?: 0.0
    for (i in 0 until subsArr.length()) {
      val so = subsArr.getJSONObject(i)
      val format = so.optString("format", "")
      if (format != "vtt" && format != "pgs" && format != "vobsub") {
        Log.w(TAG, "parseSession.skip_unknown_subtitle_format id=${so.optString("id", "")} format=$format")
        continue
      }
      subtitles.add(
        HlsSubtitleVariant(
          id = so.optString("id", "subs-$i"),
          language = so.optString("language", "und"),
          label = so.optString("label", so.optString("language", "und")),
          isDefault = so.optBoolean("isDefault", i == 0),
          format = format,
          objectKey = so.optString("url", ""),
          durationSeconds = canonicalDuration,
        )
      )
    }

    if (videos.isEmpty() || videos.first().track.initKey.isEmpty() || videos.first().track.segments.isEmpty()) {
      throw IllegalStateException("playback_hls_missing_tracks")
    }

    return HlsSession(
      id = UUID.randomUUID().toString(),
      mode = "vod",
      videos = videos,
      audio = audio,
      subtitles = subtitles,
    )
  }

  private fun parseTrack(
    initKey: String,
    codecString: String?,
    durationSeconds: Double,
    chunks: JSONArray,
  ): HlsTrack {
    val n = chunks.length()
    val parsedSegments = mutableListOf<HlsSegment>()
    val fallbackDuration = if (n > 0 && durationSeconds > 0) durationSeconds / n else 0.0
    for (i in 0 until n) {
      val c = chunks.getJSONObject(i)
      val start = if (c.has("startSeconds") && !c.isNull("startSeconds"))
        c.getDouble("startSeconds") else null
      val explicitDuration = if (c.has("durationSeconds") && !c.isNull("durationSeconds"))
        c.getDouble("durationSeconds") else null
      val nextStart = if (i + 1 < n) {
        val cn = chunks.getJSONObject(i + 1)
        if (cn.has("startSeconds") && !cn.isNull("startSeconds")) cn.getDouble("startSeconds") else null
      } else null
      val duration: Double = when {
        explicitDuration != null -> max(0.001, explicitDuration)
        start != null && nextStart != null -> max(0.001, nextStart - start)
        start != null && durationSeconds > 0 -> max(0.001, durationSeconds - start)
        else -> max(0.001, fallbackDuration)
      }
      parsedSegments.add(
        HlsSegment(
          key = c.getString("key"),
          durationSeconds = duration,
          startSeconds = start,
        )
      )
    }
    return HlsTrack(
      initKey = initKey,
      codecString = codecString,
      segments = parsedSegments,
    )
  }
}
