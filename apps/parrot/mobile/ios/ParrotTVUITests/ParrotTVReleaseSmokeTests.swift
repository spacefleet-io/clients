// The Apple TV half of Parrot's release smoke sign-up (REL-TEST-36, ACCT-PAIR-01), run by scripts/release-smoke/ios.ts
// --app parrot --device tv before TestFlight (apple-testflight.yaml) on the Release build for the tvOS simulator, against
// a dev-stack lane with production's switches.
//
// A TV never makes an account: the host has just signed a brand-new person up through the stand-in and made their key and
// first library (an empty Parrot library, claimed as Parrot's phone key step claims it: lib/pairedAccount.ts). This test
// shows the pairing code, the host approves it with that account's key, and the TV must open that library and reach Home:
// the TV shell with the empty library (`tv-library-empty`), with no pairing, missing-library or library error on the way.
//
// Inputs (TEST_RUNNER_-prefixed on the host): SMOKE_API_BASE_URL (the lane's API: the app reads it as the
// `SFSmokeApiBaseUrl` launch argument, honoured by simulator bundles only, src/config.ts), SMOKE_SHOTS_DIR (PNG
// screenshots for the evidence), SMOKE_BUDGET_S (approval to Home), TV_E2E_EXCHANGE_DIR (the pairing code goes to
// signin-code.txt there; the simulator's test runner writes the Mac's files). Every step logs `[ios-signup] PHASE …`; a
// failure logs `[ios-signup] FAIL …` (the line the host reports) after a state dump. The code itself is never logged
// (PRIV-PAIR-03).
//
// Every key is a remote button (`XCUIRemote.shared.press`), as in Badger's Apple TV tests (REL-TV-03); the focus helpers
// below are theirs (apps/badger/mobile/e2e-tv/apple-tv/SpaceBadgerTVUITests).
import XCTest

final class ParrotTVReleaseSmokeTests: XCTestCase {
  private let env = ProcessInfo.processInfo.environment
  private let remote = XCUIRemote.shared
  private var app: XCUIApplication!
  private var shotIndex = 0

  override func setUpWithError() throws {
    continueAfterFailure = false
    app = XCUIApplication()
  }

  // MARK: - logging and evidence

  private func log(_ message: String) {
    NSLog("[ios-signup] %@", message)
  }

  private func phase(_ message: String) {
    log("PHASE \(message)")
  }

  /// A full-screen PNG in SMOKE_SHOTS_DIR, also attached to the result bundle.
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
    log("state(\(label)): app=\(app.state.rawValue) focus=\(focusedLabel()) identifiers=\(ids.prefix(80))")
    log("state(\(label)): texts=\(app.staticTexts.allElementsBoundByIndex.map(\.label).prefix(40)) buttons=\(app.buttons.allElementsBoundByIndex.map(\.label).prefix(40))")
  }

  private func fail(_ message: String, file: StaticString = #filePath, line: UInt = #line) -> Never {
    dumpState("failed")
    shot("state-failed")
    log("FAIL \(message)")
    XCTFail(message, file: file, line: line)
    // continueAfterFailure = false stops the test at XCTFail; this keeps the compiler's Never honest.
    fatalError(message)
  }

  /// The host side reads this file (scripts/release-smoke/ios.ts): the code the TV shows, 8 characters.
  private func exchangeWrite(_ name: String, _ text: String) throws {
    guard let dir = env["TV_E2E_EXCHANGE_DIR"], !dir.isEmpty else { fail("TV_E2E_EXCHANGE_DIR is not set (run through scripts/release-smoke/ios.ts --device tv)") }
    let url = URL(fileURLWithPath: dir, isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    try text.write(to: url.appendingPathComponent(name), atomically: true, encoding: .utf8)
  }

  // MARK: - remote and focus

  private func element(_ id: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: id).firstMatch
  }

  private func focusedElement() -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "hasFocus == true")).firstMatch
  }

  private func focusedLabel() -> String {
    let f = focusedElement()
    return f.exists ? "\(f.identifier)|\(f.label)" : "(nothing focused)"
  }

  private func press(_ button: XCUIRemote.Button) {
    log("press \(button)")
    remote.press(button)
    Thread.sleep(forTimeInterval: 0.4)
  }

  /// Waits until `condition` holds (re-read every half second); fails with `what` after `timeout`.
  private func waitUntil(_ what: String, timeout: TimeInterval, _ condition: () -> Bool) {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if condition() {
        log("ok: \(what)")
        return
      }
      Thread.sleep(forTimeInterval: 0.5)
    }
    fail("never reached within \(Int(timeout)) s: \(what)")
  }

  /// The arrow that moves the focus from the box `from` towards `to`; boxes overlapping vertically in one column are
  /// above / below each other all the same (their centres decide).
  private func arrow(from: CGRect, to: CGRect) -> XCUIRemote.Button {
    if to.minY >= from.maxY { return .down }
    if to.maxY <= from.minY { return .up }
    let sameColumn = to.minX < from.maxX && to.maxX > from.minX
    if sameColumn && abs(to.midY - from.midY) > 1 { return to.midY < from.midY ? .up : .down }
    return to.midX < from.midX ? .left : .right
  }

  /// Move the focus onto `target` one arrow at a time, towards its frame; DOWN scrolls while the target is not in the
  /// tree (the language list runs longer than the screen), UP once DOWN no longer moves the focus.
  private func steer(to target: XCUIElement, _ what: String, max: Int = 32) {
    var scrollButton: XCUIRemote.Button = .down
    var before: (label: String, frame: CGRect)?
    for _ in 0..<max {
      if target.exists && target.hasFocus {
        log("focus on \(what): \(focusedLabel())")
        return
      }
      let f = focusedElement()
      guard f.exists else { break }
      if !target.exists {
        let now = (label: focusedLabel(), frame: f.frame)
        if scrollButton == .down, let b = before, b.label == now.label, b.frame == now.frame { scrollButton = .up }
        before = now
        press(scrollButton)
        continue
      }
      let button = arrow(from: f.frame, to: target.frame)
      log("focus \(focusedLabel()) at \(f.frame); \(what) at \(target.frame): \(button)")
      press(button)
    }
    fail("focus never reached \(what)")
  }

  // MARK: - the smoke

  /// The pairing screen's failure, a library the account does not have, a library that could not open, or the key
  /// step's error: the release must stop.
  private func errorShown() -> String? {
    if element("tv-pairing-failure").exists { return "the TV's pairing failed: \"\(element("tv-pairing-failure").label)\"" }
    if element("tv-library-missing").exists { return "the paired TV found no library on the account (tv-library-missing)" }
    if element("tv-library-error").exists { return "the library could not open: \"\(element("tv-library-error").label)\" (an op stream the API refuses shows here, e.g. 426 library_op_stream_update_required)" }
    if element("key-error").exists { return "the library key step shows an error: \"\(element("key-error").label)\"" }
    return nil
  }

  func testReleaseSmokeNewAccountPairsToHome() throws {
    guard let api = env["SMOKE_API_BASE_URL"], !api.isEmpty else { fail("SMOKE_API_BASE_URL is not set (run through scripts/release-smoke/ios.ts --app parrot --device tv)") }
    let budget = TimeInterval(env["SMOKE_BUDGET_S"].flatMap(Double.init) ?? 180)
    // Silent like every Parrot UI test (REL-ENV-36).
    app.launchEnvironment["SF_SILENT"] = "1"
    app.launchArguments += ["-SFSmokeApiBaseUrl", api, "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
    phase("launch the Release build against \(api)")
    app.launch()

    phase("UX-SETUP-08: \"Choose your language\": English, then Next")
    let languageStep = element("tv-language"), english = element("setup-choice-en"), next = element("setup-next")
    let code = element("tv-pairing-short-code")
    let firstScreen = Date().addingTimeInterval(90)
    while !languageStep.exists && !code.exists && Date() < firstScreen { Thread.sleep(forTimeInterval: 0.5) }
    if languageStep.exists {
      shot("signup-tv-language")
      steer(to: english, "English in the language list")
      press(.select)
      waitUntil("the app switched to English", timeout: 10) { next.exists && next.label == "Next" }
      steer(to: next, "the language step's Next")
      press(.select)
      waitUntil("the language step closed", timeout: 20) { !languageStep.exists }
    }

    phase("the signed-out TV shows its pairing code")
    let codeBy = Date().addingTimeInterval(90)
    while !code.exists && Date() < codeBy {
      if let error = errorShown() { fail(error) }
      Thread.sleep(forTimeInterval: 0.5)
    }
    guard code.exists else { fail("no pairing code within 90 s of the language step (does the lane's API answer the TV?)") }
    // The label spells the code one character at a time for a screen reader; the code is the 8 characters.
    let typed = code.label.replacingOccurrences(of: " ", with: "")
    guard typed.range(of: #"^[0-9A-HJKMNP-TV-Z]{8}$"#, options: .regularExpression) != nil else {
      fail("the pairing code is not 8 Crockford characters (\(typed.count) characters shown)")
    }
    shot("signup-tv-pairing-code")
    try exchangeWrite("signin-code.txt", typed)
    phase("pairing code handed to the host (the new account's phone approves it)")

    let shell = element("parrot-tv-shell"), empty = element("tv-library-empty")
    let deadline = Date().addingTimeInterval(budget)
    while Date() < deadline {
      if let error = errorShown() { fail(error) }
      if shell.exists && empty.exists { break }
      Thread.sleep(forTimeInterval: 1)
    }
    guard shell.exists && empty.exists else {
      fail("the paired TV did not reach Home with the new account's empty library within \(Int(budget)) s of the code (shell \(shell.exists), empty \(empty.exists))")
    }
    phase("Home shows the new account's empty library")
    // Home can paint before the library settles; a refusal of a library write shows within seconds.
    Thread.sleep(forTimeInterval: 3)
    if let error = errorShown() { fail("Home showed, then: \(error)") }
    shot("signup-tv-home")
    phase("Home holds for the new account: no pairing or library error")
  }
}
