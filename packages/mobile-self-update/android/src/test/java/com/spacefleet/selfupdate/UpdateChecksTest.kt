package com.spacefleet.selfupdate

import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * REL-UPD-06: what the self-update checks before the system installer sees a file. `entry.jar` is the live
 * repository entry of 2026-11-18, signed by the repository key the app pins.
 */
class UpdateChecksTest {
    private val fingerprint = "CE1B8CE37FC0975EBCA7D9F7B88AF902D258D7AC185AFFDAE41CF87296BDBC14"
    private val entryJar = File(javaClass.classLoader!!.getResource("entry.jar")!!.toURI())

    private fun failsWith(code: String, block: () -> Unit) {
        try {
            block()
            fail("expected $code")
        } catch (e: UpdateCheckFailed) {
            assertEquals(code, e.code)
        }
    }

    @Test
    fun theSignedEntryReadsWithThePinnedKey() {
        val json = UpdateChecks.verifiedEntryJson(entryJar, fingerprint)
        assertTrue(json.contains("\"/index-v2.json\""))
        assertEquals(json, UpdateChecks.verifiedEntryJson(entryJar, fingerprint.lowercase()))
    }

    @Test
    fun anotherKeyIsRefused() {
        failsWith("bad_signature") { UpdateChecks.verifiedEntryJson(entryJar, "00".repeat(32)) }
    }

    @Test
    fun aTamperedOrUnsignedEntryIsRefused() {
        val tampered = File.createTempFile("entry", ".jar")
        val unsigned = File.createTempFile("entry", ".jar")
        try {
            ZipFile(entryJar).use { zip ->
                ZipOutputStream(tampered.outputStream()).use { out ->
                    for (entry in zip.entries()) {
                        val bytes = zip.getInputStream(entry).readBytes()
                        out.putNextEntry(ZipEntry(entry.name))
                        out.write(if (entry.name == "entry.json") bytes.toString(Charsets.UTF_8).replace("f2", "00").toByteArray() else bytes)
                        out.closeEntry()
                    }
                }
                ZipOutputStream(unsigned.outputStream()).use { out ->
                    out.putNextEntry(ZipEntry("entry.json"))
                    out.write(zip.getInputStream(zip.getEntry("entry.json")).readBytes())
                    out.closeEntry()
                }
            }
            failsWith("bad_signature") { UpdateChecks.verifiedEntryJson(tampered, fingerprint) }
            failsWith("bad_signature") { UpdateChecks.verifiedEntryJson(unsigned, fingerprint) }
        } finally {
            tampered.delete()
            unsigned.delete()
        }
    }

    @Test
    fun aFileMustHaveTheIndexedSizeAndHash() {
        val file = File.createTempFile("update", ".apk")
        try {
            file.writeText("badger")
            val hash = UpdateChecks.sha256Hex("badger".toByteArray())
            assertEquals("ff1b4a27562d8ffc821b4d7368818ad7c759cfc2068b7adf0d2712315d67359a", hash)
            UpdateChecks.requireFile(file, hash, 6)
            UpdateChecks.requireFile(file, hash.uppercase(), 6)
            failsWith("size_mismatch") { UpdateChecks.requireFile(file, hash, 7) }
            failsWith("hash_mismatch") { UpdateChecks.requireFile(file, UpdateChecks.sha256Hex("parrot".toByteArray()), 6) }
        } finally {
            file.delete()
        }
    }

    @Test
    fun signersMustBeTheSameSet() {
        val a = "19c4be454fdfa4a4ee1e9dac053b1c2e269f788b95301ba3c91a1a479662f8c4"
        val b = "ab".repeat(32)
        assertTrue(UpdateChecks.sameSigners(listOf(a), listOf(a.uppercase())))
        assertTrue(UpdateChecks.sameSigners(listOf(a, b), listOf(b, a)))
        assertFalse(UpdateChecks.sameSigners(listOf(a), listOf(b)))
        assertFalse(UpdateChecks.sameSigners(listOf(a), listOf(a, b)))
        assertFalse(UpdateChecks.sameSigners(emptyList(), emptyList()))
    }
}
