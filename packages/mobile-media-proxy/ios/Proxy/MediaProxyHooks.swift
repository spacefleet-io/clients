import Foundation

/// What a player pod plugs into the proxy, so the proxy itself carries no player (no libmpv). Twin of the Kotlin
/// `MediaProxyHooks`: `MpvPlayback` installs it when its first core is created (`MpvProxyHooks`); an app without that pod
/// (Parrot) leaves it nil. Android's other hook, the MediaCodec operating rate, has no iOS counterpart (VideoToolbox
/// takes no such option).
public enum MediaProxyHooks {
  private static let lock = NSLock()
  private static var bufferCapHook: ((Double) -> Void)?

  /// The high-traffic playback buffer changed (STOR-BW-01): the player shrinks its own cache to `seconds`
  /// (`TrafficBuffer.noCap` = normal). Called on `PlaybackBridge`'s work queue.
  public static var onBufferCap: ((Double) -> Void)? {
    get {
      lock.lock()
      defer { lock.unlock() }
      return bufferCapHook
    }
    set {
      lock.lock()
      defer { lock.unlock() }
      bufferCapHook = newValue
    }
  }
}
