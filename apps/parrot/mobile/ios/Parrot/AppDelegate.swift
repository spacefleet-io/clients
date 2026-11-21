import MediaProxy
import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

// Parrot's iPhone app (PLAT-MOBILE-07): the same JS app as Android (index.js registers "Parrot"). Playback is the
// AudioPlayback pod, the local stream proxy and the kept-songs downloads are the MediaProxy pod; both are autolinked.
@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    // Reconnect the background download session (kept songs, PAR-OFFL-01) before JS comes up: a system relaunch for
    // finished downloads has no JS at all. The Apple TV app (ParrotTV, PAR-TV-01) keeps no songs: MediaProxy builds its
    // downloads for iOS only.
    #if os(iOS)
      _ = DownloadEngine.shared
    #endif

    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(withModuleName: "Parrot", in: window, launchOptions: launchOptions)
    NSLog("[parrot.app] started React Native (bundle %@)", Bundle.main.bundleIdentifier ?? "?")
    return true
  }

  #if os(iOS)
    // The system relaunches (or wakes) the app when background download tasks need attention; reconnecting the
    // engine's background session delivers the pending events, then the handler tells the system we are done.
    func application(
      _ application: UIApplication,
      handleEventsForBackgroundURLSession identifier: String,
      completionHandler: @escaping () -> Void
    ) {
      NSLog("[parrot.app] background URL session events for %@", identifier)
      DownloadEngine.shared.handleBackgroundEvents(identifier: identifier, completion: completionHandler)
    }
  #endif

  // parrot://auth/provider (ACCT-SIGNIN-05): hand the URL to JS Linking.
  func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return RCTLinkingManager.application(app, open: url, options: options)
  }

  // ACCT-PAIR-06: https://spacefleet.io/pair/parrot?code=... (a Universal Link, the associated domain in the
  // entitlements) reaches JS Linking like a scheme link.
  func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    return RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
