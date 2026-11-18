package com.spacefleet.mediaproxy

/**
 * What a player module plugs into the proxy, so the proxy itself carries no player (no libmpv). `@space/mobile-mpv-playback`
 * installs both when its React package is created; an app without it (Parrot, Media3) leaves them null.
 */
object MediaProxyHooks {
  /**
   * MediaCodec operating rate (frames/s) the device's decoder accepts for [codecString] at [width]x[height], or null for
   * none; feeds the per-playlist decoder options ([PlaybackHttpServer.perFileDecoderOptions]).
   */
  @Volatile var operatingRate: ((codecString: String?, width: Int, height: Int) -> Int?)? = null

  /** The high-traffic playback buffer changed (STOR-BW-01): the player shrinks its own cache to [seconds] (0 = normal). */
  @Volatile var onBufferCap: ((seconds: Double) -> Unit)? = null
}
