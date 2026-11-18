import Darwin
import Foundation

// Driver for playback-proxy-connection-release.test.ts: serves segments through the real `PlaybackHttpServer` (iOS and
// tvOS proxy sources compiled for macOS) to clients that read every body, and to clients that reset the connection
// mid-body the way the player does on a seek. Prints one JSON line: how many segment payloads are still alive once
// every client is gone. A payload is alive while anything (a queued send, a connection) still holds its bytes.

final class Live {
  private static let lock = NSLock()
  private static var count = 0
  static func inc() { lock.lock(); count += 1; lock.unlock() }
  static func dec() { lock.lock(); count -= 1; lock.unlock() }
  static var value: Int { lock.lock(); defer { lock.unlock() }; return count }
}

/// Every `getObject` hands out a fresh segment whose bytes count themselves out when freed (no cache: once served and
/// dropped, nothing should hold it).
final class CountingFetcher: ChunkFetcher {
  let size: Int
  init(size: Int) { self.size = size }
  func getObject(_ key: String) throws -> Data {
    let p = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: 16)
    p.initializeMemory(as: UInt8.self, repeating: 0, count: size)
    p.copyMemory(from: Array("styp".utf8), byteCount: 4)
    Live.inc()
    return Data(bytesNoCopy: p, count: size, deallocator: .custom { ptr, _ in ptr.deallocate(); Live.dec() })
  }
  func prefetch(_ key: String) throws {}
  func shutdown() {}
}

/// One GET over a plain socket, as libavformat's tcp protocol does. `resetAfter`: read that many body bytes, then close
/// with SO_LINGER 0 (a TCP reset, what a client closing with unread data sends); nil reads to the end.
func get(port: UInt16, path: String, resetAfter: Int?) -> Int {
  let fd = socket(AF_INET, SOCK_STREAM, 0)
  var addr = sockaddr_in()
  addr.sin_family = sa_family_t(AF_INET)
  addr.sin_port = port.bigEndian
  addr.sin_addr.s_addr = inet_addr("127.0.0.1")
  let rc = withUnsafePointer(to: &addr) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
  }
  precondition(rc == 0, "connect failed: \(errno)")
  let req = "GET \(path) HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=0-\r\n\r\n"
  _ = req.withCString { send(fd, $0, strlen($0), 0) }
  var total = 0
  var buf = [UInt8](repeating: 0, count: 65536)
  while true {
    if let limit = resetAfter, total >= limit { break }
    let n = recv(fd, &buf, buf.count, 0)
    if n <= 0 { break }
    total += n
  }
  if resetAfter != nil {
    var lg = linger(l_onoff: 1, l_linger: 0)
    setsockopt(fd, SOL_SOCKET, SO_LINGER, &lg, socklen_t(MemoryLayout<linger>.size))
  }
  close(fd)
  return total
}

let args = CommandLine.arguments
let segments = Int(args.count > 1 ? args[1] : "40")!
let segmentBytes = Int(args.count > 2 ? args[2] : "4194304")!
let server = PlaybackHttpServer(fetcher: CountingFetcher(size: segmentBytes))
try server.start()
var fullBytes = 0
for i in 0..<segments {
  // Every other request is abandoned 256 KiB into a multi-MiB body: the proxy still has pieces queued when it resets.
  let read = get(port: server.port, path: "/playback/object/seg-\(i).m4s", resetAfter: i % 2 == 1 ? 256 * 1024 : nil)
  if i % 2 == 0 { fullBytes += read }
}
// Freed asynchronously (a failed connection's queued send completes once it is cancelled): give it a moment.
let deadline = Date().addingTimeInterval(10)
while Live.value > 0 && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
print("{\"segments\":\(segments),\"fullBytes\":\(fullBytes),\"livePayloads\":\(Live.value)}")
server.stop()
