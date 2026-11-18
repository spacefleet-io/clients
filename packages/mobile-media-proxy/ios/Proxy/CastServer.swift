import CryptoKit
import Darwin
import Foundation
import React

/// React Native module behind `CastServer` (UX-TV-03, iOS twin of the Kotlin `CastServerModule`): a second instance of the
/// playback proxy that listens on the phone's Wi-Fi address instead of loopback and answers only under the one-time
/// `/cast/<token>/` path. It feeds a Google Cast receiver or AirPlay; the local playback proxy (`PlaybackBridge`) is a separate
/// server with its own spool and is never reused for casting.
@objc(CastServer)
final class CastServer: RCTEventEmitter {
  private let queue = DispatchQueue(label: "CastServer.work")
  private var server: PlaybackHttpServer?

  /// Device event JS (`CastServer.onTraffic`) listens to: the gateway's traffic answers, as `SpacePlaybackTraffic` carries them.
  private static let trafficEvent = "SpaceCastTraffic"

  /// Observation disabled: JS listens through `DeviceEventEmitter`, so events are always forwarded.
  override init() { super.init(disabledObservation: ()) }

  override class func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! { [Self.trafficEvent] }

  @objc(start:libraryKeyBase64:config:token:resolve:reject:)
  func start(
    _ metadataJson: String, libraryKeyBase64: String, config: NSDictionary, token: String,
    resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    queue.async { [self] in
      do {
        // The same shape the JS flow generates and the Kotlin module requires: 32 URL-safe characters.
        guard token.range(of: "^[A-Za-z0-9_-]{32}$", options: .regularExpression) != nil else {
          throw TunnelError(message: "cast_token_malformed")
        }
        guard let libraryKey = Data(base64Encoded: libraryKeyBase64) else {
          throw TunnelError(message: "library_key_base64_invalid")
        }
        guard libraryKey.count == 32 else { throw TunnelError(message: "library_key_size_invalid: \(libraryKey.count)") }
        guard let host = Self.wifiIPv4() else { throw TunnelError(message: "cast_no_wifi") }

        // One cast at a time: a second start replaces the first (its token dies with it).
        server?.stop()
        server = nil

        let masterKey = try MediaCrypto.deriveMasterKey(libraryKey: libraryKey)
        let session = try PlaybackBridge.parseSession(metadataJson)
        // Its own spool, and a traffic sink: the tunnel only renews its gateway session while a sink is set, and the
        // sink carries a stop or a refusal to the cast screen.
        let fetcher = try PlaybackBridge.buildChunkFetcher(
          config, masterKey: masterKey, spoolDir: "cast-spool",
          onTraffic: { [weak self] event in self?.sendEvent(withName: Self.trafficEvent, body: event) })
        let s = PlaybackHttpServer(fetcher: fetcher, lan: PlaybackHttpServer.LanBinding(address: host, token: token))
        try s.start()
        let masterUrl = s.createSession(session)
        server = s
        // The URL holds the token: never log it, only what is needed to debug reachability.
        PlaybackLog.info("cast.start host=\(host) port=\(s.port) videos=\(session.videos.count) audio=\(session.audio.count) subs=\(session.subtitles.count)")
        resolve(["baseUrl": s.baseUrl, "masterUrl": masterUrl, "host": host, "port": Int(s.port)])
      } catch {
        PlaybackLog.error("cast.start.error \(error.localizedDescription)")
        reject("cast_server_error", error.localizedDescription, error)
      }
    }
  }

  @objc(readText:resolve:reject:)
  func readText(_ key: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    queue.async { [self] in
      guard let server else { return reject("cast_not_started", "cast server is not running", nil) }
      do {
        resolve(try server.readText(key: key))
      } catch {
        PlaybackLog.error("cast.readText.error key=\(key) err=\(error.localizedDescription)")
        reject("cast_server_error", error.localizedDescription, error)
      }
    }
  }

  @objc(putText:body:resolve:reject:)
  func putText(
    _ key: String, body: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    queue.async { [self] in
      guard let server else { return reject("cast_not_started", "cast server is not running", nil) }
      server.putText(key: key, body: body)
      resolve(true)
    }
  }

  @objc(stop:reject:)
  func stop(_ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    queue.async { [self] in
      server?.stop()
      server = nil
      resolve(true)
    }
  }

  override func invalidate() {
    // On the work queue like start/stop, so a stop cannot race a start that is still binding.
    queue.sync { [self] in
      server?.stop()
      server = nil
    }
    super.invalidate()
  }

  /// The IPv4 address of the Wi-Fi interface (`en0` on an iPhone), nil when Wi-Fi is off.
  private static func wifiIPv4() -> String? {
    var head: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&head) == 0, let first = head else { return nil }
    defer { freeifaddrs(head) }
    var cursor: UnsafeMutablePointer<ifaddrs>? = first
    while let ifa = cursor {
      defer { cursor = ifa.pointee.ifa_next }
      guard let addr = ifa.pointee.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET),
        String(cString: ifa.pointee.ifa_name) == "en0",
        ifa.pointee.ifa_flags & UInt32(IFF_UP) != 0
      else { continue }
      var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      let rc = getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST)
      if rc == 0 { return String(cString: host) }
    }
    return nil
  }
}
