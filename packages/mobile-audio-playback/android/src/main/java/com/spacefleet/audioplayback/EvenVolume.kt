package com.spacefleet.audioplayback

import android.content.Context
import android.os.Handler
import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.Timeline
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.exoplayer.audio.AudioRendererEventListener
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.ForwardingAudioSink
import androidx.media3.exoplayer.audio.MediaCodecAudioRenderer
import androidx.media3.exoplayer.mediacodec.MediaCodecAdapter
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.source.MediaSource
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.pow

/**
 * Even out volume (PAR-PLAY-03 item 2): off by default, every song then plays as recorded (gain 0 dB). On, each song
 * plays with its own gain in dB, set by the app per media id. The gain is applied to the decoded samples on their way
 * to the speakers, switching exactly where one song's samples end and the next one's begin, so gapless playback stays
 * gapless and no song starts at the previous one's level. At Loud the [ParrotLimiter] keeps the lifted peaks at −1 dB.
 */
object EvenVolume {
    /** Gain in dB by media id; a song with none plays as recorded. */
    val gainsDb = ConcurrentHashMap<String, Float>()

    /** The limiter runs (Even out volume at Loud). Turning it on or off shifts the sound by its 5 ms look-ahead once. */
    @Volatile
    var limiting = false
}

/** Scales 16-bit or float PCM by `gain` (linear), then limits it while [EvenVolume.limiting] is on. */
class EvenVolumeProcessor : BaseAudioProcessor() {
    @Volatile
    var gain = 1f

    private var limiter: ParrotLimiter? = null
    private var scratch = FloatArray(0)

    override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
        if (inputAudioFormat.encoding != C.ENCODING_PCM_16BIT && inputAudioFormat.encoding != C.ENCODING_PCM_FLOAT) {
            throw AudioProcessor.UnhandledAudioFormatException(inputAudioFormat)
        }
        return inputAudioFormat
    }

    /** The limiter for the current format while limiting is on; null (and forgotten) while it is off. */
    private fun activeLimiter(): ParrotLimiter? {
        if (!EvenVolume.limiting) {
            if (limiter != null) Log.i(TAG, "limiter off")
            limiter = null
            return null
        }
        return limiter ?: ParrotLimiter(inputAudioFormat.sampleRate, inputAudioFormat.channelCount).also {
            Log.i(TAG, "limiter on: ${inputAudioFormat.sampleRate} Hz, ${inputAudioFormat.channelCount} channels, ${it.latency} frames look-ahead")
            limiter = it
        }
    }

    override fun queueInput(inputBuffer: ByteBuffer) {
        val factor = gain
        val float = inputAudioFormat.encoding == C.ENCODING_PCM_FLOAT
        val active = activeLimiter()
        if (active == null) {
            val output = replaceOutputBuffer(inputBuffer.remaining())
            if (float) {
                while (inputBuffer.remaining() >= 4) output.putFloat(inputBuffer.float * factor)
            } else {
                while (inputBuffer.remaining() >= 2) output.putShort(toShort(inputBuffer.short * factor))
            }
            inputBuffer.position(inputBuffer.limit())
            output.flip()
            return
        }
        val count = inputBuffer.remaining() / if (float) 4 else 2
        if (scratch.size < count) scratch = FloatArray(count)
        for (index in 0 until count) scratch[index] = (if (float) inputBuffer.float else inputBuffer.short / 32768f) * factor
        inputBuffer.position(inputBuffer.limit())
        active.process(scratch, count / inputAudioFormat.channelCount)
        write(scratch, count, float)
    }

    /** The end of the last song: the limiter's look-ahead still holds its final 5 ms, which play out now. */
    override fun onQueueEndOfStream() {
        val active = limiter ?: return
        val count = active.latency * inputAudioFormat.channelCount
        if (count == 0) return
        if (scratch.size < count) scratch = FloatArray(count)
        scratch.fill(0f, 0, count)
        active.process(scratch, active.latency)
        write(scratch, count, inputAudioFormat.encoding == C.ENCODING_PCM_FLOAT)
    }

    override fun onFlush() {
        limiter?.reset()
    }

    override fun onReset() {
        limiter = null
    }

    private fun write(samples: FloatArray, count: Int, float: Boolean) {
        val output = replaceOutputBuffer(count * if (float) 4 else 2)
        for (index in 0 until count) {
            if (float) output.putFloat(samples[index]) else output.putShort(toShort(samples[index] * 32768f))
        }
        output.flip()
    }

    private fun toShort(value: Float): Short = value.toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()

    private companion object {
        const val TAG = "EvenVolume"
    }
}

/**
 * Which song each decoded buffer belongs to: every stream an audio renderer is given starts at a known renderer time, so
 * a buffer's time names its song. The audio renderers report their streams here; [EvenVolumeAudioSink] asks per buffer.
 */
class EvenVolumeSongs(private val processor: EvenVolumeProcessor) {
    private class Stream(val startUs: Long, val mediaId: String?)

    private val streams = ArrayDeque<Stream>()
    private val window = Timeline.Window()
    private val period = Timeline.Period()
    private var appliedId: String? = null
    private var appliedDb = Float.NaN

    /** A renderer's `onStreamChanged`: the song of `mediaPeriodId` starts at `startPositionUs` (renderer time). */
    @Synchronized
    fun started(timeline: Timeline, startPositionUs: Long, mediaPeriodId: MediaSource.MediaPeriodId) {
        val mediaId = if (timeline.isEmpty) null else runCatching {
            val windowIndex = timeline.getPeriodByUid(mediaPeriodId.periodUid, period).windowIndex
            timeline.getWindow(windowIndex, window).mediaItem.mediaId
        }.getOrNull()
        // A stream starting before the last one means the times started over (a seek to another song): forget the rest.
        if (streams.isNotEmpty() && startPositionUs < streams.last().startUs) streams.clear()
        streams.addLast(Stream(startPositionUs, mediaId))
        while (streams.size > 4) streams.removeFirst()
    }

    /** Before a buffer enters the sink: the processor takes the gain of the song playing at `presentationTimeUs`. */
    @Synchronized
    fun applyAt(presentationTimeUs: Long) {
        val stream = streams.lastOrNull { it.startUs <= presentationTimeUs } ?: streams.firstOrNull()
        val mediaId = stream?.mediaId
        val db = mediaId?.let { EvenVolume.gainsDb[it] } ?: 0f
        if (mediaId != appliedId || db != appliedDb) {
            Log.i(TAG, "song $mediaId from ${presentationTimeUs}us: gain ${"%.2f".format(db)} dB")
            appliedId = mediaId
            appliedDb = db
        }
        processor.gain = 10f.pow(db / 20f)
    }

    private companion object {
        const val TAG = "EvenVolume"
    }
}

/** The audio sink that sets each buffer's song gain just before the buffer goes through the even-volume processor. */
class EvenVolumeAudioSink(sink: AudioSink, private val songs: EvenVolumeSongs) : ForwardingAudioSink(sink) {
    override fun handleBuffer(buffer: ByteBuffer, presentationTimeUs: Long, encodedAccessUnitCount: Int): Boolean {
        songs.applyAt(presentationTimeUs)
        return super.handleBuffer(buffer, presentationTimeUs, encodedAccessUnitCount)
    }
}

/** The platform-codec audio renderer, reporting its streams to [EvenVolumeSongs]. */
class EvenVolumeAudioRenderer(
    context: Context,
    codecAdapterFactory: MediaCodecAdapter.Factory,
    mediaCodecSelector: MediaCodecSelector,
    enableDecoderFallback: Boolean,
    eventHandler: Handler?,
    eventListener: AudioRendererEventListener?,
    audioSink: AudioSink,
    private val songs: EvenVolumeSongs,
) : MediaCodecAudioRenderer(context, codecAdapterFactory, mediaCodecSelector, enableDecoderFallback, eventHandler, eventListener, audioSink) {
    override fun onStreamChanged(formats: Array<out Format>, startPositionUs: Long, offsetUs: Long, mediaPeriodId: MediaSource.MediaPeriodId) {
        super.onStreamChanged(formats, startPositionUs, offsetUs, mediaPeriodId)
        songs.started(timeline, startPositionUs, mediaPeriodId)
    }
}
