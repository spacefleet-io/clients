package com.spacefleet.audioplayback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.pow
import kotlin.math.sin

/**
 * @req PAR-PLAY-03
 *
 * Even out volume at Loud lifts quiet songs past their peaks; the phone's limiter keeps every sample at or under −1 dB
 * (Spotify's limiter: −1 dB, 5 ms attack, 100 ms decay) and leaves audio under that untouched, only 5 ms late.
 */
class ParrotLimiterTest {
    private val rate = 48_000
    private val ceiling = 10.0.pow(-1.0 / 20.0)

    private fun stereoSine(amplitude: Double, seconds: Double): FloatArray {
        val frames = (rate * seconds).toInt()
        return FloatArray(frames * 2) { index ->
            val frame = index / 2
            val hz = if (index % 2 == 0) 220.0 else 331.0
            (amplitude * sin(2 * PI * hz * frame / rate)).toFloat()
        }
    }

    @Test
    fun keepsEverySampleAtOrUnderMinusOneDb() {
        val lift = 10.0.pow(9.0 / 20.0)
        val samples = stereoSine(0.5 * lift, 2.0)
        for (hit in 0 until 8) samples[((hit + 0.5) * rate * 0.25).toInt() * 2] = (0.99 * lift * if (hit % 2 == 0) 1 else -1).toFloat()
        val inputPeak = samples.maxOf { abs(it) }
        val limiter = ParrotLimiter(rate, 2)
        // In 512-frame blocks, as the audio sink hands them over.
        for (start in 0 until samples.size / 2 step 512) {
            val frames = minOf(512, samples.size / 2 - start)
            val block = samples.copyOfRange(start * 2, (start + frames) * 2)
            limiter.process(block, frames)
            block.copyInto(samples, start * 2)
        }
        val outputPeak = samples.maxOf { abs(it) }
        println("[PARROT-LIMITER-KT] input peak $inputPeak, output peak $outputPeak, ceiling $ceiling, latency ${limiter.latency}")
        assertTrue(inputPeak > 1.5f)
        assertTrue("output peak $outputPeak over $ceiling", outputPeak <= ceiling + 1e-6)
        assertEquals(239, limiter.latency)
    }

    @Test
    fun passesQuietAudioThroughOnlyDelayed() {
        val input = stereoSine(0.8, 0.5)
        val output = input.copyOf()
        val limiter = ParrotLimiter(rate, 2)
        limiter.process(output, output.size / 2)
        var worst = 0f
        for (index in limiter.latency * 2 until output.size) worst = maxOf(worst, abs(output[index] - input[index - limiter.latency * 2]))
        println("[PARROT-LIMITER-KT] largest difference from the delayed input $worst")
        assertTrue(worst < 1e-6f)
        assertEquals(1.0, limiter.currentGain, 0.0)
    }
}
