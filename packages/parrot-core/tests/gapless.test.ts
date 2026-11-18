import { describe, expect, it } from "bun:test";
import { GaplessEngine, type GaplessBuffer, type GaplessContext, type GaplessElement, type GaplessLimiter } from "../src/gapless";

// A fake audio clock: every source start is recorded, so the test reads exactly where each song was placed.
const SUITE = "[gapless]";
type Started = { url: string; at: number; offset: number; stopped: boolean };

const setup = (durations: Record<string, number>, options: { slowDecode?: Set<string>; limiter?: Promise<GaplessLimiter> } = {}) => {
  const started: Started[] = [];
  const timers: { at: number; callback: () => void }[] = [];
  const pendingDecodes: (() => void)[] = [];
  let wall = 0;
  // Every change of a gain, in order: the gain node's number (0 = the player's level), how, and the value.
  const paramCalls: string[] = [];
  let gains = 0;
  const param = (id: number) => ({
    value: 1,
    setValueAtTime: (value: number, at: number) => paramCalls.push(`${id} set ${value.toFixed(4)} @${at}`),
    linearRampToValueAtTime: (value: number, at: number) => paramCalls.push(`${id} ramp ${value.toFixed(4)} @${at}`),
    setTargetAtTime: (value: number, at: number) => paramCalls.push(`${id} target ${value.toFixed(4)} @${at}`),
    cancelScheduledValues: (at: number) => paramCalls.push(`${id} cancel @${at}`),
  });
  const connections: string[] = [];
  const node = (name = "node") => ({ name, connect: (to: { name?: string }) => connections.push(`${name}->${to.name ?? "?"}`), disconnect: () => connections.push(`${name} disconnect`) });
  const ctx = {
    currentTime: 0,
    state: "running",
    destination: node("destination"),
    createGain: () => {
      const id = gains++;
      return { ...node(id === 0 ? "master" : `gain${id}`), gain: param(id) };
    },
    createBufferSource: () => {
      const source = {
        ...node(),
        buffer: null as (GaplessBuffer & { url: string }) | null,
        onended: null,
        record: null as Started | null,
        start(at: number, offset = 0) {
          source.record = { url: source.buffer!.url, at, offset, stopped: false };
          started.push(source.record);
        },
        stop() {
          if (source.record) source.record.stopped = true;
        },
      };
      return source;
    },
    createMediaElementSource: () => node(),
    decodeAudioData: async (bytes: ArrayBuffer) => {
      const url = new TextDecoder().decode(bytes);
      if (options.slowDecode?.has(url)) await new Promise<void>((resolve) => pendingDecodes.push(resolve));
      return { duration: durations[url]!, url };
    },
    resume: async () => {},
    suspend: async () => {},
  };
  const element: GaplessElement & { played: string[] } = {
    src: "",
    crossOrigin: null,
    currentTime: 0,
    duration: NaN,
    paused: true,
    readyState: 4,
    played: [],
    play: async () => {
      element.paused = false;
      element.played.push(element.src);
    },
    pause: () => {
      element.paused = true;
    },
    removeAttribute: () => {},
    load: () => {},
    addEventListener: () => {},
  };
  const events: string[] = [];
  const engine = new GaplessEngine({
    createContext: () => ctx as unknown as GaplessContext,
    ...(options.limiter ? { createLimiter: () => options.limiter! } : {}),
    createElement: () => element,
    fetchBytes: async (url) => new TextEncoder().encode(url).buffer as ArrayBuffer,
    setTimer: (callback, ms) => timers.push({ at: wall + ms, callback }),
    clearTimer: () => {},
    setRepeating: () => 0,
    clearRepeating: () => {},
    events: {
      onPlaying: (playing) => events.push(`playing ${playing}`),
      onTime: () => {},
      onDuration: () => {},
      onAdvance: (key) => events.push(`advance ${key}`),
      onEnd: () => events.push("end"),
      onError: (error) => events.push(`error ${String(error)}`),
      log: (line) => console.info(SUITE, line),
    },
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const runTimers = (ms: number) => {
    wall += ms;
    for (const timer of timers.splice(0)) if (timer.at <= wall) timer.callback();
  };
  return { engine, ctx, started, events, element, flush, runTimers, pendingDecodes, paramCalls, connections };
};

describe("GaplessEngine (PAR-PLAY-03 item 1)", () => {
  // @req PAR-PLAY-03
  it("starts the next song on the audio clock at the exact sample the current one ends", async () => {
    const t = setup({ a: 200.123, b: 180 });
    t.engine.load({ key: 1, url: "a", durationMs: 200_123, gainDb: 0 });
    await t.flush();
    t.engine.setNext({ key: 2, url: "b", durationMs: 180_000, gainDb: 0 });
    await t.flush();
    const [a, b] = t.started;
    console.info(SUITE, "started", t.started);
    expect(a?.url).toBe("a");
    expect(b?.url).toBe("b");
    expect(b!.at - (a!.at - a!.offset + 200.123)).toBe(0);
    t.ctx.currentTime = b!.at;
    t.engine.tick();
    expect(t.events).toContain("advance 2");
    expect(t.engine.currentKey).toBe(2);
  });

  // @req PAR-PLAY-03
  it("re-joins the next song after a seek and after the next song changes", async () => {
    const t = setup({ a: 100, b: 50, c: 60 });
    t.engine.load({ key: 1, url: "a", durationMs: 100_000, gainDb: 0 });
    await t.flush();
    t.engine.setNext({ key: 2, url: "b", durationMs: 50_000, gainDb: 0 });
    await t.flush();
    t.ctx.currentTime = 10;
    t.engine.seek(90);
    const live = t.started.filter((s) => !s.stopped);
    console.info(SUITE, "after seek", live);
    expect(live.map((s) => s.url)).toEqual(["a", "b"]);
    expect(live[1]!.at).toBeCloseTo(live[0]!.at + 10, 9);
    t.engine.setNext({ key: 3, url: "c", durationMs: 60_000, gainDb: 0 });
    await t.flush();
    const now = t.started.filter((s) => !s.stopped);
    expect(now.map((s) => s.url)).toEqual(["a", "c"]);
    expect(now[1]!.at).toBeCloseTo(now[0]!.at + 10, 9);
  });

  // @req PAR-PLAY-03
  it("starts from the element when decoding is slow, then hands over and still joins the next song", async () => {
    const t = setup({ a: 100, b: 50 }, { slowDecode: new Set(["a"]) });
    t.engine.load({ key: 1, url: "a", durationMs: 100_000, gainDb: 0 });
    await t.flush();
    t.runTimers(1000);
    expect(t.element.played).toEqual(["a"]);
    t.engine.setNext({ key: 2, url: "b", durationMs: 50_000, gainDb: 0 });
    await t.flush();
    expect(t.started).toHaveLength(0);
    t.element.currentTime = 12;
    t.pendingDecodes.splice(0).forEach((resolve) => resolve());
    await t.flush();
    await t.flush();
    console.info(SUITE, "handed over", t.started);
    const [a, b] = t.started;
    expect(a?.url).toBe("a");
    expect(a!.offset).toBeCloseTo(12.05, 9);
    expect(b!.at).toBeCloseTo(a!.at - a!.offset + 100, 9);
  });

  // @req PAR-PLAY-03
  it("repeat one joins the song to itself without decoding it again", async () => {
    const t = setup({ a: 30 });
    t.engine.load({ key: 1, url: "a", durationMs: 30_000, gainDb: 0 });
    await t.flush();
    t.engine.setNext({ key: 1, url: "a", durationMs: 30_000, gainDb: 0 });
    await t.flush();
    expect(t.started.map((s) => s.url)).toEqual(["a", "a"]);
    expect(t.started[1]!.at).toBeCloseTo(t.started[0]!.at + 30, 9);
  });

  // @req PAR-PLAY-03
  it("reports the end when nothing follows", async () => {
    const t = setup({ a: 30 });
    t.engine.load({ key: 1, url: "a", durationMs: 30_000, gainDb: 0 });
    await t.flush();
    t.ctx.currentTime = 31;
    t.engine.tick();
    expect(t.events).toContain("end");
  });

  // @req PAR-PLAY-03
  // @bugfix @regression-proof: a song played by hand loads after the queue already handed the engine the song that
  // follows it (the player asks for its place to stream first); the load dropped that next song, so the first two
  // songs of every album started by hand met with a gap (the next song only started once the first had ended).
  it("keeps the next song set before the current one loads, and joins it with no gap", async () => {
    const t = setup({ a: 4, b: 4 });
    t.engine.setNext({ key: 2, url: "b", durationMs: 4_000, gainDb: 0 });
    await t.flush();
    t.engine.load({ key: 1, url: "a", durationMs: 4_000, gainDb: 0 });
    await t.flush();
    await t.flush();
    console.info(SUITE, "next set first", t.started);
    const [a, b] = t.started;
    expect(a?.url).toBe("a");
    expect(b?.url).toBe("b");
    expect(b!.at).toBeCloseTo(a!.at - a!.offset + 4, 9);
    t.ctx.currentTime = b!.at;
    t.engine.tick();
    expect(t.events).toContain("advance 2");
    expect(t.events).not.toContain("end");
  });

  // @req PAR-PLAY-03
  it("a song loaded while another was joined to the old one keeps that next song, rejoined to the new one", async () => {
    const t = setup({ a: 100, b: 50, c: 60 });
    t.engine.load({ key: 1, url: "a", durationMs: 100_000, gainDb: 0 });
    await t.flush();
    t.engine.setNext({ key: 3, url: "c", durationMs: 60_000, gainDb: 0 });
    await t.flush();
    t.ctx.currentTime = 5;
    t.engine.load({ key: 2, url: "b", durationMs: 50_000, gainDb: 0 });
    await t.flush();
    await t.flush();
    const live = t.started.filter((s) => !s.stopped);
    console.info(SUITE, "reloaded", live);
    expect(live.map((s) => s.url)).toEqual(["b", "c"]);
    expect(live[1]!.at).toBeCloseTo(live[0]!.at - live[0]!.offset + 50, 9);
  });
});

describe("GaplessEngine volume (PAR-PLAY-03 item 2, PAR-PLAY-05)", () => {
  // @req PAR-PLAY-03
  // @req PAR-PLAY-05
  it("plays a song as recorded and changes the volume at once, with no fade", async () => {
    const t = setup({ a: 30 });
    console.info(SUITE, "[instant] phase: load with the setting off (gain 0 dB)");
    t.engine.load({ key: 1, url: "a", durationMs: 30_000, gainDb: 0 });
    await t.flush();
    t.ctx.currentTime = 5;
    t.paramCalls.length = 0;
    console.info(SUITE, "[instant] phase: volume to 0.25 at 5 s");
    t.engine.setVolume(0.25);
    console.info(SUITE, "[instant] calls", t.paramCalls);
    expect(t.paramCalls).toEqual(["0 cancel @5", "0 set 0.2500 @5"]);
    expect(t.engine.outputVolume).toBe(0.25);
    t.paramCalls.length = 0;
    console.info(SUITE, "[instant] phase: the setting turned on, song gain to −6 dB");
    t.engine.setCurrentGain(-6);
    console.info(SUITE, "[instant] calls", t.paramCalls);
    expect(t.paramCalls).toEqual(["1 cancel @5", `1 set ${(10 ** (-6 / 20)).toFixed(4)} @5`]);
  });

  // @req PAR-PLAY-03
  it("routes the output through the limiter once it is ready and passes the Loud switch to it", async () => {
    const switched: boolean[] = [];
    const { promise: limiter, resolve: ready } = Promise.withResolvers<GaplessLimiter>();
    const t = setup({ a: 30 }, { limiter });
    console.info(SUITE, "[limiter] phase: Loud chosen before the limiter is ready");
    t.engine.setLimiting(true);
    t.engine.load({ key: 1, url: "a", durationMs: 30_000, gainDb: 3 });
    await t.flush();
    expect(t.connections).toContain("master->destination");
    ready({ name: "limiter", connect: (to: { name?: string }) => t.connections.push(`limiter->${to.name}`), disconnect() {}, setLimiting: (on: boolean) => switched.push(on) } as GaplessLimiter);
    await t.flush();
    console.info(SUITE, "[limiter] connections", t.connections, "switched", switched);
    expect(t.connections.slice(-3)).toEqual(["limiter->destination", "master disconnect", "master->limiter"]);
    expect(switched).toEqual([true]);
    console.info(SUITE, "[limiter] phase: back to Normal");
    t.engine.setLimiting(false);
    expect(switched).toEqual([true, false]);
  });
});
