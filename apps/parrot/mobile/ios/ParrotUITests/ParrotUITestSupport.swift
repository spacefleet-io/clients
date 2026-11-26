import XCTest

/// Shared steps for the Parrot iPhone UI tests: launch silently, sign in, type the library key, wait with logs.
///
/// Accounts come from the environment, never from the repo. `xcodebuild` passes every `TEST_RUNNER_<NAME>` variable to
/// this runner as `<NAME>`; `apps/parrot/mobile/ios/scripts/uitest-account.ts` makes the accounts and prints them:
/// - `PARROT_EMAIL`, `PARROT_PASSWORD`, `PARROT_KEY_WORDS` (12 words, space-separated): an account whose Parrot library
///   holds the seeded songs.
/// - `PARROT_EMPTY_EMAIL`, `PARROT_EMPTY_PASSWORD`: a verified account with no library key and nothing uploaded.
enum ParrotEnv {
  static func value(_ name: String) -> String? {
    let raw = ProcessInfo.processInfo.environment[name]?.trimmingCharacters(in: .whitespacesAndNewlines)
    return raw?.isEmpty == false ? raw : nil
  }

  /// The variable, or the test is skipped with the variable's name (never its value) in the log.
  static func require(_ name: String) throws -> String {
    guard let value = value(name) else {
      ParrotLog.line("missing env \(name) (pass TEST_RUNNER_\(name) to xcodebuild)")
      throw XCTSkip("set TEST_RUNNER_\(name) (see apps/parrot/mobile/README-ios.md)")
    }
    return value
  }
}

enum ParrotLog {
  private static let started = Date()

  static func line(_ message: String) {
    let ms = Int(Date().timeIntervalSince(started) * 1000)
    print("[parrot.uitest] +\(ms)ms \(message)")
  }
}

extension XCTestCase {
  /// One logged step: its name shows in the result bundle's activity tree and in the console with timings.
  @discardableResult
  func step<T>(_ name: String, _ body: () throws -> T) rethrows -> T {
    ParrotLog.line("step: \(name)")
    let begin = Date()
    let result = try XCTContext.runActivity(named: name) { _ in try body() }
    ParrotLog.line("done: \(name) (\(Int(Date().timeIntervalSince(begin) * 1000))ms)")
    return result
  }

  /// A fresh app process, silent (REL-ENV-36: the player keeps running at output volume 0) and in English.
  /// `SMOKE_API_BASE_URL` (the Apple CHECKED and FULL suites, REL-TEST-29/32, run these tests on the Release build a
  /// TestFlight upload ships) points that build at the lane's API through the `SFSmokeApiBaseUrl` launch argument,
  /// honoured by simulator builds only, as the release smoke does; without it the app uses its build's own API.
  func launchParrot(language: String = "en") -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["SF_SILENT"] = "1"
    app.launchArguments += ["-AppleLanguages", "(\(language))", "-AppleLocale", "\(language)_US"]
    let api = ParrotEnv.value("SMOKE_API_BASE_URL")
    if let api { app.launchArguments += ["-SFSmokeApiBaseUrl", api] }
    ParrotLog.line("launch the Parrot target app (runner \(Bundle.main.bundleIdentifier ?? "?")) SF_SILENT=1 language=\(language) api=\(api ?? "the build's own")")
    app.launch()
    ParrotLog.line("launched state=\(app.state.rawValue)")
    return app
  }

  /// Waits for `element` to exist; on timeout logs what the screen shows, attaches a screenshot and fails.
  @discardableResult
  func waitFor(_ element: XCUIElement, _ what: String, timeout: TimeInterval = 30, in app: XCUIApplication,
               file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
    let begin = Date()
    if element.waitForExistence(timeout: timeout) {
      ParrotLog.line("found \(what) after \(Int(Date().timeIntervalSince(begin) * 1000))ms")
      return element
    }
    dumpScreen(app, reason: "timeout waiting for \(what)")
    XCTFail("\(what) did not appear within \(Int(timeout))s", file: file, line: line)
    return element
  }

  /// Waits until `predicate` holds for `element` (re-read every half second); logs each new value it sees.
  func waitUntil(_ element: XCUIElement, _ what: String, timeout: TimeInterval = 30, in app: XCUIApplication,
                 file: StaticString = #filePath, line: UInt = #line, _ predicate: (XCUIElement) -> Bool) {
    let deadline = Date().addingTimeInterval(timeout)
    var lastSeen = ""
    while Date() < deadline {
      if element.exists {
        let seen = element.label
        if seen != lastSeen {
          ParrotLog.line("\(what): label=\"\(seen)\"")
          lastSeen = seen
        }
        if predicate(element) {
          ParrotLog.line("\(what): ok")
          return
        }
      }
      RunLoop.current.run(until: Date().addingTimeInterval(0.5))
    }
    dumpScreen(app, reason: "timeout waiting until \(what)")
    XCTFail("\(what) not reached within \(Int(timeout))s (last label \"\(lastSeen)\")", file: file, line: line)
  }

  func dumpScreen(_ app: XCUIApplication, reason: String) {
    ParrotLog.line("screen dump (\(reason)) app.state=\(app.state.rawValue)")
    print(app.debugDescription)
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = reason
    shot.lifetime = .keepAlways
    add(shot)
  }

  func byId(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: id).firstMatch
  }

  /// The first element with exactly this accessibility label, whatever its type: RN pressables without
  /// `accessibilityRole="button"` (MobileAuthButton's "Sign in") show up as `Other`, not `Button`.
  func byLabel(_ app: XCUIApplication, _ label: String) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
  }

  /// The language step (setup step 0) when it shows, then the email and password sign-in.
  func signIn(_ app: XCUIApplication, email: String, password: String) {
    step("pass the language step") {
      let first = byId(app, "setup-next").waitForExistence(timeout: 20) || byId(app, "sign-in").exists
      ParrotLog.line("first screen ready=\(first) setup-next=\(byId(app, "setup-next").exists) sign-in=\(byId(app, "sign-in").exists)")
      if !byId(app, "sign-in").exists, byId(app, "setup-next").exists {
        byId(app, "setup-next").tap()
      }
    }
    step("sign in as the test account") {
      waitFor(byId(app, "sign-in"), "sign-in screen", in: app)
      let emailField = app.textFields.matching(NSPredicate(format: "placeholderValue == %@", "Email")).firstMatch
      let passwordField = app.secureTextFields.matching(NSPredicate(format: "placeholderValue == %@", "Password")).firstMatch
      let rejected = byLabel(app, "Wrong email or password.")
      // The key step (either the boxes to type the account's key or a new key's words) or the library: past sign-in.
      let signedIn = app.descendants(matching: .any).matching(NSPredicate(
        format: "identifier IN %@", ["library-key-words-input", "library-key-words-grid", "home-albums", "empty-library"]
      )).firstMatch
      // A loaded simulator can drop keystrokes from `typeText` (seen: "Wrong email or password." for the right account,
      // 2026-11-13 03:31). The email is read back and retyped until it matches. A rejected sign-in is typed again, and so
      // is one where the tap changed nothing (seen 2026-11-13 04:01: "Sign in" still idle, no error, after 45 s), which
      // is what the button does while it is disabled because the app never received the typed password.
      for attempt in 1...3 {
        waitFor(emailField, "email field", in: app)
        fill(emailField, with: email, readBack: true, "email", in: app)
        waitFor(passwordField, "password field", in: app)
        fill(passwordField, with: password, readBack: false, "password", in: app)
        ParrotLog.line("attempt \(attempt): typed email (\(email.count) chars) and password (\(password.count) chars)")
        let button = byLabel(app, "Sign in")
        waitFor(button, "Sign in button", in: app)
        ParrotLog.line("attempt \(attempt): Sign in enabled=\(button.isEnabled) hittable=\(button.isHittable)")
        button.tap()
        let deadline = Date().addingTimeInterval(45)
        while Date() < deadline, !signedIn.exists, !rejected.exists {
          RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        }
        if signedIn.exists {
          ParrotLog.line("attempt \(attempt): signed in, next screen \"\(signedIn.identifier)\"")
          declineSavePassword(app, wait: 10)
          return
        }
        dumpScreen(app, reason: "sign-in attempt \(attempt): \(rejected.exists ? "rejected" : "no next screen within 45s")")
        if byLabel(app, "Signing in…").exists || byLabel(app, "Signing in...").exists {
          ParrotLog.line("attempt \(attempt): still signing in after 45s; not typing again")
          break
        }
      }
      XCTFail("sign-in did not get past the sign-in screen")
    }
  }

  /// Clears `field` and types `text`; with `readBack` the field's value is compared and the text retyped (3 tries).
  func fill(_ field: XCUIElement, with text: String, readBack: Bool, _ what: String, in app: XCUIApplication) {
    for attempt in 1...3 {
      tapToFocus(field, what, in: app)
      let current = (field.value as? String) ?? ""
      let placeholder = field.placeholderValue ?? ""
      let existing = current == placeholder ? 0 : current.count
      if existing > 0 { field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing + 2)) }
      field.typeText(text)
      guard readBack else { return }
      let typed = (field.value as? String) ?? ""
      if typed == text { return }
      ParrotLog.line("\(what) read back \(typed.count) chars, expected \(text.count) (try \(attempt)): retyping")
    }
    XCTFail("\(what) could not be typed")
  }

  /// Focuses a text field: no tap when it already has the keyboard (an autofocused box), a tap when it is hittable,
  /// else, once it is scrolled above the setup's footer, a tap at its centre (XCUITest reports some on-screen RN inputs
  /// as not hittable). Waits for the keyboard; a tap that brought none (seen 2026-11-13 04:00: an empty system window
  /// over the app after sign-in swallowed it) is tried again after the "Save Password?" sheet had time to show, 3 tries.
  func tapToFocus(_ field: XCUIElement, _ what: String, in app: XCUIApplication) {
    let keyboard = app.keyboards.firstMatch
    for attempt in 1...3 {
      declineSavePassword(app, wait: attempt == 1 ? 0 : 5)
      let focused = (field.value(forKey: "hasKeyboardFocus") as? Bool) ?? false
      if focused, keyboard.exists {
        ParrotLog.line("\(what) already has the keyboard")
        return
      }
      if !field.isHittable { scrollAboveFooter(field, what, in: app) }
      if field.isHittable {
        field.tap()
      } else {
        let footer = byId(app, "setup-next")
        if footer.exists, field.frame.midY >= footer.frame.minY {
          dumpScreen(app, reason: "\(what) still under the setup's footer")
          XCTFail("\(what) at \(field.frame) stays under the footer at \(footer.frame); a tap there presses Back")
          return
        }
        ParrotLog.line("\(what) not hittable at \(field.frame) (try \(attempt)): tapping its centre")
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
      }
      if keyboard.waitForExistence(timeout: 10) { return }
      dumpScreen(app, reason: "no keyboard after tapping \(what) (try \(attempt))")
    }
    XCTFail("no keyboard after tapping \(what) 3 times")
  }

  /// With the keyboard up, a setup step's scroll view ends at its footer (Back and Continue sit over the keyboard), so
  /// the key boxes from row 4 on are scrolled out of sight under it: not hittable, and a tap at a box's centre lands on
  /// "Back" (seen 2026-11-13 04:37: tapping key box 7 sent all three seeded-library tests back to sign-in). Drags the
  /// scroll view up, slowly and from the left margin where no box takes the touch, until `field` clears the footer.
  func scrollAboveFooter(_ field: XCUIElement, _ what: String, in app: XCUIApplication) {
    let footer = byId(app, "setup-next")
    for pass in 1...3 {
      guard footer.exists, field.exists else { return }
      let visibleBottom = footer.frame.minY - 12
      let overlap = field.frame.maxY - visibleBottom
      if overlap <= 0 { return }
      let origin = app.coordinate(withNormalizedOffset: .zero)
      let startY = visibleBottom - 8
      let endY = max(startY - overlap - 24, 120)
      ParrotLog.line("\(what) at \(field.frame) is under the footer (top \(footer.frame.minY)), pass \(pass): dragging \(Int(startY - endY)) pt up")
      origin.withOffset(CGVector(dx: 30, dy: startY)).press(
        forDuration: 0.1, thenDragTo: origin.withOffset(CGVector(dx: 30, dy: endY)), withVelocity: .slow, thenHoldForDuration: 0.3
      )
    }
  }

  /// iOS offers to keep the signed-in password in a "Save Password?" sheet over the app a few seconds after sign-in;
  /// while it shows, every tap on the app waits for it (seen 2026-11-13 03:56: `setup-next` hit point {-1, -1}, then
  /// 88 s stuck). Presses "Not Now" when it shows within `wait` seconds; true when it was there.
  @discardableResult
  func declineSavePassword(_ app: XCUIApplication, wait: TimeInterval = 0) -> Bool {
    let sheet = app.sheets.matching(NSPredicate(format: "label == %@", "Save Password?")).firstMatch
    guard wait > 0 ? sheet.waitForExistence(timeout: wait) : sheet.exists else { return false }
    let notNow = sheet.buttons["Not Now"]
    ParrotLog.line("system \"Save Password?\" sheet: pressing \"Not Now\" (exists=\(notNow.exists))")
    if notNow.exists { notNow.tap() }
    if !sheet.waitForNonExistence(timeout: 10) { dumpScreen(app, reason: "\"Save Password?\" sheet still shows") }
    return true
  }

  /// Types the 12 words, one per box, each read back; then presses Continue if the key is still on screen.
  func typeLibraryKey(_ app: XCUIApplication, words: String) {
    step("type the library key") {
      let list = words.split(separator: " ").map(String.init)
      XCTAssertEqual(list.count, 12, "PARROT_KEY_WORDS must hold 12 words, has \(list.count)")
      waitFor(byId(app, "library-key-words-input"), "library key boxes", in: app)
      // Each word goes into its own box at a person's pace and is read back: one fast `typeText` stream of the 12 words
      // came out garbled on a loaded simulator (2026-11-13 04:23: two boxes held letters of other words, the key
      // was refused and Continue stayed disabled).
      for (index, word) in list.enumerated() {
        let box = byId(app, "library-key-word-\(index + 1)")
        waitFor(box, "key box \(index + 1)", in: app)
        var shown = ""
        for attempt in 1...3 {
          tapToFocus(box, "key box \(index + 1)", in: app)
          shown = keyBoxText(box)
          if shown == word { break }
          if !shown.isEmpty { box.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: shown.count)) }
          for letter in word {
            app.typeText(String(letter))
            RunLoop.current.run(until: Date().addingTimeInterval(0.12))
          }
          shown = keyBoxText(box)
          if shown == word { break }
          ParrotLog.line("key box \(index + 1) reads \(shown.count) letters, expected \(word.count) (try \(attempt)): retyping")
        }
        XCTAssertTrue(shown == word, "key box \(index + 1) could not be typed")
        ParrotLog.line("typed word \(index + 1)/\(list.count)")
      }
      if byId(app, "setup-next").exists, byId(app, "setup-next").isEnabled, byId(app, "library-key-words-input").exists {
        ParrotLog.line("key typed: pressing setup-next")
        byId(app, "setup-next").tap()
      }
    }
  }

  /// The word a key box shows, without the zero-width mark an empty box keeps its caret behind.
  func keyBoxText(_ box: XCUIElement) -> String {
    let value = ((box.value as? String) ?? "").replacingOccurrences(of: "\u{200B}", with: "")
    return value == (box.placeholderValue ?? "") ? "" : value
  }

  /// The setup's remaining steps (a new key's warning, notifications with the system prompt, error reports) until
  /// `done` shows. Each pass logs which screen it saw and what it pressed.
  func finishSetup(_ app: XCUIApplication, until done: XCUIElement, _ what: String, timeout: TimeInterval = 90) {
    step("finish the setup until \(what)") {
      let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
      let deadline = Date().addingTimeInterval(timeout)
      while Date() < deadline {
        if done.exists {
          ParrotLog.line("setup finished: \(what) shows")
          return
        }
        for label in ["Allow", "Don’t Allow", "Don't Allow"] where springboard.buttons[label].exists {
          ParrotLog.line("system prompt: pressing \"\(label)\"")
          springboard.buttons[label].tap()
        }
        if declineSavePassword(app) { continue }
        let confirm = byId(app, "key-saved-warning-confirm")
        let next = byId(app, "setup-next")
        if confirm.exists {
          ParrotLog.line("new key warning: confirming")
          confirm.tap()
        } else if next.exists, next.isHittable, next.isEnabled {
          let indicator = byId(app, "setup-step-indicator")
          ParrotLog.line("setup step \"\(indicator.exists ? indicator.label : "-")\": pressing \"\(next.label)\"")
          next.tap()
        }
        RunLoop.current.run(until: Date().addingTimeInterval(1))
      }
      dumpScreen(app, reason: "setup did not reach \(what)")
      XCTFail("setup did not reach \(what) within \(Int(timeout))s")
    }
  }

  /// Seconds in the player's remaining-time label (`-1:23` or `1:23`), nil when the label is not a time.
  func seconds(of label: String) -> Int? {
    let digits = label.trimmingCharacters(in: CharacterSet(charactersIn: "-−– ")).split(separator: ":").compactMap { Int($0) }
    guard digits.count >= 2 else { return nil }
    return digits.reduce(0) { $0 * 60 + $1 }
  }
}
