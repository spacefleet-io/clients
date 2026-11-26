package com.spacefleet.audioplayback

import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.SinglePeriodTimeline
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.pow

/**
 * @req PAR-PLAY-03
 *
 * Even out volume on the phone: each song plays at its own gain, switching exactly where the next song's samples
 * begin, loud lifts clip instead of wrapping round into a crack, and at Loud the limiter's held-back last 5 ms still
 * play at the end of the queue.
 */
class EvenVolumeTest {
    @After
    fun clear() {
        EvenVolume.gainsDb.clear()
        EvenVolume.limiting = false
    }

    private fun processor(encoding: Int, channels: Int = 1) = EvenVolumeProcessor().apply {
        configure(AudioProcessor.AudioFormat(SAMPLE_RATE, channels, encoding))
        flush()
    }

    private fun shorts(vararg values: Int): ByteBuffer =
        ByteBuffer.allocateDirect(values.size * 2).order(ByteOrder.nativeOrder()).apply {
            values.forEach { putShort(it.toShort()) }
            flip()
        }

    private fun floats(values: FloatArray): ByteBuffer =
        ByteBuffer.allocateDirect(values.size * 4).order(ByteOrder.nativeOrder()).apply {
            values.forEach { putFloat(it) }
            flip()
        }

    private fun EvenVolumeProcessor.run(input: ByteBuffer): ByteBuffer {
        queueInput(input)
        return output
    }

    private fun ByteBuffer.toShorts(): List<Int> = buildList { while (remaining() >= 2) add(short.toInt()) }

    private fun ByteBuffer.toFloats(): FloatArray = FloatArray(remaining() / 4) { float }

    @Test
    fun scalesSixteenBitSamplesAndClipsLoudLiftsInsteadOfWrapping() {
        val processor = processor(C.ENCODING_PCM_16BIT)
        processor.gain = 10f.pow(-6f / 20f)
        val quieter = processor.run(shorts(10000, -10000, 0)).toShorts()
        println("[PAR-PLAY-03] -6 dB on [10000, -10000, 0] -> $quieter")
        assertEquals(listOf(5011, -5011, 0), quieter)

        processor.gain = 4f
        val lifted = processor.run(shorts(20000, -20000, 100)).toShorts()
        println("[PAR-PLAY-03] x4 on [20000, -20000, 100] -> $lifted")
        // Wrapping round would turn a loud peak into its opposite: a crack in the music.
        assertEquals(listOf(32767, -32768, 400), lifted)
    }

    @Test
    fun scalesFloatSamples() {
        val processor = processor(C.ENCODING_PCM_FLOAT)
        processor.gain = 0.5f
        val out = processor.run(floats(floatArrayOf(0.8f, -0.4f, 1.0f))).toFloats().toList()
        println("[PAR-PLAY-03] float x0.5 -> $out")
        assertEquals(listOf(0.4f, -0.2f, 0.5f), out)
    }

    @Test
    fun refusesFormatsItCannotScale() {
        try {
            EvenVolumeProcessor().configure(AudioProcessor.AudioFormat(SAMPLE_RATE, 2, C.ENCODING_PCM_24BIT))
            fail("24-bit PCM was accepted and would be scaled as 16-bit")
        } catch (e: AudioProcessor.UnhandledAudioFormatException) {
            println("[PAR-PLAY-03] 24-bit refused: ${e.message}")
        }
    }

    @Test
    fun atLoudTheLimiterHoldsPeaksAndTheQueueEndPlaysTheHeldBackTail() {
        EvenVolume.limiting = true
        val processor = processor(C.ENCODING_PCM_FLOAT, channels = 2)
        processor.gain = 10f.pow(9f / 20f)
        val frames = SAMPLE_RATE / 10
        val input = FloatArray(frames * 2) { if (it % 4 < 2) 0.6f else -0.6f }
        val body = processor.run(floats(input)).toFloats()
        processor.queueEndOfStream()
        val tail = processor.output.toFloats()
        val all = body + tail
        val latency = ParrotLimiter(SAMPLE_RATE, 2).latency
        val peak = all.maxOf { abs(it) }
        println("[PAR-PLAY-03] limiter: in=${input.size} body=${body.size} tail=${tail.size} latency=$latency peak=$peak")
        assertEquals(latency * 2, tail.size)
        assertEquals(input.size + latency * 2, all.size)
        assertTrue("peak $peak above -1 dB", peak <= 10.0.pow(-1.0 / 20.0) + 1e-6)
        // The last input sample (a lifted -0.6) comes out of the tail, limited but not lost.
        assertTrue("last sample ${all[input.size + latency * 2 - 1]}", all[input.size + latency * 2 - 1] < -0.5f)
    }

    @Test
    fun turningTheLimiterOffPlaysWithoutTheLookAheadDelay() {
        EvenVolume.limiting = true
        val processor = processor(C.ENCODING_PCM_FLOAT)
        processor.run(floats(FloatArray(64) { 0.1f }))
        EvenVolume.limiting = false
        val out = processor.run(floats(floatArrayOf(0.25f, 0.5f))).toFloats().toList()
        processor.queueEndOfStream()
        val tail = processor.output.remaining()
        println("[PAR-PLAY-03] after limiter off: $out tail bytes=$tail")
        assertEquals(listOf(0.25f, 0.5f), out)
        assertEquals(0, tail)
    }

    private fun song(id: String?): Pair<SinglePeriodTimeline, MediaSource.MediaPeriodId> {
        val item = MediaItem.Builder().apply { if (id != null) setMediaId(id) }.build()
        val timeline = SinglePeriodTimeline(1_000_000L, true, false, false, null, item)
        return timeline to MediaSource.MediaPeriodId(timeline.getUidOfPeriod(0))
    }

    private fun EvenVolumeSongs.start(id: String, atUs: Long) = song(id).let { (timeline, period) -> started(timeline, atUs, period) }

    private fun EvenVolumeSongs.gainAt(processor: EvenVolumeProcessor, timeUs: Long): Float {
        applyAt(timeUs)
        return processor.gain
    }

    @Test
    fun eachSongPlaysAtItsOwnGainSwitchingWhereTheNextSongStarts() {
        EvenVolume.gainsDb["quiet"] = 6f
        EvenVolume.gainsDb["loud"] = -6f
        val processor = EvenVolumeProcessor()
        val songs = EvenVolumeSongs(processor)
        songs.start("quiet", 0L)
        songs.start("loud", 180_000_000L)
        songs.start("as-recorded", 400_000_000L)
        val gains = listOf(0L, 179_999_999L, 180_000_000L, 399_999_999L, 400_000_000L).map { it to songs.gainAt(processor, it) }
        println("[PAR-PLAY-03] gains by time: $gains")
        assertEquals(10f.pow(6f / 20f), gains[0].second, 1e-5f)
        assertEquals(10f.pow(6f / 20f), gains[1].second, 1e-5f)
        assertEquals(10f.pow(-6f / 20f), gains[2].second, 1e-5f)
        assertEquals(10f.pow(-6f / 20f), gains[3].second, 1e-5f)
        // A song with no gain plays as recorded.
        assertEquals(1f, gains[4].second, 0f)
    }

    @Test
    fun aSeekToAnotherSongForgetsTheSongsQueuedBefore() {
        EvenVolume.gainsDb["a"] = -3f
        EvenVolume.gainsDb["b"] = -9f
        EvenVolume.gainsDb["c"] = 4f
        val processor = EvenVolumeProcessor()
        val songs = EvenVolumeSongs(processor)
        songs.start("a", 10_000_000L)
        songs.start("b", 190_000_000L)
        // The user picks song c: the renderer's times start over below the last stream's start.
        songs.start("c", 50_000_000L)
        // The first buffer of c can be stamped just before its stream start; it must not take song a's gain.
        val early = songs.gainAt(processor, 45_000_000L)
        val gain = songs.gainAt(processor, 200_000_000L)
        println("[PAR-PLAY-03] after seek to c, gain at 45 s: $early, at 200 s: $gain")
        assertEquals(10f.pow(4f / 20f), early, 1e-5f)
        assertEquals(10f.pow(4f / 20f), gain, 1e-5f)
    }

    @Test
    fun aBufferBeforeTheFirstKnownSongTakesThatSongsGain() {
        EvenVolume.gainsDb["first"] = -4f
        val processor = EvenVolumeProcessor()
        val songs = EvenVolumeSongs(processor)
        songs.start("first", 1_000_000L)
        val gain = songs.gainAt(processor, 999_000L)
        println("[PAR-PLAY-03] buffer before the first stream: $gain")
        assertEquals(10f.pow(-4f / 20f), gain, 1e-5f)
    }

    @Test
    fun aGainChangedWhileTheSongPlaysAppliesToItsNextBuffers() {
        val processor = EvenVolumeProcessor()
        val songs = EvenVolumeSongs(processor)
        songs.start("now", 0L)
        val before = songs.gainAt(processor, 5_000_000L)
        EvenVolume.gainsDb["now"] = -10f
        val after = songs.gainAt(processor, 5_100_000L)
        println("[PAR-PLAY-03] gain before=$before after setGains=$after")
        assertEquals(1f, before, 0f)
        assertEquals(10f.pow(-10f / 20f), after, 1e-5f)
    }

    private companion object {
        const val SAMPLE_RATE = 44_100
    }
}
