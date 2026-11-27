package com.spacefleet.mediaproxy

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * @bugfix @regression-proof PAR-PLAY-12 (Chris 2026-11-27): a song stayed at 0:00 with "Playback error:
 * ERROR_CODE_IO_BAD_HTTP_STATUS" while every gateway download was a 200. The loopback proxy answers 502 when a player
 * read of a chunk throws, and a player read threw when a cancel aimed at loading ahead (a preload yielding, a rung
 * switch) reached it, or when the gateway answered its download with a status a new session fixes.
 *
 * Runs [StorageTunnelClient] against a loopback socket server playing the gateway (the JDK's HTTP server is not on the
 * Android unit-test classpath); the download bodies are plain bytes, which
 * [MediaCrypto.decryptSegment] passes through.
 */
class StorageTunnelClientPlayerReadTest {
  private lateinit var server: ServerSocket
  private lateinit var pool: ExecutorService
  private lateinit var client: StorageTunnelClient
  private val sessions = AtomicInteger(0)
  private val downloads = Collections.synchronizedList(ArrayList<String>())
  private val downloadArrived = CountDownLatch(1)
  private val releaseDownload = CountDownLatch(1)
  @Volatile private var holdFirstDownload = false
  /** The status the gateway answers a download on the first session with (null: the session is fine). */
  @Volatile private var firstSessionStatus: Pair<Int, String>? = null

  @Before
  fun setUp() {
    pool = Executors.newCachedThreadPool()
    server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    pool.execute {
      while (!server.isClosed) {
        val socket = runCatching { server.accept() }.getOrNull() ?: break
        pool.execute { serve(socket) }
      }
    }
    client = StorageTunnelClient(
      gatewayCandidates = listOf("http://127.0.0.1:${server.localPort}"),
      authToken = "token",
      appId = "parrot",
      masterKey = ByteArray(32),
      profileId = "profile-1",
      spool = null,
    )
  }

  /** The gateway: one request per connection, answered by its path. */
  private fun gateway(path: String, body: String): Pair<Int, String> = when {
    path.startsWith("/storage/tunnel/session") ->
      200 to JSONObject().put("sessionId", "sid-${sessions.incrementAndGet()}").toString()
    path.startsWith("/storage/tunnel/frame") ->
      200 to JSONObject().put("frame", JSONObject().put("kind", "session.ack")).toString()
    path.startsWith("/storage/tunnel/download") -> {
      val req = JSONObject(body)
      val sid = req.getString("sessionId")
      val key = req.getString("objectKey")
      val n = synchronized(downloads) { downloads.add("$sid:$key"); downloads.size }
      val refusal = firstSessionStatus
      if (refusal != null && sid == "sid-1") {
        refusal.first to JSONObject().put("error", refusal.second).toString()
      } else {
        if (n == 1 && holdFirstDownload) {
          downloadArrived.countDown()
          releaseDownload.await(10, TimeUnit.SECONDS)
        }
        200 to "plain-$key"
      }
    }
    else -> 404 to "{}"
  }

  private fun serve(socket: Socket) {
    runCatching {
      socket.use { s ->
        val input = s.getInputStream()
        val head = generateSequence { line(input) }.takeWhile { it.isNotEmpty() }.toList()
        val path = head.firstOrNull()?.split(" ")?.getOrNull(1) ?: return
        val length = head.drop(1).firstOrNull { it.lowercase().startsWith("content-length:") }
          ?.substringAfter(":")?.trim()?.toInt() ?: 0
        val body = String(ByteArray(length).also { buf ->
          var read = 0
          while (read < length) {
            val n = input.read(buf, read, length - read)
            if (n < 0) break
            read += n
          }
        })
        val (status, text) = gateway(path, body)
        val bytes = text.toByteArray()
        val out = s.getOutputStream()
        out.write("HTTP/1.1 $status X\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
        out.write(bytes)
        out.flush()
      }
    }
  }

  private fun line(input: InputStream): String? {
    val out = ByteArrayOutputStream()
    while (true) {
      val b = input.read()
      if (b < 0) return if (out.size() == 0) null else out.toString()
      if (b == '\n'.code) return out.toString().trimEnd('\r')
      out.write(b)
    }
  }

  @After
  fun tearDown() {
    releaseDownload.countDown()
    server.close()
    pool.shutdownNow()
  }

  private fun text(body: ObjectBody): String =
    String(ByteArrayOutputStream().also { body.writeTo(it, 0, body.length) }.toByteArray())

  /** Runs [block] on its own thread; the result or the throw lands in the returned refs once [done] counts down. */
  private class Run(block: () -> String) {
    val result = AtomicReference<String?>()
    val error = AtomicReference<Throwable?>()
    val done = CountDownLatch(1)

    init {
      Thread {
        try {
          result.set(block())
        } catch (e: Throwable) {
          error.set(e)
        } finally {
          done.countDown()
        }
      }.start()
    }

    fun await(): Run {
      assertTrue("read did not finish", done.await(10, TimeUnit.SECONDS))
      return this
    }
  }

  @Test
  fun aCancelAimedAtLoadingAheadNeverFailsThePlayersOwnRead() {
    holdFirstDownload = true
    val read = Run { client.openObject("chunk-k").let { body -> text(body).also { body.release() } } }
    assertTrue(downloadArrived.await(10, TimeUnit.SECONDS))

    // A preload yielding (PAR-PLAY-07) or a rung switch (PLAY-ABR-04) cancels the keys it was loading ahead.
    val aborted = client.cancelInFlight { it == "chunk-k" }
    releaseDownload.countDown()

    read.await()
    assertNull("the player's read failed: ${read.error.get()}", read.error.get())
    assertEquals("plain-chunk-k", read.result.get())
    assertEquals(0, aborted)
  }

  @Test
  fun aCancelledLoadAheadStillStops() {
    holdFirstDownload = true
    val ahead = Run { client.prefetch("chunk-k"); "done" }
    assertTrue(downloadArrived.await(10, TimeUnit.SECONDS))

    assertEquals(1, client.cancelInFlight { it == "chunk-k" })
    releaseDownload.countDown()

    ahead.await()
    assertTrue("a cancelled load ahead must not finish", ahead.error.get() != null)
    assertEquals(listOf("sid-1:chunk-k"), downloads.toList())

    // The player's read after it fetches the object itself.
    val body = client.openObject("chunk-k")
    assertEquals("plain-chunk-k", text(body))
    body.release()
  }

  @Test
  fun aPlayersReadRenewsTheSessionOnceWhenTheGatewayRefusesIt() {
    for ((status, code) in listOf(401 to "session_user_mismatch", 403 to "forbidden", 410 to "gone", 404 to "invalid_session")) {
      // A fresh gateway and client per refusal; @After stops the last one.
      tearDown()
      sessions.set(0)
      downloads.clear()
      setUp()
      firstSessionStatus = status to code
      val body = try {
        client.openObject("chunk-$status")
      } catch (e: Throwable) {
        fail("a $status $code download was not renewed: ${e.message}")
        return
      }
      assertEquals("plain-chunk-$status", text(body))
      body.release()
      assertEquals(listOf("sid-1:chunk-$status", "sid-2:chunk-$status"), downloads.toList())
    }
  }

  @Test
  fun aStatusANewSessionCannotFixIsNotRetried() {
    firstSessionStatus = 404 to "object_not_found"
    try {
      client.openObject("chunk-missing")
      fail("a missing object must fail")
    } catch (e: TunnelHttpException) {
      assertEquals(404, e.code)
    }
    assertEquals(listOf("sid-1:chunk-missing"), downloads.toList())
  }
}
