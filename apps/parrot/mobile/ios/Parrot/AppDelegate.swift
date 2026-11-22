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
class AppDelegate: UIResponder, UIApplicationDelegate {
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

/// The app's one window scene (`UIApplicationSceneManifest` in both Info.plists, PLAT-MOBILE-09). Once the app has a
/// scene manifest UIKit no longer calls the AppDelegate's URL and user-activity methods: opened links arrive here.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene, let app = UIApplication.shared.delegate as? AppDelegate else {
      NSLog("[parrot.scene] no window scene or no AppDelegate; nothing to show")
      return
    }
    let window = UIWindow(windowScene: windowScene)
    self.window = window
    NSLog(
      "[parrot.scene] connecting: %ld URL(s), %ld user activit(ies)",
      connectionOptions.urlContexts.count, connectionOptions.userActivities.count
    )
    app.showReact(in: window, launchOptions: Self.launchOptions(connectionOptions))
    // A cold start on a same-device sign-in link (ACCT-PAIR-07): showReact kept it from JS, SiblingSignIn takes it.
    for context in connectionOptions.urlContexts {
      _ = SiblingLinks.handleOpenURL(context.url, sourceApplication: context.options.sourceApplication)
    }
  }

  // parrot://auth/provider (ACCT-SIGNIN-05): hand the URL to JS Linking. Same-device sign-in links (ACCT-PAIR-07,
  // parrot://sibling-approval…) stay native: SiblingSignIn takes them, or swallows them from any app but Badger.
  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    let forJs = URLContexts.filter {
      !SiblingLinks.handleOpenURL($0.url, sourceApplication: $0.options.sourceApplication)
    }
    if !forJs.isEmpty { RCTLinkingManager.scene(scene, openURLContexts: forJs) }
  }

  // ACCT-PAIR-06: https://spacefleet.io/pair/parrot?code=... (a Universal Link, the associated domain in the
  // entitlements) reaches JS Linking like a scheme link.
  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    RCTLinkingManager.scene(scene, continue: userActivity)
  }

  /// The launch options the app used to start React with, from the scene's connection options: the link or Universal
  /// Link the app was opened with, which JS reads with `Linking.getInitialURL()` (React Native's own conversion, plus
  /// the source app SiblingSignIn checks).
  private static func launchOptions(_ options: UIScene.ConnectionOptions) -> [UIApplication.LaunchOptionsKey: Any] {
    var launch: [UIApplication.LaunchOptionsKey: Any] = [:]
    if let context = options.urlContexts.first {
      launch[.url] = context.url
      launch[.sourceApplication] = context.options.sourceApplication
    }
    if let activity = options.userActivities.first {
      launch[.userActivityDictionary] = [
        UIApplication.LaunchOptionsKey.userActivityType.rawValue: activity.activityType,
        "UIApplicationLaunchOptionsUserActivityKey": activity,
      ] as [String: Any]
    }
    return launch
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
