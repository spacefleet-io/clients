package com.spacefleet.mediaproxy

import java.security.MessageDigest

/** Integrity of one object fetched from the tunnel (DECOM-02): a truncated or corrupted part is fetched again. */
object DownloadIntegrity {
  fun sha256Hex(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

  /**
   * Null when [bytes] is what the gateway declared; else the error text the engine logs and retries on. [declaredLength] < 0
   * and an empty [sha256Header] mean the gateway declared nothing. Same checks as iOS `DownloadEngine.handleObjectResult`.
   */
  fun verify(key: String, bytes: ByteArray, declaredLength: Long, sha256Header: String?): String? {
    if (declaredLength >= 0 && bytes.size.toLong() != declaredLength) {
      return "tunnel_download_truncated: ${bytes.size}/$declaredLength key=$key"
    }
    val wanted = sha256Header?.trim()?.lowercase().orEmpty()
    if (wanted.isNotEmpty() && sha256Hex(bytes) != wanted) return "tunnel_download_checksum_mismatch key=$key"
    return null
  }
}
