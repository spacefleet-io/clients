package com.spacefleet.audioplayback

import androidx.media3.common.C
import androidx.media3.common.DataReader
import androidx.media3.common.Format
import androidx.media3.common.util.ParsableByteArray
import androidx.media3.decoder.DecoderInputBuffer
import androidx.media3.extractor.DefaultExtractorInput
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.ExtractorOutput
import androidx.media3.extractor.PositionHolder
import androidx.media3.extractor.SeekMap
import androidx.media3.extractor.TrackOutput
import androidx.media3.extractor.mp4.Mp4Extractor
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * PAR-FMT-01 on the phone: Media3's MP4 extractor hands Parrot's ALAC decoder the same frames the desktop decodes, and
 * the decoder rebuilds them bit for bit like ffmpeg (the hashes in parrot-core's fixtures). The edit list becomes the
 * encoder delay and padding the audio sink trims, so ALAC stays gapless (PAR-PLAY-03).
 */
class AlacDecoderTest {
    companion object {
        init {
            // Media3's ParsableByteArray reads android.os.Build.FINGERPRINT, which the JVM's SDK stubs leave null. Give it a
            // value, so the real MP4 extractor runs here without an Android runtime.
            val field = android.os.Build::class.java.getField("FINGERPRINT")
            if (field.get(null) == null) {
                val unsafeClass = Class.forName("sun.misc.Unsafe")
                val unsafe = unsafeClass.getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
                val base = unsafeClass.getMethod("staticFieldBase", java.lang.reflect.Field::class.java).invoke(unsafe, field)
                val offset = unsafeClass.getMethod("staticFieldOffset", java.lang.reflect.Field::class.java).invoke(unsafe, field)
                unsafeClass.getMethod("putObject", Any::class.java, Long::class.javaPrimitiveType, Any::class.java)
                    .invoke(unsafe, base, offset, "jvm-unit-test")
            }
        }
    }

    private val fixtures: File = generateSequence(File(System.getProperty("user.dir")!!).absoluteFile) { it.parentFile }
        .map { File(it, "packages/parrot-core/tests/fixtures/alac") }
        .first { it.isDirectory }

    private val references: Map<String, String> = File(fixtures, "reference.sha256").readLines()
        .filter { it.isNotBlank() }
        .associate { line -> line.split(" ").let { it[0] to it[1] } }

    private class Track(val format: Format, val samples: List<ByteArray>)

    /** Runs Media3's MP4 extractor over the file, as the player does, and keeps the audio track's format and samples. */
    private fun extract(bytes: ByteArray): Track {
        var format: Format? = null
        val data = ByteArrayOutputStream()
        val samples = mutableListOf<ByteArray>()
        val track = object : TrackOutput {
            override fun format(value: Format) {
                format = value
            }

            override fun sampleData(input: DataReader, length: Int, allowEndOfInput: Boolean, sampleDataPart: Int): Int {
                val buffer = ByteArray(length)
                val read = input.read(buffer, 0, length)
                if (read == C.RESULT_END_OF_INPUT) {
                    if (allowEndOfInput) return C.RESULT_END_OF_INPUT
                    throw java.io.EOFException()
                }
                data.write(buffer, 0, read)
                return read
            }

            override fun sampleData(input: ParsableByteArray, length: Int, sampleDataPart: Int) {
                val buffer = ByteArray(length)
                input.readBytes(buffer, 0, length)
                data.write(buffer)
            }

            override fun sampleMetadata(timeUs: Long, flags: Int, size: Int, offset: Int, cryptoData: TrackOutput.CryptoData?) {
                val all = data.toByteArray()
                val end = all.size - offset
                samples += all.copyOfRange(end - size, end)
            }
        }
        val extractor: Extractor = Mp4Extractor()
        extractor.init(object : ExtractorOutput {
            override fun track(id: Int, type: Int): TrackOutput = track
            override fun endTracks() {}
            override fun seekMap(seekMap: SeekMap) {}
        })
        val reader = object : DataReader {
            var position = 0
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                if (position >= bytes.size) return C.RESULT_END_OF_INPUT
                val n = minOf(length, bytes.size - position)
                System.arraycopy(bytes, position, buffer, offset, n)
                position += n
                return n
            }
        }
        var input = DefaultExtractorInput(reader, 0, bytes.size.toLong())
        val seek = PositionHolder()
        while (true) {
            val result = extractor.read(input, seek)
            if (result == Extractor.RESULT_END_OF_INPUT) break
            if (result == Extractor.RESULT_SEEK) {
                reader.position = seek.position.toInt()
                input = DefaultExtractorInput(reader, seek.position, bytes.size.toLong())
            }
        }
        return Track(format!!, samples)
    }

    /** Decodes every frame, then trims the encoder delay and padding as Media3's audio sink does. */
    private fun decode(track: Track): ByteArray {
        val config = AlacConfig.parse(track.format.initializationData[0])
        val decoder = AlacFrameDecoder(config)
        val out = ByteArrayOutputStream()
        val buffer = ByteBuffer.allocate(decoder.maxOutputBytes)
        for (sample in track.samples) {
            buffer.clear()
            decoder.decodeFrame(sample, sample.size, buffer)
            out.write(buffer.array(), 0, buffer.position())
        }
        return trim(out.toByteArray(), track.format, config)
    }

    private fun trim(pcm: ByteArray, format: Format, config: AlacConfig): ByteArray {
        val frameBytes = config.channels * config.bytesPerSample
        val delay = format.encoderDelay.coerceAtLeast(0) * frameBytes
        val padding = format.encoderPadding.coerceAtLeast(0) * frameBytes
        return pcm.copyOfRange(delay, pcm.size - padding)
    }

    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun fixture(name: String) = File(fixtures, "$name.m4a").readBytes()

    @Test
    fun decodesEveryFixtureBitForBitLikeFfmpeg() {
        assertEquals(7, references.size)
        for ((name, hash) in references) {
            val track = extract(fixture(name))
            assertEquals(name, "audio/alac", track.format.sampleMimeType)
            val bits = name.substring(1, 3).toInt()
            val config = AlacConfig.parse(track.format.initializationData[0])
            assertEquals(name, bits, config.bitDepth)
            assertEquals(name, AlacAudioRenderer.pcmEncodingOf(config), if (bits == 16) C.ENCODING_PCM_16BIT else C.ENCODING_PCM_24BIT)
            assertEquals(name, hash, sha256(decode(track)))
        }
    }

    @Test
    fun media3DecoderThreadGivesTheSamePcm() {
        val track = extract(fixture("s24-44100-stereo"))
        val config = AlacConfig.parse(track.format.initializationData[0])
        val decoder = AlacMedia3Decoder(config, track.format.maxInputSize)
        val out = ByteArrayOutputStream()
        var queued = 0
        var done = false
        val deadline = System.currentTimeMillis() + 30_000
        while (!done) {
            check(System.currentTimeMillis() < deadline) { "decoder stalled" }
            if (queued <= track.samples.size) {
                decoder.dequeueInputBuffer()?.let { input ->
                    if (queued == track.samples.size) input.setFlags(C.BUFFER_FLAG_END_OF_STREAM)
                    else {
                        val sample = track.samples[queued]
                        input.ensureSpaceForWrite(sample.size)
                        input.data!!.put(sample)
                        input.timeUs = queued.toLong()
                    }
                    input.flip()
                    decoder.queueInputBuffer(input)
                    queued += 1
                }
            }
            val output = decoder.dequeueOutputBuffer()
            if (output == null) {
                Thread.sleep(1)
                continue
            }
            if (output.isEndOfStream) done = true
            else {
                val data = output.data!!
                val bytes = ByteArray(data.remaining())
                data.get(bytes)
                out.write(bytes)
            }
            output.release()
        }
        decoder.release()
        assertEquals(references.getValue("s24-44100-stereo"), sha256(trim(out.toByteArray(), track.format, config)))
    }

    @Test
    fun songsEndOnTheirLastSampleSoAlbumsStayGapless() {
        // ALAC needs no encoder priming: the last frame is simply shorter, so a song decodes to exactly the samples its
        // sample table lists, and the next song follows with no silence between them (PAR-PLAY-03).
        val track = extract(fixture("s16-44100-stereo"))
        assertEquals(0, track.format.encoderDelay.coerceAtLeast(0))
        assertEquals(0, track.format.encoderPadding.coerceAtLeast(0))
        assertEquals(3 * 4096 + 1824, decode(track).size / 4)
    }
}
