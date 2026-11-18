/**
 * The limiter of "Even out volume" at Loud (PAR-PLAY-03 item 2) as a Web Audio worklet: the shared `ParrotLimiter`
 * on the player's output. It passes the audio through (5 ms late) until the player posts `{ limiting: true }`.
 */
import { ParrotLimiter } from "@space/parrot-core/limiter";

// The worklet scope's globals (not in the DOM library).
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

// The name `Player.tsx` builds its node with.
const PARROT_LIMITER_PROCESSOR = "parrot-limiter";

registerProcessor(
  PARROT_LIMITER_PROCESSOR,
  class extends AudioWorkletProcessor {
    private limiter = new ParrotLimiter(sampleRate, 2);

    constructor() {
      super();
      this.limiter.limiting = false;
      this.port.onmessage = (event: MessageEvent<{ limiting: boolean }>) => {
        this.limiter.limiting = event.data.limiting;
      };
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]) {
      const input = inputs[0] ?? [];
      const output = outputs[0] ?? [];
      // Mono input plays on both channels.
      const left = input[0];
      if (!left) {
        for (const channel of output) channel.fill(0);
        return true;
      }
      this.limiter.process([left, input[1] ?? left], output, left.length);
      return true;
    }
  }
);
