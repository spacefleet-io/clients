/**
 * The limiter of "Even out volume" at Loud (PAR-PLAY-03 item 2), as Spotify's: it engages at −1 dB (sample values),
 * with a 5 ms attack and a 100 ms decay. It looks ahead by the attack time, so every output sample stays at or under
 * −1 dB, and a peak is reached by a smooth 5 ms gain ramp rather than a click.
 *
 * How: each sample needs a gain of at most threshold / |sample| (the loudest channel; channels share one gain). The
 * lowest need over the last `attack` samples, averaged over another `attack` samples, is never above the need of a
 * sample that sits `attack − 1` samples back, so the input is delayed by that much. The gain then falls at once and
 * rises back with the 100 ms decay. Off (`limiting` false) the samples only pass through the delay.
 *
 * Self-contained (no imports) so the Web Audio worklet of the desktop runs it as is; the phone's Kotlin port is
 * `ParrotLimiter.kt` in `@space/mobile-audio-playback`.
 */
export const PARROT_LIMITER = { thresholdDb: -1, attackMs: 5, releaseMs: 100 } as const;

export class ParrotLimiter {
  /** How many samples the output lags the input. */
  readonly latency: number;
  limiting = true;
  private readonly threshold: number;
  private readonly attack: number;
  private readonly release: number;
  private readonly delay: Float32Array[];
  private delayAt = 0;
  // The lowest gain need of the last `attack` samples: a deque of (position, need) with rising needs.
  private readonly minPos: Float64Array;
  private readonly minNeed: Float64Array;
  private minHead = 0;
  private minSize = 0;
  // The running average of those lowest needs over `attack` samples.
  private readonly lows: Float64Array;
  private lowsAt = 0;
  private lowsSum: number;
  private position = 0;
  private gain = 1;

  constructor(sampleRate: number, channels: number) {
    this.threshold = 10 ** (PARROT_LIMITER.thresholdDb / 20);
    this.attack = Math.max(1, Math.round((sampleRate * PARROT_LIMITER.attackMs) / 1000));
    this.release = 1 - Math.exp(-1 / ((sampleRate * PARROT_LIMITER.releaseMs) / 1000));
    this.latency = this.attack - 1;
    this.delay = Array.from({ length: channels }, () => new Float32Array(this.attack));
    this.minPos = new Float64Array(this.attack + 1);
    this.minNeed = new Float64Array(this.attack + 1);
    this.lows = new Float64Array(this.attack).fill(1);
    this.lowsSum = this.attack;
  }

  /** The gain applied to the last sample output (1 = untouched). */
  get currentGain(): number {
    return this.gain;
  }

  /** Back to silence and no gain reduction (a seek or a new stream). */
  reset() {
    for (const line of this.delay) line.fill(0);
    this.delayAt = 0;
    this.minHead = 0;
    this.minSize = 0;
    this.lows.fill(1);
    this.lowsAt = 0;
    this.lowsSum = this.attack;
    this.gain = 1;
  }

  /** Limits `frames` samples of each channel of `input` into `output` (they may be the same arrays). */
  process(input: readonly Float32Array[], output: readonly Float32Array[], frames: number) {
    const capacity = this.minPos.length;
    const channels = this.delay.length;
    for (let frame = 0; frame < frames; frame += 1) {
      let loudest = 0;
      for (let channel = 0; channel < channels; channel += 1) {
        const magnitude = Math.abs(input[channel]?.[frame] ?? 0);
        if (magnitude > loudest) loudest = magnitude;
      }
      const need = this.limiting && loudest > this.threshold ? this.threshold / loudest : 1;
      // Sliding minimum: drop needs at the back that are no lower than this one, and the front once it leaves the window.
      while (this.minSize > 0 && this.minNeed[(this.minHead + this.minSize - 1) % capacity]! >= need) this.minSize -= 1;
      const tail = (this.minHead + this.minSize) % capacity;
      this.minPos[tail] = this.position;
      this.minNeed[tail] = need;
      this.minSize += 1;
      if (this.minPos[this.minHead]! <= this.position - this.attack) {
        this.minHead = (this.minHead + 1) % capacity;
        this.minSize -= 1;
      }
      const low = this.minNeed[this.minHead]!;
      this.lowsSum += low - this.lows[this.lowsAt]!;
      this.lows[this.lowsAt] = low;
      this.lowsAt = (this.lowsAt + 1) % this.attack;
      // Re-add from scratch once a window so rounding never drifts the average upwards.
      if (this.lowsAt === 0) this.lowsSum = this.lows.reduce((sum, value) => sum + value, 0);
      const target = Math.min(1, this.lowsSum / this.attack);
      this.gain = target < this.gain ? target : this.gain + (target - this.gain) * this.release;
      this.position += 1;
      const readAt = (this.delayAt + 1) % this.attack;
      for (let channel = 0; channel < channels; channel += 1) {
        const line = this.delay[channel]!;
        line[this.delayAt] = input[channel]?.[frame] ?? 0;
        const delayed = this.attack === 1 ? line[this.delayAt]! : line[readAt]!;
        const out = output[channel];
        if (out) out[frame] = delayed * this.gain;
      }
      this.delayAt = readAt;
    }
  }
}
