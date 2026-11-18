package com.spacefleet.selfupdate

import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import java.security.cert.Certificate
import java.util.jar.JarFile

/**
 * The checks that stand between our update feed and the system installer (REL-UPD-06), plain JVM code so the JUnit
 * tests run them (src/test): the signed repository entry, the hash of each downloaded file, and the signing
 * certificates of the new APK against the installed app's.
 */
object UpdateChecks {
    /** Lowercase hex SHA-256 of the bytes. */
    fun sha256Hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).toHex()

    /** Lowercase hex SHA-256 of a stream, read to its end. */
    fun sha256Hex(input: InputStream): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            digest.update(buffer, 0, read)
        }
        return digest.digest().toHex()
    }

    /** The file is exactly the one the signed index names: its size, then its SHA-256. Throws `UpdateCheckFailed`. */
    fun requireFile(file: File, sha256: String, size: Long) {
        if (file.length() != size) throw UpdateCheckFailed("size_mismatch", "${file.name}: ${file.length()} bytes, expected $size")
        val actual = file.inputStream().use(::sha256Hex)
        if (!actual.equals(sha256, ignoreCase = true)) throw UpdateCheckFailed("hash_mismatch", "${file.name}: $actual, expected $sha256")
    }

    /**
     * The same signers, compared as sets of certificate SHA-256s: Android installs an update over the app only when
     * they match, so an APK signed by anyone else is refused before the installer sees it. Empty sets never match.
     */
    fun sameSigners(a: Collection<String>, b: Collection<String>): Boolean {
        val left = a.map { it.lowercase() }.toSet()
        val right = b.map { it.lowercase() }.toSet()
        return left.isNotEmpty() && left == right
    }

    /**
     * Reads `entry.json` from the repository's `entry.jar` after verifying the JAR signature, and requires that every
     * file in it is signed by the certificate whose SHA-256 is `fingerprint` (the repository key the app pins).
     * Throws `UpdateCheckFailed` for an unsigned, tampered or foreign-signed JAR.
     */
    fun verifiedEntryJson(jar: File, fingerprint: String): String {
        var entryJson: String? = null
        JarFile(jar, true).use { file ->
            for (entry in file.entries()) {
                if (entry.isDirectory) continue
                // Reading the whole entry is what makes JarFile check it against the signature (SecurityException).
                val bytes = try {
                    file.getInputStream(entry).use { it.readBytes() }
                } catch (e: SecurityException) {
                    throw UpdateCheckFailed("bad_signature", "${entry.name}: ${e.message}")
                }
                if (entry.name.startsWith("META-INF/")) continue
                val signedBy = entry.certificates.orEmpty().map { certSha256(it) }
                if (signedBy.none { it.equals(fingerprint, ignoreCase = true) }) {
                    throw UpdateCheckFailed("bad_signature", "${entry.name} is not signed by the repository key")
                }
                if (entry.name == "entry.json") entryJson = bytes.toString(Charsets.UTF_8)
            }
        }
        return entryJson ?: throw UpdateCheckFailed("bad_signature", "entry.jar has no entry.json")
    }

    fun certSha256(cert: Certificate): String = sha256Hex(cert.encoded)

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
}

/** A failed update check; `code` is what JavaScript receives as the rejection code. */
class UpdateCheckFailed(val code: String, message: String) : Exception(message)
