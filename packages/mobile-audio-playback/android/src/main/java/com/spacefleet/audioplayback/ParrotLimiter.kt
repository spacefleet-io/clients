package com.spacefleet.audioplayback

import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

/**
 * The limiter of "Even out volume" at Loud (PAR-PLAY-03 item 2), as Spotify's: it engages at −1 dB (sample values),
 * with a 5 ms attack and a 100 ms decay. The phone's port of `@space/parrot-core/limiter` (`ParrotLimiter`), the same
 * steps: it looks ahead by the attack time, so every output sample stays at or under −1 dB.
 *
 * Each frame needs a gain of at most threshold / |sample| (the loudest channel; channels share one gain). The lowest
 * need over the last `attack` frames, averaged over another `attack` frames, is never above the need of the frame that
 * sits `attack − 1` frames back, so the input is delayed by that much. The gain falls at once and rises back with the
 * 100 ms decay.
 */
class ParrotLimiter(sampleRate: Int, private val channels: Int) {
    private val threshold = 10.0.pow(THRESHOLD_DB / 20.0)
    private val attack = max(1, (sampleRate * ATTACK_MS / 1000.0).roundToInt())
    private val release = 1 - exp(-1.0 / (sampleRate * RELEASE_MS / 1000.0))

    /** How many frames the output lags the input. */
    val latency = attack - 1

    private val delay = FloatArray(attack * channels)
    private var delayAt = 0
    private val minPos = LongArray(attack + 1)
    private val minNeed = DoubleArray(attack + 1)
    private var minHead = 0
    private var minSize = 0
    private val lows = DoubleArray(attack) { 1.0 }
    private var lowsAt = 0
    private var lowsSum = attack.toDouble()
    private var position = 0L

    /** The gain applied to the last frame output (1 = untouched). */
    var currentGain = 1.0
        private set

    fun reset() {
        delay.fill(0f)
        delayAt = 0
        minHead = 0
        minSize = 0
        lows.fill(1.0)
        lowsAt = 0
        lowsSum = attack.toDouble()
        currentGain = 1.0
    }

    /** Limits `frames` interleaved frames of `samples` in place. */
    fun process(samples: FloatArray, frames: Int) {
        val capacity = minPos.size
        for (frame in 0 until frames) {
            val base = frame * channels
            var loudest = 0.0
            for (channel in 0 until channels) loudest = max(loudest, abs(samples[base + channel].toDouble()))
            val need = if (loudest > threshold) threshold / loudest else 1.0
            while (minSize > 0 && minNeed[(minHead + minSize - 1) % capacity] >= need) minSize -= 1
            val tail = (minHead + minSize) % capacity
            minPos[tail] = position
            minNeed[tail] = need
            minSize += 1
            if (minPos[minHead] <= position - attack) {
                minHead = (minHead + 1) % capacity
                minSize -= 1
            }
            val low = minNeed[minHead]
            lowsSum += low - lows[lowsAt]
            lows[lowsAt] = low
            lowsAt = (lowsAt + 1) % attack
            // Re-add from scratch once a window so rounding never drifts the average upwards.
            if (lowsAt == 0) lowsSum = lows.sum()
            val target = min(1.0, lowsSum / attack)
            currentGain = if (target < currentGain) target else currentGain + (target - currentGain) * release
            position += 1
            val readAt = (delayAt + 1) % attack
            for (channel in 0 until channels) {
                delay[delayAt * channels + channel] = samples[base + channel]
                val delayed = if (attack == 1) delay[delayAt * channels + channel] else delay[readAt * channels + channel]
                samples[base + channel] = (delayed * currentGain).toFloat()
            }
            delayAt = readAt
        }
    }

    companion object {
        const val THRESHOLD_DB = -1.0
        const val ATTACK_MS = 5.0
        const val RELEASE_MS = 100.0
    }
}
