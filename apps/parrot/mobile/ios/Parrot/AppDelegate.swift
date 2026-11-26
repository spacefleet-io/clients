import MediaProxy
import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import SiblingSignIn

// Parrot's iPhone app (PLAT-MOBILE-07): the same JS app as Android (index.js registers "Parrot"). Playback is the
// AudioPlayback pod, the local stream proxy and the kept-songs downloads are the MediaProxy pod; both are autolinked.
// The UIScene lifecycle (PLAT-MOBILE-09): iOS 27 stops at launch an app linked against its SDK that has none. The app
// starts its services here; SceneDelegate (below) makes the window and starts React once UIKit connects the scene.
@main
class AppDelegate: UIResponder, UIApplicationDelegate, SpaceSceneReactHost {
  /// The scene's window, set by SceneDelegate.
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

    // Badger on this phone asking to sign in with Parrot's account (ACCT-PAIR-07): the confirm screen is its own
    // React root, shown over the app by SiblingSignIn.
    SiblingLinks.makeApprovalView = { [weak factory] in factory?.rootViewFactory.view(withModuleName: "SiblingApproval") }
    return true
  }

  /// Called by SceneDelegate when UIKit connects the app's scene: React runs in the scene's window.
  func showReact(in window: UIWindow, launchOptions: [UIApplication.LaunchOptionsKey: Any]) {
    self.window = window
    // A cold start on a same-device sign-in link (ACCT-PAIR-07): the link goes to SiblingSignIn, never to JS.
    reactNativeFactory?.startReactNative(
      withModuleName: "Parrot", in: window, launchOptions: SiblingLinks.launchOptionsWithoutSiblingLink(launchOptions))
    NSLog("[parrot.app] started React Native (bundle %@)", Bundle.main.bundleIdentifier ?? "?")
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
}

/// The app's one window scene: the shared SiblingSignIn class (PLAT-MOBILE-09, one copy for Badger and Parrot).
class SceneDelegate: SpaceSceneDelegate {}

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
