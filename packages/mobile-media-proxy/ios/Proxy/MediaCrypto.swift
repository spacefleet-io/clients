import CommonCrypto
import CryptoKit
import Foundation

enum MediaCryptoError: Error, LocalizedError {
  case libraryKeySize(Int)
  case ciphertextTooShort(required: Int, got: Int)
  case payloadInvalid
  case payloadTruncated
  case tagMismatch
  case cipher(String)
  case stream(String)

  var errorDescription: String? {
    switch self {
    case .libraryKeySize(let n): return "library_key_size_invalid: \(n)"
    case .ciphertextTooShort(let required, let got): return "ciphertext too short (\(required) required, got \(got))"
    case .payloadInvalid: return "media_payload_invalid"
    case .payloadTruncated: return "media_payload_truncated"
    case .tagMismatch: return "media_tag_mismatch"
    case .cipher(let what): return "media_cipher_failed: \(what)"
    case .stream(let what): return "media_stream_failed: \(what)"
    }
  }
}

/// AES-256-GCM + HKDF-SHA256 for the SFV1 media envelope (mirror of the Android `MediaCrypto.kt`).
///
///     [4B "SFV1"][16B salt][12B nonce][ciphertext][16B GCM tag]       AAD = "SFV1"
///
/// The decrypted plaintext carries a length header `[u32LE origLen][u16LE padLen][origLen data][padLen pad]`.
enum MediaCrypto {
  private static let magic = Data([0x53, 0x46, 0x56, 0x31])
  private static let saltBytes = 16
  private static let nonceBytes = 12
  private static let tagBytes = 16
  private static let headerBytes = 6
  private static let hkdfInfo = Data("sf-media-v1".utf8)
  private static let masterSalt = Data("sf-media-master-salt".utf8)
  private static let masterInfo = Data("sf-media-master".utf8)

  static func deriveMasterKey(libraryKey: Data) throws -> SymmetricKey {
    guard libraryKey.count == 32 else { throw MediaCryptoError.libraryKeySize(libraryKey.count) }
    return HKDF<SHA256>.deriveKey(
      inputKeyMaterial: SymmetricKey(data: libraryKey), salt: masterSalt, info: masterInfo, outputByteCount: 32)
  }

  /// Unwraps one SFV1 envelope. Non-SFV1 buffers pass through unchanged (plaintext WebVTT / PGS sidecars).
  static func decryptSegment(masterKey: SymmetricKey, encrypted: Data) throws -> Data {
    let base = encrypted.startIndex
    guard encrypted.count >= magic.count, encrypted[base..<base + magic.count] == magic else { return encrypted }
    let minSize = magic.count + saltBytes + nonceBytes + tagBytes
    guard encrypted.count >= minSize else {
      throw MediaCryptoError.ciphertextTooShort(required: minSize, got: encrypted.count)
    }
    let saltStart = base + magic.count
    let nonceStart = saltStart + saltBytes
    let cipherStart = nonceStart + nonceBytes
    let tagStart = encrypted.endIndex - tagBytes

    let salt = encrypted[saltStart..<nonceStart]
    let objectKey = HKDF<SHA256>.deriveKey(
      inputKeyMaterial: masterKey, salt: salt, info: hkdfInfo, outputByteCount: 32)
    let box = try AES.GCM.SealedBox(
      nonce: AES.GCM.Nonce(data: encrypted[nonceStart..<cipherStart]),
      ciphertext: encrypted[cipherStart..<tagStart],
      tag: encrypted[tagStart..<encrypted.endIndex])
    let padded = try AES.GCM.open(box, using: objectKey, authenticating: magic)

    guard padded.count >= headerBytes else { throw MediaCryptoError.payloadInvalid }
    let p = padded.startIndex
    let origLen = Int(padded[p]) | Int(padded[p + 1]) << 8 | Int(padded[p + 2]) << 16 | Int(padded[p + 3]) << 24
    let padLen = Int(padded[p + 4]) | Int(padded[p + 5]) << 8
    guard headerBytes + origLen + padLen <= padded.count else { throw MediaCryptoError.payloadTruncated }
    let dataEnd = min(padded.count, headerBytes + origLen)
    // A slice shares `padded`'s storage: no second copy of the segment. Its indices start past the
    // header, so readers index from `startIndex` (PlaybackHttpServer does).
    return padded[(p + headerBytes)..<(p + dataEnd)]
  }

  /// Bytes per piece of `decryptStream`: what one streamed object costs in memory, whatever its size.
  static let streamPieceBytes = 64 * 1024

  /// `decryptSegment` for objects too large to hold whole (a PGS sidecar runs to tens of MB): reads one SFV1 envelope
  /// from `input` and writes the padded plaintext (header included) to `output` piece by piece; non-SFV1 input is
  /// copied through. Returns where the media bytes sit in what was written.
  ///
  /// CryptoKit's AES.GCM is one-shot, so this is GCM by hand: AES-CTR from CommonCrypto (counter J0+1 = nonce ||
  /// 00000002) plus a GHASH tag check (mirror of the Kotlin `MediaCrypto.decryptStream`). `output` holds
  /// unauthenticated bytes until this returns; on `tagMismatch` the caller must discard them.
  static func decryptStream(masterKey: SymmetricKey, input: InputStream, output: OutputStream) throws -> (
    offset: Int, length: Int
  ) {
    var head = [UInt8](repeating: 0, count: magic.count + saltBytes + nonceBytes)
    let headLen = try readUpTo(input, &head)
    let isSfv1 = headLen >= magic.count && Array(head[0..<magic.count]) == Array(magic)
    if !isSfv1 {
      try writeAll(output, head, count: headLen)
      var total = headLen
      var buf = [UInt8](repeating: 0, count: streamPieceBytes)
      while true {
        let n = input.read(&buf, maxLength: buf.count)
        if n < 0 { throw MediaCryptoError.stream(input.streamError?.localizedDescription ?? "read") }
        if n == 0 { break }
        try writeAll(output, buf, count: n)
        total += n
      }
      return (0, total)
    }
    guard headLen == head.count else {
      throw MediaCryptoError.ciphertextTooShort(required: head.count + tagBytes, got: headLen)
    }

    let salt = Data(head[magic.count..<(magic.count + saltBytes)])
    let nonce = Array(head[(magic.count + saltBytes)..<head.count])
    let objectKey = HKDF<SHA256>.deriveKey(inputKeyMaterial: masterKey, salt: salt, info: hkdfInfo, outputByteCount: 32)
    let keyBytes = objectKey.withUnsafeBytes { Array($0) }

    var ghash = Ghash(h: try aesBlock(keyBytes, [UInt8](repeating: 0, count: 16)))
    let tagMask = try aesBlock(keyBytes, nonce + [0, 0, 0, 1])
    let ctr = try CtrCipher(key: keyBytes, iv: nonce + [0, 0, 0, 2])

    ghash.update(Array(magic), 0, magic.count)
    ghash.padBlock()

    // The last tagBytes of the stream are the tag, not ciphertext: always hold them back until more input arrives.
    var buf = [UInt8](repeating: 0, count: streamPieceBytes + tagBytes)
    var plain = [UInt8](repeating: 0, count: streamPieceBytes + 2 * tagBytes)
    var header = [UInt8](repeating: 0, count: headerBytes)
    var held = 0
    var cipherLen = 0
    while true {
      let n = buf.withUnsafeMutableBufferPointer { input.read($0.baseAddress! + held, maxLength: $0.count - held) }
      if n < 0 { throw MediaCryptoError.stream(input.streamError?.localizedDescription ?? "read") }
      if n == 0 { break }
      held += n
      if held <= tagBytes { continue }
      let chunk = held - tagBytes
      ghash.update(buf, 0, chunk)
      let produced = try ctr.update(buf, chunk, into: &plain)
      if cipherLen < headerBytes {
        let count = min(headerBytes - cipherLen, produced)
        for i in 0..<count { header[cipherLen + i] = plain[i] }
      }
      try writeAll(output, plain, count: produced)
      cipherLen += chunk
      for i in 0..<tagBytes { buf[i] = buf[chunk + i] }
      held = tagBytes
    }
    guard held == tagBytes else {
      throw MediaCryptoError.ciphertextTooShort(required: head.count + tagBytes, got: head.count + held)
    }
    let tail = try ctr.finish(into: &plain)
    try writeAll(output, plain, count: tail)

    var computed = ghash.finish(aadBytes: UInt64(magic.count), cipherBytes: UInt64(cipherLen))
    var diff: UInt8 = 0
    for i in 0..<tagBytes {
      computed[i] ^= tagMask[i]
      diff |= computed[i] ^ buf[i]
    }
    guard diff == 0 else { throw MediaCryptoError.tagMismatch }

    guard cipherLen >= headerBytes else { throw MediaCryptoError.payloadInvalid }
    let origLen = Int(header[0]) | Int(header[1]) << 8 | Int(header[2]) << 16 | Int(header[3]) << 24
    let padLen = Int(header[4]) | Int(header[5]) << 8
    guard headerBytes + origLen + padLen <= cipherLen else { throw MediaCryptoError.payloadTruncated }
    return (headerBytes, min(origLen, cipherLen - headerBytes))
  }

  private static func readUpTo(_ input: InputStream, _ into: inout [UInt8]) throws -> Int {
    var total = 0
    while total < into.count {
      let n = into.withUnsafeMutableBufferPointer { input.read($0.baseAddress! + total, maxLength: $0.count - total) }
      if n < 0 { throw MediaCryptoError.stream(input.streamError?.localizedDescription ?? "read") }
      if n == 0 { break }
      total += n
    }
    return total
  }

  private static func writeAll(_ output: OutputStream, _ bytes: [UInt8], count: Int) throws {
    var done = 0
    while done < count {
      let n = bytes.withUnsafeBufferPointer { output.write($0.baseAddress! + done, maxLength: count - done) }
      if n <= 0 { throw MediaCryptoError.stream(output.streamError?.localizedDescription ?? "write") }
      done += n
    }
  }

  /// AES-256 of one 16-byte block (E(K, 0) = GHASH key H, E(K, J0) = tag mask).
  private static func aesBlock(_ key: [UInt8], _ block: [UInt8]) throws -> [UInt8] {
    var out = [UInt8](repeating: 0, count: 16)
    var moved = 0
    let status = CCCrypt(
      CCOperation(kCCEncrypt), CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionECBMode),
      key, key.count, nil, block, block.count, &out, out.count, &moved)
    guard status == kCCSuccess, moved == 16 else { throw MediaCryptoError.cipher("ecb \(status)") }
    return out
  }

  /// Streaming AES-CTR (big-endian counter) over CommonCrypto.
  private final class CtrCipher {
    private var ref: CCCryptorRef?

    init(key: [UInt8], iv: [UInt8]) throws {
      let status = CCCryptorCreateWithMode(
        CCOperation(kCCDecrypt), CCMode(kCCModeCTR), CCAlgorithm(kCCAlgorithmAES), CCPadding(ccNoPadding),
        iv, key, key.count, nil, 0, 0, CCModeOptions(kCCModeOptionCTR_BE), &ref)
      guard status == kCCSuccess else { throw MediaCryptoError.cipher("ctr init \(status)") }
    }

    deinit { CCCryptorRelease(ref) }

    func update(_ input: [UInt8], _ count: Int, into out: inout [UInt8]) throws -> Int {
      var moved = 0
      let capacity = out.count
      let status = CCCryptorUpdate(ref, input, count, &out, capacity, &moved)
      guard status == kCCSuccess else { throw MediaCryptoError.cipher("ctr update \(status)") }
      return moved
    }

    func finish(into out: inout [UInt8]) throws -> Int {
      var moved = 0
      let capacity = out.count
      let status = CCCryptorFinal(ref, &out, capacity, &moved)
      guard status == kCCSuccess else { throw MediaCryptoError.cipher("ctr final \(status)") }
      return moved
    }
  }

  /// GHASH (NIST SP 800-38D) with Shoup's 4-bit tables, same construction as mbedTLS `gcm_mult` and the Kotlin twin.
  private struct Ghash {
    private static let last4: [UInt64] = [
      0x0000, 0x1c20, 0x3840, 0x2460, 0x7080, 0x6ca0, 0x48c0, 0x54e0,
      0xe100, 0xfd20, 0xd940, 0xc560, 0x9180, 0x8da0, 0xa9c0, 0xb5e0,
    ]
    private var hh = [UInt64](repeating: 0, count: 16)
    private var hl = [UInt64](repeating: 0, count: 16)
    private var yh: UInt64 = 0
    private var yl: UInt64 = 0
    private var block = [UInt8](repeating: 0, count: 16)
    private var fill = 0

    init(h: [UInt8]) {
      var vh = Self.be64(h, 0)
      var vl = Self.be64(h, 8)
      hh[8] = vh
      hl[8] = vl
      var i = 4
      while i > 0 {
        let t: UInt64 = (vl & 1) != 0 ? 0xe100_0000_0000_0000 : 0
        vl = (vh << 63) | (vl >> 1)
        vh = (vh >> 1) ^ t
        hh[i] = vh
        hl[i] = vl
        i >>= 1
      }
      i = 2
      while i <= 8 {
        vh = hh[i]
        vl = hl[i]
        for j in 1..<i {
          hh[i + j] = vh ^ hh[j]
          hl[i + j] = vl ^ hl[j]
        }
        i *= 2
      }
    }

    mutating func update(_ bytes: [UInt8], _ offset: Int, _ length: Int) {
      var pos = offset
      let end = offset + length
      if fill > 0 {
        while fill < 16 && pos < end {
          block[fill] = bytes[pos]
          fill += 1
          pos += 1
        }
        if fill < 16 { return }
        absorb(Self.be64(block, 0), Self.be64(block, 8))
        fill = 0
      }
      while end - pos >= 16 {
        absorb(Self.be64(bytes, pos), Self.be64(bytes, pos + 8))
        pos += 16
      }
      while pos < end {
        block[fill] = bytes[pos]
        fill += 1
        pos += 1
      }
    }

    /// Zero-pads a trailing partial block (AAD and ciphertext are each padded to 16 bytes).
    mutating func padBlock() {
      guard fill > 0 else { return }
      for i in fill..<16 { block[i] = 0 }
      absorb(Self.be64(block, 0), Self.be64(block, 8))
      fill = 0
    }

    mutating func finish(aadBytes: UInt64, cipherBytes: UInt64) -> [UInt8] {
      padBlock()
      absorb(aadBytes &* 8, cipherBytes &* 8)
      var out = [UInt8](repeating: 0, count: 16)
      for i in 0..<8 {
        out[i] = UInt8(truncatingIfNeeded: yh >> UInt64(56 - 8 * i))
        out[8 + i] = UInt8(truncatingIfNeeded: yl >> UInt64(56 - 8 * i))
      }
      return out
    }

    /// Y = (Y xor X) * H.
    private mutating func absorb(_ xh: UInt64, _ xl: UInt64) {
      let ah = yh ^ xh
      let al = yl ^ xl
      var lo = Int(al & 0xf)
      var zh = hh[lo]
      var zl = hl[lo]
      for i in stride(from: 15, through: 0, by: -1) {
        let b = Int(truncatingIfNeeded: (i < 8 ? ah >> UInt64(56 - 8 * i) : al >> UInt64(56 - 8 * (i - 8))) & 0xff)
        lo = b & 0xf
        let hi = b >> 4
        if i != 15 {
          let rem = Int(zl & 0xf)
          zl = (zh << 60) | (zl >> 4)
          zh = (zh >> 4) ^ (Self.last4[rem] << 48) ^ hh[lo]
          zl ^= hl[lo]
        }
        let rem = Int(zl & 0xf)
        zl = (zh << 60) | (zl >> 4)
        zh = (zh >> 4) ^ (Self.last4[rem] << 48) ^ hh[hi]
        zl ^= hl[hi]
      }
      yh = zh
      yl = zl
    }

    private static func be64(_ b: [UInt8], _ off: Int) -> UInt64 {
      var v: UInt64 = 0
      for i in 0..<8 { v = (v << 8) | UInt64(b[off + i]) }
      return v
    }
  }
}
