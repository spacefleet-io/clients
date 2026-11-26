// The iPhone half of Parrot's release smoke sign-up (REL-TEST-36): a brand-new person taps "Continue with Google" in
// the exact Release build, Safari loads the lane's sign-in stand-in (the host queued the identity), the stand-in sends
// Safari back to `parrot://auth/provider?signinCode=…`, Safari asks to open Parrot, and the app takes the new account
// through the library key step ("I've written it down", "Yes, I understand"; the key step claims the account's first
// library) to the empty library (PAR-EMPTY-01), the Home of a new account.
//
// The host side is scripts/release-smoke/ios.ts --app parrot: it starts the lane, queues the identity, passes the
// lane's API through SMOKE_API_BASE_URL (the app reads it as the `SFSmokeApiBaseUrl` launch argument, honoured by
// simulator bundles only, src/config.ts), reads the app's log for a refused library and deletes the account afterwards.
// Inputs come as TEST_RUNNER_-prefixed environment variables of `xcodebuild test-without-building`, which runs only this
// test of the bundle (-only-testing); ParrotFlowTests stay the dev-stack suite of run-uitests.sh.
//
// Every step logs a `[ios-signup] PHASE` line (the host copies them into its own log); a failure dumps what was on
// screen (identifiers, texts, a screenshot) and logs `[ios-signup] FAIL …`, the line the host reports. Screenshots go to
// SMOKE_SHOTS_DIR (the simulator's test runner writes the Mac's files).
import XCTest

final class ParrotReleaseSmokeTests: XCTestCase {
  private let env = ProcessInfo.processInfo.environment
  private let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
  private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
  private var app: XCUIApplication!
  private var shotIndex = 0

  override func setUpWithError() throws {
    continueAfterFailure = false
    app = XCUIApplication()
  }

  private func log(_ message: String) {
    NSLog("[ios-signup] %@", message)
  }

  private func phase(_ message: String) {
    log("PHASE \(message)")
  }

  /// A full-screen PNG in SMOKE_SHOTS_DIR (whatever app is in front: Safari's prompt is part of the evidence).
  private func shot(_ name: String) {
    shotIndex += 1
    let file = String(format: "%02d-%@.png", shotIndex, name)
    let screenshot = XCUIScreen.main.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = file
    attachment.lifetime = .keepAlways
    add(attachment)
    guard let dir = env["SMOKE_SHOTS_DIR"], !dir.isEmpty else { return }
    let url = URL(fileURLWithPath: dir, isDirectory: true)
    do {
      try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
      try screenshot.pngRepresentation.write(to: url.appendingPathComponent(file))
      log("screenshot \(file)")
    } catch {
      log("screenshot \(file) not written: \(error.localizedDescription)")
    }
  }

  private func dumpState(_ label: String) {
    let ids = app.descendants(matching: .any).matching(NSPredicate(format: "identifier != ''")).allElementsBoundByIndex.map(\.identifier)
    log("state(\(label)): app=\(app.state.rawValue) safari=\(safari.state.rawValue) identifiers=\(ids.prefix(80))")
    log("state(\(label)): texts=\(app.staticTexts.allElementsBoundByIndex.map(\.label).prefix(40)) buttons=\(app.buttons.allElementsBoundByIndex.map(\.label).prefix(40))")
    if safari.state == .runningForeground {
      log("state(\(label)): safari buttons=\(safari.buttons.allElementsBoundByIndex.map(\.label).prefix(30)) alerts=\(safari.alerts.allElementsBoundByIndex.map(\.label))")
    }
    shot("state-\(label.replacingOccurrences(of: " ", with: "-"))")
  }

  private func fail(_ message: String, file: StaticString = #filePath, line: UInt = #line) -> Never {
    dumpState("failed")
    log("FAIL \(message)")
    XCTFail(message, file: file, line: line)
    // continueAfterFailure = false stops the test at XCTFail; this keeps the compiler's Never honest.
    fatalError(message)
  }

  private func byId(_ id: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: id).firstMatch
  }

  /// A permission question iOS puts over the app (notifications, local network): answered "Allow"/"Don't Allow".
  private func answerSystemAlert() -> Bool {
    let alert = springboard.alerts.firstMatch
    guard alert.exists else { return false }
    log("system alert \"\(alert.label)\": buttons \(alert.buttons.allElementsBoundByIndex.map(\.label))")
    for label in ["Allow", "Don’t Allow", "Don't Allow", "OK"] where alert.buttons[label].exists {
      alert.buttons[label].tap()
      log("system alert answered \(label)")
      return true
    }
    return false
  }

  /// The key step's error line (mobile-shell's library key step): the first library claim was refused, e.g. an op stream
  /// the API turns away (426 library_op_stream_update_required).
  private func keyError() -> String? {
    let error = byId("key-error")
    return error.exists ? error.label : nil
  }

  func testNewAccountSignsUpToHome() throws {
    guard let api = env["SMOKE_API_BASE_URL"], !api.isEmpty else { fail("SMOKE_API_BASE_URL is not set (run through scripts/release-smoke/ios.ts --app parrot)") }
    let budget = TimeInterval(env["SMOKE_BUDGET_S"].flatMap(Double.init) ?? 180)
    // Silent like every Parrot UI test (REL-ENV-36): an empty library plays nothing, but the player starts all the same.
    app.launchEnvironment["SF_SILENT"] = "1"
    app.launchArguments += ["-SFSmokeApiBaseUrl", api, "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
    phase("launch the Release build against \(api)")
    app.launch()

    // A phone that never signed in opens on "Choose your language" (UX-SETUP-08 step 0); its Next brings the sign-in.
    let provider = byId("provider-sign-in-google")
    let languageNext = byId("setup-next")
    let loginDeadline = Date().addingTimeInterval(60)
    var languageShotTaken = false
    while !provider.exists && Date() < loginDeadline {
      if answerSystemAlert() { continue }
      if languageNext.exists && languageNext.isHittable {
        if !languageShotTaken { shot("signup-language"); languageShotTaken = true }
        languageNext.tap()
        phase("\"Choose your language\": Next (English)")
        continue
      }
      _ = provider.waitForExistence(timeout: 2)
    }
    guard provider.exists else { fail("no provider-sign-in-google row on the sign-in screen within 60 s (is the lane's API in use? does it list Google?)") }
    if !provider.isHittable { app.swipeUp() }
    shot("signup-login")
    phase("tap Continue with Google")
    provider.tap()

    // Safari loads the stand-in's authorize address, which approves the queued identity and redirects (through the
    // API's callback) to parrot://; Safari then asks before it opens another app.
    phase("wait for Safari to ask to open Parrot")
    guard safari.wait(for: .runningForeground, timeout: 30) else { fail("Safari did not come up within 30 s of the provider tap") }
    let open = safari.buttons["Open"]
    guard open.waitForExistence(timeout: 30) else { fail("Safari did not offer to open Parrot within 30 s (did the stand-in approve? is the API callback reachable?)") }
    shot("signup-safari-open")
    open.tap()
    guard app.wait(for: .runningForeground, timeout: 15) else { fail("Parrot did not come back after Safari's Open") }
    phase("back in Parrot with the sign-in code")

    let home = byId("empty-library")
    let deadline = Date().addingTimeInterval(budget)
    var keyConfirmed = false
    var keyShotTaken = false
    while Date() < deadline {
      if answerSystemAlert() { continue }
      if let error = keyError() {
        fail("the first library could not be created: the key step shows \"\(error)\" (an op stream the API refuses shows here, e.g. 426 library_op_stream_update_required)")
      }
      if home.exists { break }
      // iOS offers to save a password for the stand-in's page; while its sheet shows, every tap waits for it.
      let savePassword = app.sheets.matching(NSPredicate(format: "label == %@", "Save Password?")).firstMatch
      if savePassword.exists, savePassword.buttons["Not Now"].exists {
        log("system \"Save Password?\" sheet: Not Now")
        savePassword.buttons["Not Now"].tap()
        continue
      }
      let keep = byId("account-language-account")
      if keep.exists && keep.isHittable {
        log("account language: keep the account's")
        keep.tap()
        continue
      }
      let warning = byId("key-saved-warning-confirm")
      if warning.exists && warning.isHittable {
        shot("signup-key-warning")
        warning.tap()
        keyConfirmed = true
        phase("\"Yes, I understand\" tapped: the first library is being claimed")
        continue
      }
      let next = byId("setup-next")
      let keyShown = byId("library-key-words-grid").exists
      if keyShown && !keyConfirmed && next.exists && next.isHittable {
        if !keyShotTaken { shot("signup-key-shown"); keyShotTaken = true }
        next.tap()
        phase("\"I've written it down\" tapped")
        continue
      }
      // Later first-setup steps (notifications, error reports) go on with Next; never while the key grid is still up.
      if keyConfirmed && !keyShown && next.exists && next.isHittable && next.isEnabled {
        let indicator = byId("setup-step-indicator")
        log("setup step \"\(indicator.exists ? indicator.label : "-")\": Next")
        next.tap()
        continue
      }
      Thread.sleep(forTimeInterval: 1)
    }
    guard home.exists else {
      fail("the new account did not reach its empty library within \(Int(budget)) s of Safari's Open (key confirmed \(keyConfirmed))")
    }
    guard keyConfirmed else { fail("the library showed without the key step: a new account must write its key down first") }
    // The empty library can paint before the claim's last write settles; a refusal shows within seconds.
    Thread.sleep(forTimeInterval: 3)
    if let error = keyError() { fail("the empty library showed, then the key step reported \"\(error)\"") }
    shot("signup-home")
    phase("the empty library shows for the new account")
  }
}
