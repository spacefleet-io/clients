package com.spacefleet.mediaproxy

/**
 * What one silo (one gateway, one link) says about its load (STOR-BW-01, STOR-BW-09): the wire `traffic` object of a tunnel
 * session response, a `session.ack` frame and `GET /storage/traffic` (`packages/shared/src/storageTunnel.ts`
 * `parseStorageTraffic`). [high] = `state == "high"`; [saturated] = the silo's link is saturated and an `export` flow
 * (an offline download) gets zero bytes until it lifts.
 */
data class TrafficReport(val high: Boolean, val playbackBufferSeconds: Int?, val saturated: Boolean) {
  companion object {
    /** The report of a quiet silo, and what a gateway that sends none reads as. */
    val NORMAL = TrafficReport(high = false, playbackBufferSeconds = null, saturated = false)

    /** Mirrors `parseStorageTraffic`: an unknown `state` yields null (old gateways send no report). */
    fun fromFields(state: String?, playbackBufferSeconds: Double?, saturated: Boolean): TrafficReport? {
      if (state != "normal" && state != "high") return null
      val seconds = playbackBufferSeconds
      val buffer = if (state == "high" && seconds != null && seconds.isFinite() && seconds > 0) Math.round(seconds).toInt() else null
      return TrafficReport(high = state == "high", playbackBufferSeconds = buffer, saturated = saturated)
    }
  }
}

