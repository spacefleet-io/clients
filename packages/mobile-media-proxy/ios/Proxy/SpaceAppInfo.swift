import Foundation

/// `SpaceAppInfo` (REL-CD-29), iOS/tvOS twin of the Kotlin `AppInfoModule`: the store version
/// (`CFBundleShortVersionString`) the phone and TV apps state on every API call. No `installer` on Apple platforms:
/// every build there comes from the App Store or TestFlight, and `appleDistribution` says which, for the
/// update-required screen only (never sent): a TestFlight build carries a sandbox receipt. Registered by SpaceAppInfo.m.
@objc(SpaceAppInfo)
final class SpaceAppInfo: NSObject {
  /// `Bundle.main` is safe off the main queue.
  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc func constantsToExport() -> [AnyHashable: Any]! {
    let version = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? ""
    let testFlight = Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt"
    return ["appVersion": version, "appleDistribution": testFlight ? "testflight" : "appstore"]
  }
}
