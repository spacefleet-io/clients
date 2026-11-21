import XCTest

/// Parrot on the iPhone, end to end against a running dev stack: the phone scenarios of `tests/guided/scenarios`
/// (parrot-phone-empty-library, -language-switch, -offline-keep) plus playback in the foreground and the background.
/// Each test expects a fresh install (`apps/parrot/mobile/ios/scripts/run-uitests.sh` uninstalls the app and resets the
/// simulator keychain before each one) and runs silent (`SF_SILENT=1`, REL-ENV-36).
final class ParrotFlowTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
    ParrotLog.line("==== \(name)")
  }

  /// parrot-phone-empty-library: a new account makes its key in the setup and lands on the empty library.
  func testNewAccountMakesKeyAndShowsEmptyLibrary() throws {
    let email = try ParrotEnv.require("PARROT_EMPTY_EMAIL")
    let password = try ParrotEnv.require("PARROT_EMPTY_PASSWORD")
    let app = launchParrot()
    signIn(app, email: email, password: password)
    step("the setup shows a new key") {
      let grid = waitFor(byId(app, "library-key-words-grid"), "a new key's 12 words", timeout: 45, in: app)
      ParrotLog.line("new key grid shown (label \"\(grid.label)\"; words not logged)")
    }
    finishSetup(app, until: byId(app, "empty-library"), "the empty library")
    step("the empty library has its action and steps, no error") {
      waitFor(byId(app, "empty-library-action"), "Get Parrot for computer", in: app)
      for index in 1...3 {
        waitFor(byId(app, "empty-library-step-\(index)"), "empty-library step \(index)", timeout: 5, in: app)
      }
      XCTAssertFalse(byId(app, "key-error").exists, "no key error once the library shows")
    }
  }

  /// Sign in with the seeded library, play a seeded song, keep playing in the background, then the mini player
  /// and the settings. The album's Play opens the full player (`usePlay`'s `openPlayer`, on unless a caller turns it
  /// off); the mini player shows on the tabs once the album page is left.
  func testSignInPlaysSeededAlbumAndKeepsPlayingInBackground() throws {
    let app = try signInToSeededLibrary()
    let album = step("open the seeded album") { () -> XCUIElement in
      let tile = byId(app, "album-tile")
      waitFor(tile, "an album tile", in: app)
      ParrotLog.line("album tile label=\"\(tile.label)\"")
      tile.tap()
      return waitFor(byId(app, "album-play"), "the album's Play", in: app)
    }
    step("play the album: the full player opens, playing") {
      album.tap()
      waitFor(byId(app, "player-close"), "the full player", in: app)
      waitFor(byLabel(app, "Pause"), "Pause in the full player (playing)", timeout: 30, in: app)
    }
    let remaining = byId(app, "player-remaining")
    let before = step("time runs in the full player") { () -> Int in
      waitFor(remaining, "the remaining time", in: app)
      let first = seconds(of: remaining.label)
      ParrotLog.line("remaining at open=\"\(remaining.label)\" seconds=\(first.map(String.init) ?? "nil")")
      var later: Int?
      waitUntil(remaining, "remaining time drops by 2 s", timeout: 15, in: app) { element in
        later = self.seconds(of: element.label)
        guard let first, let later else { return false }
        return first - later >= 2
      }
      return later ?? 0
    }
    step("background the app for 6 s; the song keeps playing") {
      XCUIDevice.shared.press(.home)
      ParrotLog.line("pressed home; app.state=\(app.state.rawValue)")
      Thread.sleep(forTimeInterval: 6)
      ParrotLog.line("after 6 s in background app.state=\(app.state.rawValue)")
      XCTAssertNotEqual(app.state, .notRunning, "the app was killed in the background")
      app.activate()
      waitFor(remaining, "the remaining time after coming back", in: app)
      let after = seconds(of: remaining.label)
      ParrotLog.line("remaining before background=\(before) after=\(after.map(String.init) ?? "nil") label=\"\(remaining.label)\"")
      guard let after else { return XCTFail("remaining time unreadable: \"\(remaining.label)\"") }
      XCTAssertGreaterThanOrEqual(before - after, 5, "playback paused in the background (UIBackgroundModes audio)")
    }
    step("close the player: the album shows it playing; back on the tabs the mini player plays") {
      byId(app, "player-close").tap()
      waitFor(byId(app, "playing-badge"), "the playing badge on the album", timeout: 10, in: app)
      byId(app, "page-back").tap()
      let mini = waitFor(byId(app, "mini-player"), "the mini player", in: app)
      waitFor(mini.descendants(matching: .any).matching(identifier: "mini-player-toggle")
                .matching(NSPredicate(format: "label == %@", "Pause")).firstMatch,
              "Pause on the mini player's play/pause (playing)", timeout: 10, in: app)
    }
    step("open the settings") {
      byLabel(app, "Settings").tap()
      let signedIn = waitFor(byId(app, "settings-signed-in"), "the signed-in row", in: app)
      ParrotLog.line("signed-in row label=\"\(signedIn.label)\"")
      waitFor(byId(app, "settings-language-list"), "the language list", in: app)
    }
  }

  /// parrot-phone-language-switch: French at once from the settings, then back to English.
  func testLanguageSwitchFromSettings() throws {
    let app = try signInToSeededLibrary()
    step("open the settings") {
      byLabel(app, "Settings").tap()
      waitFor(byId(app, "settings-language-list"), "the language list", in: app)
    }
    step("pick Français: the tabs are French at once") {
      let french = byId(app, "setup-choice-fr")
      scrollTo(french, in: app)
      french.tap()
      waitFor(byLabel(app, "Réglages"), "the Réglages tab", timeout: 10, in: app)
      waitFor(byLabel(app, "Accueil"), "the Accueil tab", timeout: 5, in: app)
      XCTAssertFalse(byLabel(app, "Settings").exists, "no English tab left")
    }
    step("back to English") {
      let english = byId(app, "setup-choice-en")
      scrollTo(english, in: app)
      english.tap()
      waitFor(byLabel(app, "Settings"), "the Settings tab", timeout: 10, in: app)
    }
  }

  /// parrot-phone-offline-keep (the part a test can drive): keep an album and see every song downloaded.
  func testKeepAlbumDownloadsEverySong() throws {
    let app = try signInToSeededLibrary()
    step("open the album") {
      waitFor(byId(app, "album-tile"), "an album tile", in: app).tap()
      waitFor(byId(app, "album-play"), "the album screen", in: app)
    }
    step("keep it on this phone") {
      byId(app, "album-more").tap()
      waitFor(byId(app, "album-menu-keep"), "Save offline", timeout: 10, in: app).tap()
      let choice = byId(app, "keep-choice-option")
      if choice.waitForExistence(timeout: 3) {
        ParrotLog.line("copy choice offered: taking the first (\"\(choice.label)\")")
        choice.tap()
      }
    }
    step("the kept line counts up to done") {
      let line = byId(app, "kept-line")
      waitFor(line, "the kept line", timeout: 20, in: app)
      waitUntil(line, "every song downloaded", timeout: 120, in: app) { element in
        !element.label.hasPrefix("Downloading") && !element.label.isEmpty
      }
    }
  }

  private func signInToSeededLibrary() throws -> XCUIApplication {
    let email = try ParrotEnv.require("PARROT_EMAIL")
    let password = try ParrotEnv.require("PARROT_PASSWORD")
    let words = try ParrotEnv.require("PARROT_KEY_WORDS")
    let app = launchParrot()
    signIn(app, email: email, password: password)
    typeLibraryKey(app, words: words)
    finishSetup(app, until: byId(app, "home-albums"), "the library home")
    return app
  }

  private func scrollTo(_ element: XCUIElement, in app: XCUIApplication) {
    var swipes = 0
    while !(element.exists && element.isHittable), swipes < 8 {
      app.swipeUp()
      swipes += 1
    }
    ParrotLog.line("scrolled \(swipes)x; hittable=\(element.exists && element.isHittable)")
  }
}
