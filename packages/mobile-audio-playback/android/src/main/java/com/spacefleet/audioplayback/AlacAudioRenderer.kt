package com.spacefleet.audioplayback

import android.content.Context
import android.os.Handler
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.Util
import androidx.media3.decoder.CryptoConfig
import androidx.media3.decoder.DecoderException
import androidx.media3.decoder.DecoderInputBuffer
import androidx.media3.decoder.SimpleDecoder
import androidx.media3.decoder.SimpleDecoderOutputBuffer
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.Renderer
import androidx.media3.exoplayer.RendererCapabilities
import androidx.media3.exoplayer.audio.AudioRendererEventListener
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.audio.MediaCodecAudioRenderer
import androidx.media3.exoplayer.audio.DecoderAudioRenderer
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.source.MediaSource

/**
 * Apple Lossless on the phone (PAR-FMT-01): Media3's MP4 extractor reads `.m4a` ALAC files (and turns their edit list
 * into the encoder delay and padding the audio sink trims, so ALAC albums stay gapless, PAR-PLAY-03), but Android has no
 * ALAC decoder. This renderer decodes them with Parrot's own [AlacFrameDecoder] to PCM.
 */
@OptIn(UnstableApi::class)
class AlacAudioRenderer(handler: Handler?, listener: AudioRendererEventListener?, sink: AudioSink, private val songs: EvenVolumeSongs) :
    DecoderAudioRenderer<AlacMedia3Decoder>(handler, listener, sink) {

    override fun getName(): String = "ParrotAlacRenderer"

    override fun onStreamChanged(formats: Array<out Format>, startPositionUs: Long, offsetUs: Long, mediaPeriodId: MediaSource.MediaPeriodId) {
        super.onStreamChanged(formats, startPositionUs, offsetUs, mediaPeriodId)
        songs.started(timeline, startPositionUs, mediaPeriodId)
    }

    override fun supportsFormatInternal(format: Format): Int {
        if (format.sampleMimeType != MimeTypes.AUDIO_ALAC) return C.FORMAT_UNSUPPORTED_TYPE
        val config = runCatching { AlacConfig.parse(format.initializationData.firstOrNull() ?: ByteArray(0)) }.getOrNull()
            ?: return C.FORMAT_UNSUPPORTED_SUBTYPE
        if (!sinkSupportsFormat(Util.getPcmFormat(pcmEncodingOf(config), config.channels, config.sampleRate))) {
            return C.FORMAT_UNSUPPORTED_SUBTYPE
        }
        return if (format.cryptoType != C.CRYPTO_TYPE_NONE) C.FORMAT_UNSUPPORTED_DRM else C.FORMAT_HANDLED
    }

    override fun createDecoder(format: Format, cryptoConfig: CryptoConfig?): AlacMedia3Decoder =
        AlacMedia3Decoder(AlacConfig.parse(format.initializationData[0]), format.maxInputSize)

    override fun getOutputFormat(decoder: AlacMedia3Decoder): Format {
        val config = decoder.config
        return Util.getPcmFormat(pcmEncodingOf(config), config.channels, config.sampleRate)
    }

    companion object {
        fun pcmEncodingOf(config: AlacConfig): Int = when (config.bytesPerSample) {
            2 -> C.ENCODING_PCM_16BIT
            3 -> C.ENCODING_PCM_24BIT
            else -> C.ENCODING_PCM_32BIT
        }
    }
}

/** Media3's decoder thread around [AlacFrameDecoder]: one MP4 sample in, its PCM out. */
@OptIn(UnstableApi::class)
class AlacMedia3Decoder(val config: AlacConfig, maxInputSize: Int) :
    SimpleDecoder<DecoderInputBuffer, SimpleDecoderOutputBuffer, DecoderException>(
        // SimpleDecoder fills these with createInputBuffer() and createOutputBuffer() before using them.
        @Suppress("UNCHECKED_CAST") (arrayOfNulls<DecoderInputBuffer>(BUFFERS) as Array<DecoderInputBuffer>),
        @Suppress("UNCHECKED_CAST") (arrayOfNulls<SimpleDecoderOutputBuffer>(BUFFERS) as Array<SimpleDecoderOutputBuffer>),
    ) {
    private val frames = AlacFrameDecoder(config)
    private var input = ByteArray(0)

    init {
        // Room for the largest frame ALAC allows uncompressed, when the container doesn't say.
        setInitialInputBufferSize(if (maxInputSize != Format.NO_VALUE) maxInputSize else frames.maxOutputBytes + 64)
    }

    override fun getName(): String = "parrot-alac"

    override fun createInputBuffer(): DecoderInputBuffer = DecoderInputBuffer(DecoderInputBuffer.BUFFER_REPLACEMENT_MODE_DIRECT)

    override fun createOutputBuffer(): SimpleDecoderOutputBuffer = SimpleDecoderOutputBuffer { releaseOutputBuffer(it) }

    override fun createUnexpectedDecodeException(error: Throwable): DecoderException = DecoderException("Unexpected ALAC decode error", error)

    override fun decode(inputBuffer: DecoderInputBuffer, outputBuffer: SimpleDecoderOutputBuffer, reset: Boolean): DecoderException? {
        val data = inputBuffer.data ?: return DecoderException("ALAC: empty input buffer")
        val size = data.remaining()
        if (input.size < size) input = ByteArray(size)
        data.get(input, 0, size)
        val out = outputBuffer.init(inputBuffer.timeUs, frames.maxOutputBytes)
        return try {
            frames.decodeFrame(input, size, out)
            out.flip()
            null
        } catch (error: AlacDecodeException) {
            DecoderException(error.message ?: "ALAC: bad frame", error)
        }
    }

    private companion object {
        const val BUFFERS = 16
    }
}

/**
 * The app's renderers: the ALAC renderer ahead of the platform's audio decoders, and even volume (PAR-PLAY-03 item 2):
 * each song at its own gain, switched sample-exactly between gapless songs by [EvenVolumeSongs].
 */
@OptIn(UnstableApi::class)
class ParrotRenderersFactory(private val context: Context) : DefaultRenderersFactory(context) {
    private val processor = EvenVolumeProcessor()
    private val songs = EvenVolumeSongs(processor)

    override fun buildAudioSink(context: Context, enableFloatOutput: Boolean, enableAudioOutputPlaybackParams: Boolean): AudioSink =
        EvenVolumeAudioSink(
            DefaultAudioSink.Builder(context)
                .setEnableFloatOutput(enableFloatOutput)
                .setAudioProcessors(arrayOf<AudioProcessor>(processor))
                .build(),
            songs,
        )

    override fun buildAudioRenderers(
        context: Context,
        extensionRendererMode: Int,
        mediaCodecSelector: MediaCodecSelector,
        enableDecoderFallback: Boolean,
        audioSink: AudioSink,
        eventHandler: Handler,
        eventListener: AudioRendererEventListener,
        out: ArrayList<Renderer>,
    ) {
        out.add(AlacAudioRenderer(eventHandler, eventListener, audioSink, songs))
        val added = out.size
        super.buildAudioRenderers(context, extensionRendererMode, mediaCodecSelector, enableDecoderFallback, audioSink, eventHandler, eventListener, out)
        // The platform-codec renderer becomes one that reports its songs; any extension decoder stays as it is.
        val index = (added until out.size).firstOrNull { out[it] is MediaCodecAudioRenderer } ?: return
        out[index] = EvenVolumeAudioRenderer(this.context, codecAdapterFactory, mediaCodecSelector, enableDecoderFallback, eventHandler, eventListener, audioSink, songs)
    }
}
