#if os(iOS)
import FirebaseCore
import GoogleCast
#endif
import MediaProxy
import MpvPlayback
import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import SiblingSignIn
import UserNotifications

// The UIScene lifecycle (PLAT-MOBILE-09): iOS 27 stops at launch an app linked against its SDK that has none. The app
// starts its services here; SceneDelegate (below) makes the window and starts React once UIKit connects the scene.
@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  /// The scene's window, set by SceneDelegate: the orientation mask and the tvOS Menu handling below look for it.
  var window: UIWindow?
#if os(tvOS)
  private var menuKeyObserver: NSObjectProtocol?
#endif

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    // Mirrors Android, which applies the google-services plugin only when google-services.json exists:
    // the real GoogleService-Info.plist is gitignored and CI-provisioned, so without it the app starts
    // with push disabled (JS pushHandler logs and carries on) instead of crashing in FirebaseApp.configure().
    // The Apple TV app has no Firebase and no push.
#if os(iOS)
    if Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil {
      FirebaseApp.configure()
    }
#endif

    // Google Cast (UX-TV-03): discovery + default media receiver, created before JS asks for devices. The Bonjour
    // services Cast looks for are declared in Info.plist (NSBonjourServices). The Apple TV app does not cast.
#if os(iOS)
    let castCriteria = GCKDiscoveryCriteria(applicationID: kGCKDefaultMediaReceiverApplicationID)
    GCKCastContext.setSharedInstanceWith(GCKCastOptions(discoveryCriteria: castCriteria))
#endif

    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

#if os(iOS)
    // Reconnect the background download session (and re-attach surviving transfers) as early as possible,
    // before JS comes up: a system relaunch for finished downloads has no JS at all (and, with the UIScene
    // lifecycle, no scene either). The Apple TV app has no downloads (the MediaProxy pod builds its download engine
    // for iOS only).
    _ = DownloadEngine.shared

    // Parrot on this phone asking to sign in with Badger's account (ACCT-PAIR-07): the confirm screen is its own
    // React root, shown over the app by SiblingSignIn.
    SiblingLinks.makeApprovalView = { [weak factory] in factory?.rootViewFactory.view(withModuleName: "SiblingApproval") }

    // Register for remote (silent) notifications so the JS-side push handler
    // can forward APNs tokens to Firebase Messaging. Apple's permission prompt
    // only fires once the user is signed in — that flow is driven from JS via
    // @react-native-firebase/messaging.requestPermission().
    UNUserNotificationCenter.current().delegate = self
    application.registerForRemoteNotifications()
#endif

    return true
  }

  /// Called by SceneDelegate when UIKit connects the app's scene: React runs in the scene's window.
  func showReact(in window: UIWindow, launchOptions: [UIApplication.LaunchOptionsKey: Any]) {
    self.window = window
#if os(tvOS) && DEBUG
    // The Metro banner ("Fast Refresh disconnected", "Loading from Metro") sits over the TV picture and its Dismiss
    // button cannot be focused with the Siri Remote. A Release build never shows it; Metro's own log still has it.
    RCTDevLoadingViewSetEnabled(false)
#endif

    // A cold start on a same-device sign-in link (ACCT-PAIR-07): the link goes to SiblingSignIn, never to JS.
    reactNativeFactory?.startReactNative(
      withModuleName: "SpaceBadgerMobile",
      in: window,
      launchOptions: SiblingLinks.launchOptionsWithoutSiblingLink(launchOptions)
    )

#if os(tvOS)
    letReactTakeMenuFirst()
#endif
  }

  // APNs delivers tokens via native delegate methods even when the JS thread
  // is dormant. We forward to RNFirebaseMessaging — RN Firebase swizzles this
  // by default, but keeping these methods makes the intent explicit and lets
  // future native handlers run alongside Firebase without breaking it.
  func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    // RNFirebase reads `application.delegate?.deviceToken` indirectly via the
    // shared messaging instance — this default handler is intentionally a no-op
    // and exists so subclassing/extension hooks have a target.
  }

  func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    NSLog("[push] APNs registration failed: \(error.localizedDescription)")
  }

#if os(iOS)
  // The system relaunches (or wakes) the app when background download tasks need attention; reconnecting the
  // engine's background session delivers the pending events, then the handler tells the system we are done.
  func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    DownloadEngine.shared.handleBackgroundEvents(identifier: identifier, completion: completionHandler)
  }
#endif

#if os(iOS)
  // Portrait everywhere, landscape only while the player is up (UX-ORIENT-01); the player module flips the mask.
  // Alerts (RN's Alert opens its own window at alert level) follow the mask too. Other windows are full-screen web
  // video (a trailer's YouTube full screen): they rotate freely, as on Android, where the web view releases the
  // activity's lock for its full screen.
  func application(
    _ application: UIApplication,
    supportedInterfaceOrientationsFor window: UIWindow?
  ) -> UIInterfaceOrientationMask {
    guard let window, window !== self.window, window.windowLevel < .alert else { return AppOrientation.mask }
    return .allButUpsideDown
  }
#endif

#if os(tvOS)
  // react-native-tvos hands Menu to JS through a tap recognizer on the React root view while JS holds the key
  // (`TVEventControl.enableTVMenuKey`, see packages/mobile-shell/src/tv/menuKey.ts). A native-stack screen lives in a UINavigationController
  // whose own Menu recognizer sits deeper in the view tree and wins, so it popped the screen before JS saw the key: Menu
  // in the player, meant to close a panel or the controls, left the player. Every other Menu recognizer now waits for
  // React's to fail; while JS does not hold the key, React's recognizer is detached and the system handles Menu as usual.
  private func letReactTakeMenuFirst() {
    menuKeyObserver = NotificationCenter.default.addObserver(
      forName: Notification.Name("RCTTVEnableMenuKeyNotification"), object: nil, queue: .main
    ) { [weak self] _ in
      // React attaches its recognizer asynchronously on the main queue in answer to the same notification.
      DispatchQueue.main.async {
        guard let window = self?.window else { return }
        AppDelegate.deferMenuRecognizers(in: window)
      }
    }
  }

  private static func deferMenuRecognizers(in window: UIWindow) {
    let menu = NSNumber(value: UIPress.PressType.menu.rawValue)
    var found: [(depth: Int, onReactRoot: Bool, recognizer: UIGestureRecognizer)] = []
    func walk(_ view: UIView, _ depth: Int) {
      let onReactRoot = String(describing: type(of: view)).contains("RootView")
      for recognizer in view.gestureRecognizers ?? [] where recognizer.allowedPressTypes.contains(menu) {
        found.append((depth, onReactRoot, recognizer))
      }
      view.subviews.forEach { walk($0, depth + 1) }
    }
    walk(window, 0)
    guard let react = found.filter(\.onReactRoot).min(by: { $0.depth < $1.depth })?.recognizer else {
      NSLog("[tv.menuKey] no React Menu recognizer found")
      return
    }
    let others = found.map(\.recognizer).filter { $0 !== react }
    others.forEach { $0.require(toFail: react) }
    NSLog("[tv.menuKey] %d native Menu recognizer(s) now wait for React's", others.count)
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
      NSLog("[scene] no window scene or no AppDelegate; nothing to show")
      return
    }
    let window = UIWindow(windowScene: windowScene)
    self.window = window
    NSLog(
      "[scene] connecting: %ld URL(s), %ld user activit(ies)",
      connectionOptions.urlContexts.count, connectionOptions.userActivities.count
    )
    app.showReact(in: window, launchOptions: Self.launchOptions(connectionOptions))
    // A cold start on a same-device sign-in link (ACCT-PAIR-07): showReact kept it from JS, SiblingSignIn takes it.
    for context in connectionOptions.urlContexts {
      _ = SiblingLinks.handleOpenURL(context.url, sourceApplication: context.options.sourceApplication)
    }
  }

  // spacebadger://auth/provider (ACCT-SIGNIN-05): hand the URL to JS Linking. Same-device sign-in links (ACCT-PAIR-07,
  // spacebadger://sibling-approval…) stay native: SiblingSignIn takes them, or swallows them from any app but Parrot.
  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    let forJs = URLContexts.filter {
      !SiblingLinks.handleOpenURL($0.url, sourceApplication: $0.options.sourceApplication)
    }
    if !forJs.isEmpty { RCTLinkingManager.scene(scene, openURLContexts: forJs) }
  }

  // ACCT-PAIR-06: https://spacefleet.io/pair/badger?code=... (a Universal Link, the associated domain in the
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

#if os(iOS)
extension AppDelegate: UNUserNotificationCenterDelegate {
  // Foreground presentation: show the banner so the user notices a sync
  // signal, even though the JS side already kicks off syncFromRemoteIfNewer.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound, .badge])
  }
}
#endif

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
