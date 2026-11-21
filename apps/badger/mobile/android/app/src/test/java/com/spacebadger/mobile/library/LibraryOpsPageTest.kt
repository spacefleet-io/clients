package com.spacebadger.mobile.library

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.nio.file.Files
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * @test-id MOBILE-LIB-OPS-PAGE-NATIVE-001
 * @level unit
 * @req LIB-SYNC-15
 * @req LIB-SYNC-14
 * @req LIB-FMT-07
 *
 * @why The phone's JS thread was held 9.4 s per ~3 MB ops page (base64, fflate, UTF-8 in Hermes) and a 3.5 MB op
 *   became a 113 MB String (OutOfMemoryError on a 256 MB heap). `LibrarySync.fetchOpsPage` reads the binary page
 *   (`u64be version | u32be length | envelope` frames, page state in `x-library-*` headers) and opens each op as it
 *   arrives: small ops inline, large ones (or past the page's inline budget) into a file cut at UTF-8 character starts.
 *   A truncated body or an op that does not open must fail the whole page and leave no file behind, and a 426 must
 *   reach JS with its body so the update screen shows.
 */
class LibraryOpsPageTest {
  private val tag = "[MOBILE-LIB-OPS-PAGE-NATIVE-001]"
  private val key = ByteArray(32) { (it * 3).toByte() }
  private var server: FakeServer? = null
  private val dir: File = Files.createTempDirectory("ops-page").toFile()

  private fun log(phase: String, data: String = "") = println("$tag $phase $data")

  @After
  fun tearDown() {
    server?.stop()
    dir.deleteRecursively()
  }

  private fun seal(plain: ByteArray, sealKey: ByteArray = key): ByteArray {
    val iv = ByteArray(12) { (it * 5 + 1).toByte() }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(sealKey, "AES"), GCMParameterSpec(128, iv))
    return iv + cipher.doFinal(plain)
  }

  /** `00 5A 01` + raw deflate of the JSON, then AES-256-GCM: how every v2 writer stores a change. */
  private fun framed(json: String, sealKey: ByteArray = key): ByteArray {
    val deflater = java.util.zip.Deflater(SnapshotCodec.DEFLATE_LEVEL, true)
    val packed = ByteArrayOutputStream()
    java.util.zip.DeflaterOutputStream(packed, deflater).use { it.write(json.toByteArray(Charsets.UTF_8)) }
    deflater.end()
    return seal(SnapshotCodec.FRAME_HEADER + packed.toByteArray(), sealKey)
  }

  private fun frames(vararg ops: Pair<Long, ByteArray>): ByteArray {
    val out = ByteArrayOutputStream()
    DataOutputStream(out).use { data ->
      for ((version, envelope) in ops) {
        data.writeLong(version)
        data.writeInt(envelope.size)
        data.write(envelope)
      }
    }
    return out.toByteArray()
  }

  private class Seen(var path: String? = null, var accept: String? = null, var auth: String? = null)

  /**
   * Minimal HTTP/1.1 server on a socket (the unit-test classpath is android.jar, which has no
   * `com.sun.net.httpserver`): one fixed answer per connection, then the connection closes.
   */
  private class FakeServer(private val respond: (requestLine: String, headers: Map<String, String>) -> ByteArray) {
    private val socket = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
    val port: Int get() = socket.localPort
    private val loop = Thread {
      while (!socket.isClosed) {
        val client = try { socket.accept() } catch (_: java.io.IOException) { break }
        client.use { conn ->
          val input = conn.getInputStream().bufferedReader(Charsets.ISO_8859_1)
          val requestLine = input.readLine() ?: return@use
          val headers = mutableMapOf<String, String>()
          while (true) {
            val line = input.readLine() ?: break
            if (line.isEmpty()) break
            val colon = line.indexOf(':')
            if (colon > 0) headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
          }
          conn.getOutputStream().apply { write(respond(requestLine, headers)); flush() }
        }
      }
    }.apply { isDaemon = true; start() }

    fun stop() {
      socket.close()
      loop.join(2_000)
    }
  }

  private fun serve(
    status: Int = 200,
    body: ByteArray,
    contentType: String = LibraryOpsPage.CONTENT_TYPE,
    headers: Map<String, String> = pageHeaders()
  ): Pair<String, Seen> {
    val seen = Seen()
    val http = FakeServer { requestLine, requestHeaders ->
      seen.path = requestLine.split(' ').getOrNull(1)
      seen.accept = requestHeaders["accept"]
      seen.auth = requestHeaders["authorization"]
      val head = StringBuilder("HTTP/1.1 $status X\r\n")
        .append("Content-Type: $contentType\r\n")
        .append("Content-Length: ${body.size}\r\n")
        .append("Connection: close\r\n")
      for ((name, value) in headers) head.append("$name: $value\r\n")
      head.append("\r\n").toString().toByteArray(Charsets.ISO_8859_1) + body
    }
    server = http
    return "http://127.0.0.1:${http.port}/library/db/ops" to seen
  }

  private fun pageHeaders(version: Long = 42, hasMore: Boolean = false, tooOld: Boolean = false) = mapOf(
    "x-library-version" to "$version",
    "x-library-snapshot-version" to "7",
    "x-library-has-more" to if (hasMore) "1" else "0",
    "x-library-too-old" to if (tooOld) "1" else "0",
    "x-library-storage-format-version" to "2",
    "x-library-op-stream-version" to "4",
    "x-library-target-op-stream-version" to "4"
  )

  private fun fetch(url: String, rawKey: ByteArray = key) =
    LibraryOpsPage.fetch(url, mapOf("Authorization" to "Bearer t", "Accept" to "application/json"), rawKey, 40, dir) { log("native", it) }

  /** JSON of about [bytes] bytes with 2-byte characters, so slice ends must skip continuation bytes. */
  private fun bigJson(bytes: Int): String {
    val sb = StringBuilder(bytes + 64).append("{\"type\":\"media.upsert\",\"title\":\"")
    var i = 0
    var utf8 = sb.length
    while (utf8 < bytes) {
      val token = "épisode-${i++} "
      sb.append(token)
      utf8 += token.length + 1 // "é" is 2 bytes
    }
    return sb.append("\"}").toString()
  }

  private fun readFileSlices(op: LibraryOpsPage.OpenedOp.InFile): String {
    val bytes = File(op.path).readBytes()
    assertEquals(op.jsonBytes, bytes.size.toLong())
    var start = 0
    val text = StringBuilder()
    for (endLong in op.sliceEnds) {
      val end = endLong.toInt()
      if (end < bytes.size) assertTrue("slice end $end starts a character", (bytes[end].toInt() and 0xC0) != 0x80)
      assertTrue("slice $start..$end at most ~2 MiB", end - start < LibraryOpsPage.SLICE_BYTES + 4)
      text.append(String(bytes, start, end - start, Charsets.UTF_8))
      start = end
    }
    return text.toString()
  }

  @Test
  fun `small ops come back inline and large ones in a sliced file`() {
    val small = "{\"type\":\"progress.set\",\"mediaId\":\"m1\"}"
    val v1Plain = "{\"type\":\"settings.set\",\"v\":1}"
    val large = bigJson(5 * 1024 * 1024)
    val body = frames(41L to framed(small), 42L to framed(large), 43L to seal(v1Plain.toByteArray()))
    val (url, seen) = serve(body = body, headers = pageHeaders(version = 43, hasMore = true))
    val page = fetch(url)
    log("page", "version=${page.version} ops=${page.ops.size} bytes=${page.bodyBytes} path=${seen.path}")

    assertEquals("/library/db/ops?since=40", seen.path)
    assertEquals(LibraryOpsPage.CONTENT_TYPE, seen.accept)
    assertEquals("Bearer t", seen.auth)
    assertEquals(43L, page.version)
    assertEquals(7L, page.snapshotVersion)
    assertTrue(page.hasMore)
    assertEquals(false, page.tooOld)
    assertEquals(2L, page.storageFormatVersion)
    assertEquals(4L, page.opStreamVersion)
    assertEquals(4L, page.targetOpStreamVersion)
    assertEquals(body.size.toLong(), page.bodyBytes)
    assertEquals(listOf(41L, 42L, 43L), page.ops.map { it.version })

    val first = page.ops[0] as LibraryOpsPage.OpenedOp.Inline
    assertEquals(small, first.text)
    val second = page.ops[1] as LibraryOpsPage.OpenedOp.InFile
    log("large", "jsonBytes=${second.jsonBytes} slices=${second.sliceEnds.size} path=${second.path}")
    assertTrue("large op is cut in several slices", second.sliceEnds.size >= 3)
    assertEquals(large, readFileSlices(second))
    assertEquals(v1Plain, (page.ops[2] as LibraryOpsPage.OpenedOp.Inline).text)
  }

  @Test
  fun `the page inline budget sends later small ops to files`() {
    val op = "{\"type\":\"media.upsert\",\"pad\":\"" + "x".repeat(200 * 1024) + "\"}"
    val count = LibraryOpsPage.INLINE_PAGE_MAX_BYTES / op.length + 2
    val body = frames(*Array(count) { i -> (i + 1).toLong() to framed(op) })
    val (url, _) = serve(body = body)
    val page = fetch(url)
    val inline = page.ops.count { it is LibraryOpsPage.OpenedOp.Inline }
    val files = page.ops.filterIsInstance<LibraryOpsPage.OpenedOp.InFile>()
    log("budget", "ops=${page.ops.size} inline=$inline files=${files.size}")
    assertEquals(count, page.ops.size)
    assertTrue("inline JSON stays within the page budget", inline.toLong() * op.length <= LibraryOpsPage.INLINE_PAGE_MAX_BYTES)
    assertTrue("ops past the budget go to files", files.isNotEmpty())
    files.forEach { assertEquals(op, readFileSlices(it)) }
  }

  @Test
  fun `a slice never cuts a multibyte character straddling the 2 MiB mark`() {
    // "€" is 3 bytes, "😀" 4: placed so the 2 MiB (and 4 MiB) mark falls on a continuation byte inside each.
    val slice = LibraryOpsPage.SLICE_BYTES
    val head = "{\"t\":\""
    val first = head + "a".repeat(slice - 1 - head.length) + "€"
    // First cut at slice + 2; the next mark (2 * slice + 2) then lands on the emoji's last byte.
    val secondPad = "b".repeat(slice - 1 - (first.toByteArray().size - slice))
    val json = first + secondPad + "😀" + "c".repeat(1000) + "\"}"
    val bytes = json.toByteArray(Charsets.UTF_8)
    log("straddle", "euroAt=${slice - 1} emojiAt=${first.toByteArray().size + secondPad.length} total=${bytes.size}")
    assertEquals("€ starts 1 byte before the mark", 0xE2, bytes[slice - 1].toInt() and 0xff)
    val (url, _) = serve(body = frames(1L to framed(json)))
    val op = fetch(url).ops.single() as LibraryOpsPage.OpenedOp.InFile
    log("straddle.ends", op.sliceEnds.joinToString(","))
    assertEquals("first cut after the 3-byte €", (slice + 2).toLong(), op.sliceEnds[0])
    val emojiStart = first.toByteArray().size + secondPad.length
    assertTrue("second mark falls inside the emoji", emojiStart < op.sliceEnds[0] + slice && op.sliceEnds[0] + slice < emojiStart + 4)
    assertEquals("second cut after the 4-byte emoji", (emojiStart + 4).toLong(), op.sliceEnds[1])
    assertEquals(json, readFileSlices(op))
  }

  @Test
  fun `a too-old page has no ops and no target header reads as null`() {
    val headers = pageHeaders(tooOld = true) - "x-library-target-op-stream-version"
    val (url, _) = serve(body = ByteArray(0), headers = headers)
    val page = fetch(url)
    log("tooOld", "tooOld=${page.tooOld} ops=${page.ops.size}")
    assertTrue(page.tooOld)
    assertEquals(0, page.ops.size)
    assertNull(page.targetOpStreamVersion)
  }

  @Test
  fun `a 426 reaches JS with its body`() {
    val body = "{\"error\":\"app_update_required\",\"reason\":\"library_op_stream\",\"opStreamVersion\":4}"
    val (url, _) = serve(status = 426, body = body.toByteArray(), contentType = "application/json", headers = emptyMap())
    try {
      fetch(url)
      fail("426 must reject")
    } catch (error: LibraryOpsPage.Failure) {
      log("426", "code=${error.code} message=${error.message}")
      assertEquals("HTTP_426", error.code)
      assertEquals(body, error.message)
    }
  }

  @Test
  fun `a JSON answer from an older API is refused, not parsed as frames`() {
    val (url, _) = serve(body = "{\"ops\":[]}".toByteArray(), contentType = "application/json")
    try {
      fetch(url)
      fail("JSON must reject")
    } catch (error: LibraryOpsPage.Failure) {
      log("json", "code=${error.code} message=${error.message}")
      assertEquals("BAD_FRAMES", error.code)
    }
  }

  @Test
  fun `a truncated body or an op that does not open fails the page and leaves no file`() {
    val large = framed(bigJson(3 * 1024 * 1024))
    val good = frames(1L to large)
    val cases = listOf(
      "truncated" to (good + frames(2L to framed("{}")).copyOf(20)) to "BAD_FRAMES",
      "wrong-key" to (good + frames(2L to framed("{}", ByteArray(32) { 9 }))) to "OPEN_FAILED"
    )
    for ((named, code) in cases) {
      val (name, body) = named
      server?.stop()
      val (url, _) = serve(body = body)
      try {
        fetch(url)
        fail("$name must reject")
      } catch (error: LibraryOpsPage.Failure) {
        val left = dir.listFiles()?.size ?: 0
        log("failure", "case=$name code=${error.code} message=${error.message} filesLeft=$left")
        assertEquals(name, code, error.code)
        if (code == "OPEN_FAILED") assertEquals("DECRYPT_FAILED", error.message)
        assertEquals("$name leaves no page file", 0, left)
      }
    }
  }

  @Test
  fun `a key that is not 32 bytes is refused before any request`() {
    try {
      LibraryOpsPage.fetch("http://127.0.0.1:1/library/db/ops", emptyMap(), ByteArray(16), 0, dir)
      fail("short key must reject")
    } catch (error: LibraryOpsPage.Failure) {
      assertEquals("INVALID_KEY", error.code)
    }
  }
}
