import CoreMedia
import Foundation
import MediaProxy
import UIKit
import VideoToolbox

/// The raw facts about this device's decoders. iOS exposes no decoder limit table (no `MediaCodecList`), so the limits are
/// NOT decided here: JS (`src/iosDecoderCaps.ts`, unit-tested) maps the machine id to Apple's published limits for the
/// model and builds the same `DecoderCaps` shape Android returns (PLAY-QUAL-06).
/// The embedded libmpv decodes through VideoToolbox (`hwdec=videotoolbox`) and falls back to FFmpeg's software decoders
/// (h264, hevc, vp9, libdav1d for AV1 — all in our LGPL build).
///
/// Report shape (`IosDecoderReport` in `src/iosDecoderCaps.ts`):
/// - `sdk`: major iOS version.
/// - `machine`: `utsname.machine` (`iPhone12,1` = iPhone 11). On the simulator it is the host's `arm64` / `x86_64`; the
///   simulated model is only logged, since the simulator's decoders are the Mac's.
/// - `simulator`: built for the simulator, JS then uses the conservative limits.
/// - `videoToolbox`: `VTIsHardwareDecodeSupported` per mime. It can only take a codec away (a table that credits a codec
///   the OS says it cannot decode in hardware loses), never add one.
enum DecoderCaps {
  private static let av1: CMVideoCodecType = 0x6176_3031  // 'av01'; the constant only exists in newer SDKs.

  /// The mimes the JS table knows, with the VideoToolbox codec each one asks about.
  private static let codecs: [(mime: String, codec: CMVideoCodecType)] = [
    ("video/avc", kCMVideoCodecType_H264),
    ("video/hevc", kCMVideoCodecType_HEVC),
    ("video/x-vnd.on2.vp9", kCMVideoCodecType_VP9),
    ("video/av01", av1),
  ]

  private static var logged = false
  private static let logLock = NSLock()

  /// `utsname.machine`, e.g. `iPhone12,1`.
  static func machineIdentifier() -> String {
    var info = utsname()
    uname(&info)
    return withUnsafeBytes(of: &info.machine) { raw in
      String(cString: raw.bindMemory(to: CChar.self).baseAddress!)
    }
  }

  static var isSimulator: Bool {
    #if targetEnvironment(simulator)
      return true
    #else
      return false
    #endif
  }

  /// The hardware never changes while the process runs: asked once (a `static let` is initialised lazily and
  /// thread-safely), not on every play.
  private static let videoToolbox: [String: Bool] = {
    var answers: [String: Bool] = [:]
    for entry in codecs {
      answers[entry.mime] = VTIsHardwareDecodeSupported(entry.codec)
    }
    return answers
  }()

  static func report() -> [String: Any] {
    let machine = machineIdentifier()
    let videoToolbox = Self.videoToolbox
    let major = Int(UIDevice.current.systemVersion.split(separator: ".").first ?? "0") ?? 0

    logLock.lock()
    let first = !logged
    logged = true
    logLock.unlock()
    if first {
      let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] ?? "-"
      let vt = codecs.map { "\($0.mime)=\(videoToolbox[$0.mime] == true)" }.joined(separator: " ")
      PlaybackLog.info("playback.decoder.report ios=\(UIDevice.current.systemVersion) machine=\(machine) simulator=\(isSimulator) simulated=\(simulated) videotoolbox: \(vt)")
    }
    return ["sdk": major, "machine": machine, "simulator": isSimulator, "videoToolbox": videoToolbox]
  }
}
