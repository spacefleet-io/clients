// @bugfix @regression-proof PAR-PLAY-12 (Chris 2026-11-27): Swift twin of StorageTunnelClientPlayerReadTest.kt,
// driven by tests/tunnel-player-read-ios.test.ts, whose fake gateway answers the /ctl/* calls. Prints one PASS/FAIL
// line per expectation and exits non-zero when any failed.
import CryptoKit
import Foundation

let gw = "http://127.0.0.1:\(CommandLine.arguments[1])"
var failures = 0
func ctl(_ path: String) -> String {
  let done = DispatchSemaphore(value: 0)
  var out = ""
  URLSession.shared.dataTask(with: URL(string: gw + path)!) { d, _, _ in
    out = String(decoding: d ?? Data(), as: UTF8.self); done.signal()
  }.resume()
  done.wait()
  return out
}
func expect(_ ok: Bool, _ what: String) {
  print((ok ? "PASS " : "FAIL ") + what)
  if !ok { failures += 1 }
}
func newClient() -> StorageTunnelClient {
  StorageTunnelClient(
    gatewayCandidates: [gw], authToken: "token", appId: "parrot", profileId: "profile-1",
    masterKey: SymmetricKey(size: .bits256),
    spool: PlaintextSpool(dir: FileManager.default.temporaryDirectory.appendingPathComponent("pbhs-spool-\(UUID())")))
}
/// Runs `block` on its own thread; `wait()` returns its result or its throw.
final class Run {
  var result: String?
  var error: Error?
  let done = DispatchSemaphore(value: 0)
  init(_ block: @escaping () throws -> String) {
    Thread {
      do { self.result = try block() } catch { self.error = error }
      self.done.signal()
    }.start()
  }
  func wait() -> Run {
    expect(done.wait(timeout: .now() + 10) == .success, "read finished")
    return self
  }
}

// 1. A cancel aimed at loading ahead never fails the player's own read.
do {
  _ = ctl("/ctl/reset?hold=1")
  let client = newClient()
  let read = Run { String(decoding: try client.getObject("chunk-k"), as: UTF8.self) }
  expect(ctl("/ctl/arrived") == "1", "player download reached the gateway")
  let aborted = client.cancelInFlight { $0 == "chunk-k" }
  _ = ctl("/ctl/release")
  _ = read.wait()
  expect(read.error == nil, "player read survived the cancel (error: \(String(describing: read.error)))")
  expect(read.result == "plain-chunk-k", "player read got the object")
  expect(aborted == 0, "cancel skipped the player read (aborted=\(aborted))")
}

// 2. A cancelled load ahead still stops; a later player read fetches the object itself.
do {
  _ = ctl("/ctl/reset?hold=1")
  let client = newClient()
  let ahead = Run { try client.prefetch("chunk-k"); return "done" }
  expect(ctl("/ctl/arrived") == "1", "prefetch download reached the gateway")
  let aborted = client.cancelInFlight { $0 == "chunk-k" }
  expect(aborted == 1, "cancel stopped the load ahead (aborted=\(aborted))")
  _ = ctl("/ctl/release")
  _ = ahead.wait()
  expect(ahead.error != nil, "a cancelled load ahead did not finish")
  let body = try? client.getObject("chunk-k")
  expect(body.map { String(decoding: $0, as: UTF8.self) } == "plain-chunk-k", "player read after the cancel refetched")
}

// 3. A refusal a new session fixes renews once.
for (status, code) in [(401, "session_user_mismatch"), (403, "forbidden"), (410, "gone"), (404, "invalid_session"), (400, "session_not_started")] {
  _ = ctl("/ctl/reset?status=\(status)&code=\(code)")
  let client = newClient()
  let body = try? client.getObject("chunk-\(status)")
  expect(body.map { String(decoding: $0, as: UTF8.self) } == "plain-chunk-\(status)", "\(status) \(code) renewed")
  expect(ctl("/ctl/downloads") == "[\"sid-1:chunk-\(status)\",\"sid-2:chunk-\(status)\"]", "\(status) retried once on sid-2")
}

// 4. A status a new session cannot fix is not retried.
do {
  _ = ctl("/ctl/reset?status=404&code=object_not_found")
  let client = newClient()
  expect((try? client.getObject("chunk-missing")) == nil, "a missing object fails")
  expect(ctl("/ctl/downloads") == "[\"sid-1:chunk-missing\"]", "404 object_not_found not retried")
}

print(failures == 0 ? "ALL PASS" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
