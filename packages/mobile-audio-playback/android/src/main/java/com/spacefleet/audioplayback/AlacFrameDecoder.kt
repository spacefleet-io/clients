/*
 * Apple Lossless (ALAC) decoding for Parrot on the phone (PAR-FMT-01): Android has no ALAC decoder, so Parrot decodes it
 * itself, losslessly. Same algorithm as the desktop's packages/parrot-core/src/alac.ts.
 *
 * The decoding algorithm (adaptive Golomb entropy decoding, the adaptive FIR predictor, stereo un-mixing) is a port of
 * Apple's ALAC reference decoder (codec/ag_dec.c, dp_dec.c, matrix_dec.c, ALACDecoder.cpp of
 * https://github.com/macosforge/alac):
 *
 *   Copyright (c) 2011 Apple Inc. All rights reserved.
 *
 *   Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance
 *   with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 *   Unless required by applicable law or agreed to in writing, software distributed under the License is distributed
 *   on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for
 *   the specific language governing permissions and limitations under the License.
 *
 * Changes from the original: ported from C/C++ to Kotlin; the little-endian PCM output is Parrot's own. The full licence
 * text ships as packages/parrot-core/licenses/apple-alac-LICENSE.txt.
 */
package com.spacefleet.audioplayback

import java.nio.ByteBuffer

/** The ALACSpecificConfig ("magic cookie") of an ALAC stream: its fixed parameters. */
class AlacConfig(
    val frameLength: Int,
    val bitDepth: Int,
    val pb: Int,
    val mb: Int,
    val kb: Int,
    val channels: Int,
    val sampleRate: Int,
) {
    /** Bytes of one output sample: 16-bit stays 16-bit, 20- and 24-bit come out as 24-bit, 32-bit as 32-bit. */
    val bytesPerSample: Int get() = when (bitDepth) { 16 -> 2; 32 -> 4; else -> 3 }

    companion object {
        /**
         * Reads the 24-byte ALACSpecificConfig. Accepts the bare config, or bytes holding an `alac` box around it (the
         * MP4 extractor hands over the box body, with or without its 4-byte version and flags): the config is the last
         * 24 bytes.
         */
        fun parse(bytes: ByteArray): AlacConfig {
            if (bytes.size < 24) throw IllegalArgumentException("alac: no ALACSpecificConfig")
            val at = bytes.size - 24
            fun u8(i: Int) = bytes[at + i].toInt() and 0xff
            fun u32(i: Int) = (u8(i) shl 24) or (u8(i + 1) shl 16) or (u8(i + 2) shl 8) or u8(i + 3)
            val config = AlacConfig(
                frameLength = u32(0),
                bitDepth = u8(5),
                pb = u8(6),
                mb = u8(7),
                kb = u8(8),
                channels = u8(9),
                sampleRate = u32(20),
            )
            if (u8(4) != 0) throw IllegalArgumentException("alac: unknown compatible version ${u8(4)}")
            if (config.bitDepth !in intArrayOf(16, 20, 24, 32)) throw IllegalArgumentException("alac: unsupported bit depth ${config.bitDepth}")
            if (config.channels !in 1..8) throw IllegalArgumentException("alac: unsupported channel count ${config.channels}")
            if (config.frameLength !in 1..65536) throw IllegalArgumentException("alac: bad frame length ${config.frameLength}")
            return config
        }
    }
}

class AlacDecodeException(message: String) : Exception(message)

/** MSB-first bit reader over one ALAC frame. Reads past the end yield zero bits (counted, and refused at the end). */
private class BitReader(private val buf: ByteArray, private val size: Int) {
    private var pos = 0L

    fun bits(n: Int): Long {
        var value = 0L
        var left = n
        while (left > 0) {
            val index = (pos ushr 3).toInt()
            val byte = if (index < size) buf[index].toInt() and 0xff else 0
            val avail = 8 - (pos and 7).toInt()
            val take = if (avail < left) avail else left
            value = (value shl take) or ((byte ushr (avail - take)) and ((1 shl take) - 1)).toLong()
            pos += take
            left -= take
        }
        return value
    }

    fun signed(n: Int): Int {
        val value = bits(n)
        return (if (value >= (1L shl (n - 1))) value - (1L shl n) else value).toInt()
    }

    fun peek(n: Int): Long {
        val at = pos
        val value = bits(n)
        pos = at
        return value
    }

    fun skip(n: Long) {
        pos += n
    }

    fun align() {
        pos = (pos + 7) and 7L.inv()
    }

    val left: Long get() = size * 8L - pos
}

private fun log2(v: Long): Int = if (v > 0) 63 - java.lang.Long.numberOfLeadingZeros(v) else 0
private fun signExtend(v: Int, bits: Int): Int = if (bits >= 32) v else (v shl (32 - bits)) shr (32 - bits)
private fun signOf(v: Int): Int = if (v > 0) 1 else if (v < 0) -1 else 0

private const val ID_SCE = 0L
private const val ID_CPE = 1L
private const val ID_LFE = 3L
private const val ID_DSE = 4L
private const val ID_FIL = 6L
private const val ID_END = 7L

/** Where each decoded channel goes, in WAV/Android order (front L R, centre, LFE, back…), by channel count. */
private val CHANNEL_OFFSETS = arrayOf(
    intArrayOf(0),
    intArrayOf(0, 1),
    intArrayOf(2, 0, 1),
    intArrayOf(2, 0, 1, 3),
    intArrayOf(2, 0, 1, 3, 4),
    intArrayOf(2, 0, 1, 4, 5, 3),
    intArrayOf(2, 0, 1, 4, 5, 6, 3),
    intArrayOf(2, 6, 7, 0, 1, 4, 5, 3),
)

/** Decodes ALAC frames (one MP4 sample each) to interleaved little-endian PCM. */
class AlacFrameDecoder(val config: AlacConfig) {
    private val error = Array(2) { IntArray(config.frameLength) }
    private val extra = Array(2) { IntArray(config.frameLength) }
    private val coefs = Array(2) { ShortArray(32) }
    private val element = Array(2) { IntArray(config.frameLength) }
    private val channelSamples = Array(config.channels) { IntArray(config.frameLength) }

    /** Largest output of one frame, in bytes. */
    val maxOutputBytes: Int get() = config.frameLength * config.channels * config.bytesPerSample

    /**
     * Decodes one frame of `size` bytes and writes its samples, interleaved, to `out` (little-endian; 20-bit audio is
     * written as 24-bit, shifted up 4 bits). Returns the number of sample frames decoded.
     */
    fun decodeFrame(frame: ByteArray, size: Int, out: ByteBuffer): Int {
        val channels = config.channels
        val reader = BitReader(frame, size)
        var frameSamples = -1
        var ch = 0
        while (reader.left >= 3) {
            val id = reader.bits(3)
            if (id == ID_END) break
            if (id == ID_DSE) {
                reader.skip(4) // element instance tag
                val aligned = reader.bits(1)
                var count = reader.bits(8)
                if (count == 255L) count += reader.bits(8)
                if (aligned != 0L) reader.align()
                reader.skip(count * 8)
                continue
            }
            if (id == ID_FIL) {
                var count = reader.bits(4)
                if (count == 15L) count += reader.bits(8) - 1
                reader.skip(count * 8)
                continue
            }
            if (id != ID_SCE && id != ID_CPE && id != ID_LFE) throw AlacDecodeException("alac: unsupported element $id")
            val count = if (id == ID_CPE) 2 else 1
            if (ch >= channels) throw AlacDecodeException("alac: more channels than the config says")
            val offset = CHANNEL_OFFSETS[channels - 1][ch]
            if (ch + count > channels || offset + count > channels) throw AlacDecodeException("alac: more channels than the config says")
            val samples = decodeElement(reader, count, frameSamples)
            frameSamples = samples
            for (c in 0 until count) System.arraycopy(element[c], 0, channelSamples[offset + c], 0, samples)
            ch += count
        }
        if (reader.left < 0) throw AlacDecodeException("alac: frame ends early")
        if (frameSamples < 0) return 0
        if (ch != channels) throw AlacDecodeException("alac: frame has $ch of $channels channels")
        writePcm(frameSamples, out)
        return frameSamples
    }

    private fun writePcm(samples: Int, out: ByteBuffer) {
        val channels = config.channels
        when (config.bitDepth) {
            16 -> for (i in 0 until samples) for (c in 0 until channels) {
                val v = channelSamples[c][i]
                out.put(v.toByte()).put((v shr 8).toByte())
            }
            32 -> for (i in 0 until samples) for (c in 0 until channels) {
                val v = channelSamples[c][i]
                out.put(v.toByte()).put((v shr 8).toByte()).put((v shr 16).toByte()).put((v shr 24).toByte())
            }
            else -> {
                val shift = 24 - config.bitDepth
                for (i in 0 until samples) for (c in 0 until channels) {
                    val v = channelSamples[c][i] shl shift
                    out.put(v.toByte()).put((v shr 8).toByte()).put((v shr 16).toByte())
                }
            }
        }
    }

    /** Decodes one SCE/CPE/LFE element into `element[0..channels)`; returns its sample count. */
    private fun decodeElement(reader: BitReader, channels: Int, expectedSamples: Int): Int {
        reader.skip(4) // element instance tag
        reader.skip(12) // unused header bits
        val hasSize = reader.bits(1)
        val extraBits = (reader.bits(2) shl 3).toInt()
        val bps = config.bitDepth - extraBits + channels - 1
        if (bps > 32 || bps < 1) throw AlacDecodeException("alac: bad sample size $bps")
        val compressed = reader.bits(1) == 0L
        val samplesLong = if (hasSize != 0L) reader.bits(32) else config.frameLength.toLong()
        if (samplesLong < 1 || samplesLong > config.frameLength) throw AlacDecodeException("alac: bad frame size $samplesLong")
        val samples = samplesLong.toInt()
        if (expectedSamples >= 0 && samples != expectedSamples) throw AlacDecodeException("alac: elements of one frame differ in size")

        if (!compressed) {
            for (i in 0 until samples) for (c in 0 until channels) element[c][i] = reader.signed(config.bitDepth)
            return samples
        }

        val mixShift = reader.bits(8).toInt()
        val mixWeight = reader.bits(8).toInt()
        val mode = IntArray(channels)
        val denShift = IntArray(channels)
        val pbFactor = IntArray(channels)
        val order = IntArray(channels)
        for (c in 0 until channels) {
            mode[c] = reader.bits(4).toInt()
            denShift[c] = reader.bits(4).toInt()
            pbFactor[c] = reader.bits(3).toInt()
            order[c] = reader.bits(5).toInt()
            if (order[c] >= samples || denShift[c] == 0) throw AlacDecodeException("alac: bad predictor")
            val coefs = coefs[c]
            for (i in order[c] - 1 downTo 0) coefs[i] = reader.signed(16).toShort()
        }
        if (extraBits != 0) {
            for (i in 0 until samples) for (c in 0 until channels) extra[c][i] = reader.bits(extraBits).toInt()
        }
        for (c in 0 until channels) {
            val error = error[c]
            entropyDecode(reader, error, samples, bps, (pbFactor[c] * config.pb) / 4)
            if (mode[c] == 15) predict(error, error, samples, bps, coefs[c], 31, 0)
            else if (mode[c] != 0) throw AlacDecodeException("alac: unknown prediction mode ${mode[c]}")
            predict(error, element[c], samples, bps, coefs[c], order[c], denShift[c])
        }

        if (channels == 2 && mixWeight != 0) {
            val left = element[0]
            val right = element[1]
            for (i in 0 until samples) {
                var a = left[i]
                var b = right[i]
                a -= (b * mixWeight) shr mixShift
                b += a
                left[i] = b
                right[i] = a
            }
        }
        if (extraBits != 0) {
            for (c in 0 until channels) {
                val values = element[c]
                val extra = extra[c]
                for (i in 0 until samples) values[i] = (values[i] shl extraBits) or extra[i]
            }
        }
        return samples
    }

    /** Adaptive Golomb decoding of one channel's prediction errors (ag_dec.c dyn_decomp). */
    private fun entropyDecode(reader: BitReader, out: IntArray, samples: Int, bps: Int, multiplier: Int) {
        val kb = config.kb
        var history = config.mb.toLong()
        var signModifier = 0L
        var i = 0
        while (i < samples) {
            var k = log2((history ushr 9) + 3)
            if (k > kb) k = kb
            var x = scalar(reader, k, bps)
            x = (x + signModifier) and 0xffffffffL
            signModifier = 0
            out[i] = ((x ushr 1) xor -(x and 1)).toInt()
            history = if (x > 0xffff) 0xffff
            else (history + x * multiplier - (history * multiplier) / 512) and 0xffffffffL
            if (history < 128 && i + 1 < samples) {
                k = 7 - log2(history) + ((history + 16) shr 6).toInt()
                if (k > kb) k = kb
                val run = scalar(reader, k, 16)
                if (run > 0) {
                    if (run >= samples - i) throw AlacDecodeException("alac: zero run past the frame end")
                    out.fill(0, i + 1, i + 1 + run.toInt())
                    i += run.toInt()
                }
                if (run <= 0xffff) signModifier = 1
                history = 0
            }
            i += 1
        }
    }

    /** One Golomb-coded value: a unary prefix of up to 9 ones, then k bits, or an escaped raw value of `bps` bits. */
    private fun scalar(reader: BitReader, k: Int, bps: Int): Long {
        var x = 0L
        while (x < 9 && reader.bits(1) == 1L) x += 1
        if (x > 8) return reader.bits(bps)
        if (k != 1) {
            val extra = reader.peek(k)
            x *= (1L shl k) - 1
            if (extra > 1) {
                x += extra - 1
                reader.skip(k.toLong())
            } else reader.skip((k - 1).toLong())
        }
        return x
    }

    /** The adaptive FIR predictor (dp_dec.c unpc_block): rebuilds samples from prediction errors, adapting `coefs`. */
    private fun predict(error: IntArray, out: IntArray, samples: Int, bps: Int, coefs: ShortArray, order: Int, shift: Int) {
        out[0] = error[0]
        if (samples <= 1) return
        if (order == 0) {
            System.arraycopy(error, 1, out, 1, samples - 1)
            return
        }
        if (order == 31) {
            for (i in 1 until samples) out[i] = signExtend(out[i - 1] + error[i], bps)
            return
        }
        var i = 1
        while (i <= order && i < samples) {
            out[i] = signExtend(out[i - 1] + error[i], bps)
            i += 1
        }
        val round = 1L shl (shift - 1)
        while (i < samples) {
            val base = i - order
            val d = out[base - 1]
            var errorValue = error[i]
            var sum = 0
            for (j in 0 until order) sum += (out[base + j] - d) * coefs[j]
            var value = ((sum + round) shr shift).toInt()
            value += d + errorValue
            out[i] = signExtend(value, bps)
            val errorSign = signOf(errorValue)
            if (errorSign != 0) {
                var j = 0
                while (j < order && errorValue * errorSign > 0) {
                    var delta = d - out[base + j]
                    val sign = signOf(delta) * errorSign
                    coefs[j] = (coefs[j] - sign).toShort()
                    delta *= sign
                    errorValue -= (delta shr shift) * (j + 1)
                    j += 1
                }
            }
            i += 1
        }
    }
}
