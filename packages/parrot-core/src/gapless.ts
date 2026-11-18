// The gapless player of PAR-PLAY-03 item 1 for the players that run in a browser engine (the Parrot desktop window).
// Each song is fetched whole and decoded to samples, and the next song is decoded ahead and started on the audio
// clock at the exact sample the current one ends, so nothing (not even one buffer of silence) comes between them.
// While a song is still being decoded the player plays it through an <audio> element, so pressing play never waits
// for a whole download; once the samples are ready it hands over to them with a short crossfade of the same audio.
// The Web Audio types are structural so this file needs no DOM library and can be tested with a fake clock.

/** One song for the engine: `key` names the queue entry (the same song queued twice has two keys). */
export type GaplessTrack = {
  key: number;
  url: string;
  durationMs: number | null;
  /** The even-volume gain of PAR-PLAY-03 item 2 for this song in this queue, in dB (0 = as recorded, the setting off). */
  gainDb: number;
};

export type GaplessEvents = {
  onPlaying: (playing: boolean) => void;
  /** About four times a second while playing, and after every seek or song change. */
  onTime: (seconds: number) => void;
  onDuration: (seconds: number) => void;
  /** The song set with `setNext` started, joined to the end of the previous one with no gap. */
  onAdvance: (key: number) => void;
  /** The current song ended and no next song was set (or ready): the caller decides what comes next. */
  onEnd: () => void;
  onError: (error: unknown) => void;
  /** A song's whole audio was decoded (current or next): the caller may measure it, e.g. for even volume. */
  onDecoded?: (key: number, buffer: GaplessBuffer) => void;
  log?: (line: string) => void;
};

// --- The parts of Web Audio the engine uses. ---
export type GaplessParam = {
  value: number;
  setValueAtTime(value: number, at: number): unknown;
  linearRampToValueAtTime(value: number, at: number): unknown;
  cancelScheduledValues(at: number): unknown;
};
export type GaplessNode = { connect(destination: GaplessNode): unknown; disconnect(): void };
/** The limiter of "Even out volume" at Loud (`ParrotLimiter`, in a worklet on the desktop): it passes audio through untouched until told to limit. */
export type GaplessLimiter = GaplessNode & { setLimiting(on: boolean): void };
export type GaplessGainNode = GaplessNode & { gain: GaplessParam };
export type GaplessBuffer = { duration: number };
export type GaplessSourceNode = GaplessNode & {
  buffer: GaplessBuffer | null;
  start(when: number, offset?: number): void;
  stop(when?: number): void;
  onended: (() => void) | null;
};
export type GaplessElement = {
  src: string;
  crossOrigin: string | null;
  currentTime: number;
  duration: number;
  paused: boolean;
  readyState: number;
  play(): Promise<void>;
  pause(): void;
  removeAttribute(name: string): void;
  load(): void;
  addEventListener(type: string, listener: () => void): void;
};
export type GaplessContext = {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: GaplessNode;
  createGain(): GaplessGainNode;
  createBufferSource(): GaplessSourceNode;
  createMediaElementSource(element: GaplessElement): GaplessNode;
  decodeAudioData(data: ArrayBuffer): Promise<GaplessBuffer>;
  resume(): Promise<void>;
  suspend(): Promise<void>;
};

export type GaplessEngineOptions = {
  createContext: () => GaplessContext;
  createElement: () => GaplessElement;
  fetchBytes: (url: string) => Promise<ArrayBuffer>;
  events: GaplessEvents;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  setRepeating?: (callback: () => void, ms: number) => unknown;
  clearRepeating?: (handle: unknown) => void;
  /** Builds the limiter for this audio context; the engine routes its output through it once it is ready. */
  createLimiter?: (ctx: GaplessContext) => Promise<GaplessLimiter>;
};

/** Longer songs are not decoded whole (about 210 MB of samples at 20 minutes): they play from the element. */
export const GAPLESS_MAX_DECODED_MS = 20 * 60 * 1000;
/** How long a press of play waits for the samples before it starts from the element instead. */
export const GAPLESS_START_WAIT_MS = 1000;
/** The crossfade of the hand-over from the element to the samples (the same audio, so nothing is heard). */
const HANDOVER_FADE_S = 0.03;
/** A song is started this far ahead on the audio clock, so its first samples are never late. */
const LEAD_S = 0.02;

export const dbToGain = (db: number): number => 10 ** (db / 20);

type Slot = {
  track: GaplessTrack;
  /** The song's even-volume gain; every way it plays goes through it. */
  gain: GaplessGainNode;
  buffer: GaplessBuffer | null;
  decoding: Promise<GaplessBuffer | null> | null;
  /** Buffer mode: the playing (or scheduled) source and the audio-clock time of the song's 0:00. */
  source: GaplessSourceNode | null;
  startedAt: number;
  /** Buffer mode while paused before the first start: where to start. */
  pendingOffset: number;
  /** Element mode: the engine's one element plays this slot, through this fade. */
  element: GaplessElement | null;
  elementFade: GaplessGainNode | null;
  bufferFade: GaplessGainNode | null;
  mode: "idle" | "buffer" | "element";
  ended: boolean;
  disposed: boolean;
};

export class GaplessEngine {
  private ctx: GaplessContext | null = null;
  private master: GaplessGainNode | null = null;
  private current: Slot | null = null;
  private next: Slot | null = null;
  private paused = true;
  private volume = 1;
  private limiting = false;
  private limiter: GaplessLimiter | null = null;
  private ticker: unknown = null;
  private element: GaplessElement | null = null;
  private elementNode: GaplessNode | null = null;
  private elementSlot: Slot | null = null;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly setRepeating: (callback: () => void, ms: number) => unknown;
  private readonly clearRepeating: (handle: unknown) => void;

  constructor(private readonly options: GaplessEngineOptions) {
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.setRepeating = options.setRepeating ?? ((callback, ms) => setInterval(callback, ms));
    this.clearRepeating = options.clearRepeating ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  }

  /** The queue entry playing now, or null. */
  get currentKey(): number | null {
    return this.current?.track.key ?? null;
  }

  /** The level last set with `setVolume`. */
  get outputVolume(): number {
    return this.volume;
  }

  get playing(): boolean {
    return Boolean(this.current) && !this.paused;
  }

  private log(line: string) {
    this.options.events.log?.(`[gapless] ${line}`);
  }

  private context(): { ctx: GaplessContext; master: GaplessGainNode } {
    if (!this.ctx || !this.master) {
      const ctx = this.options.createContext();
      const master = ctx.createGain();
      this.ctx = ctx;
      this.master = master;
      master.gain.value = this.volume;
      master.connect(ctx.destination);
      this.options.createLimiter?.(ctx).then(
        (limiter) => {
          if (this.ctx !== ctx) return;
          limiter.setLimiting(this.limiting);
          limiter.connect(ctx.destination);
          master.disconnect();
          master.connect(limiter);
          this.limiter = limiter;
          this.log("limiter ready");
        },
        (error: unknown) => this.log(`limiter unavailable: ${String(error)}`)
      );
    }
    return { ctx: this.ctx, master: this.master };
  }

  private newSlot(track: GaplessTrack): Slot {
    const { ctx, master } = this.context();
    const gain = ctx.createGain();
    gain.gain.value = dbToGain(track.gainDb);
    gain.connect(master);
    return {
      track,
      gain,
      buffer: null,
      decoding: null,
      source: null,
      startedAt: 0,
      pendingOffset: 0,
      element: null,
      elementFade: null,
      bufferFade: null,
      mode: "idle",
      ended: false,
      disposed: false,
    };
  }

  private decode(slot: Slot): Promise<GaplessBuffer | null> {
    if (slot.decoding) return slot.decoding;
    const { track } = slot;
    if (track.durationMs !== null && track.durationMs > GAPLESS_MAX_DECODED_MS) {
      this.log(`${track.key}: ${Math.round(track.durationMs / 1000)} s is too long to decode whole, plays from the element`);
      slot.decoding = Promise.resolve(null);
      return slot.decoding;
    }
    const started = Date.now();
    slot.decoding = this.options
      .fetchBytes(track.url)
      .then((bytes) => this.context().ctx.decodeAudioData(bytes))
      .then((buffer) => {
        if (!slot.disposed) {
          slot.buffer = buffer;
          this.log(`${track.key}: decoded ${buffer.duration.toFixed(3)} s in ${Date.now() - started} ms`);
          this.options.events.onDecoded?.(track.key, buffer);
        }
        return buffer;
      })
      .catch((error: unknown) => {
        this.log(`${track.key}: could not be decoded (${error instanceof Error ? error.message : String(error)}), plays from the element`);
        return null;
      });
    return slot.decoding;
  }

  private dispose(slot: Slot | null) {
    if (!slot || slot.disposed) return;
    slot.disposed = true;
    try {
      slot.source?.stop();
    } catch {
      // A source that never started cannot be stopped; nothing to do.
    }
    slot.source?.disconnect();
    slot.source = null;
    if (slot.element) {
      slot.element.pause();
      slot.element.removeAttribute("src");
      slot.element.load();
      this.releaseElement(slot);
    }
    slot.elementFade?.disconnect();
    slot.bufferFade?.disconnect();
    slot.gain.disconnect();
  }

  /**
   * Plays `track` from `startMs` (or holds it paused there), dropping whatever played before. The song set to follow
   * is kept (the queue often sets it before the current song's place is ready to load) and joined to this one instead.
   */
  load(track: GaplessTrack, startMs = 0, autoplay = true) {
    const reuse = this.next && this.next.track.url === track.url && !this.next.disposed ? this.next : null;
    const keep = !reuse && this.next && !this.next.disposed ? this.next : null;
    if (reuse) this.cancelScheduled(reuse);
    if (keep) this.cancelScheduled(keep);
    this.dispose(this.current);
    if (this.next !== reuse && this.next !== keep) this.dispose(this.next);
    this.next = keep;
    const slot = reuse ?? this.newSlot(track);
    slot.track = track;
    slot.gain.gain.value = dbToGain(track.gainDb);
    this.current = slot;
    this.paused = !autoplay;
    const { ctx } = this.context();
    if (autoplay) void ctx.resume();
    this.log(`load ${track.key} at ${startMs} ms${slot.buffer ? " (already decoded)" : ""}`);
    this.options.events.onPlaying(autoplay);
    this.options.events.onTime(startMs / 1000);
    if (track.durationMs) this.options.events.onDuration(track.durationMs / 1000);
    this.ensureTicker();

    const offset = startMs / 1000;
    slot.pendingOffset = offset;
    if (slot.buffer) {
      this.startBuffer(slot, offset);
      return;
    }
    let settled = false;
    const fallback = this.setTimer(() => {
      if (settled || slot !== this.current) return;
      settled = true;
      this.startElement(slot, offset);
    }, GAPLESS_START_WAIT_MS);
    void this.decode(slot).then((buffer) => {
      if (slot !== this.current || slot.disposed) return;
      if (!settled) {
        settled = true;
        this.clearTimer(fallback);
        if (buffer) this.startBuffer(slot, offset);
        else this.startElement(slot, offset);
        return;
      }
      if (buffer && slot.mode === "element") this.handOver(slot, buffer);
    });
  }

  private startBuffer(slot: Slot, offset: number) {
    const { ctx } = this.context();
    const buffer = slot.buffer;
    if (!buffer) return;
    slot.mode = "buffer";
    slot.ended = false;
    this.options.events.onDuration(buffer.duration);
    const at = ctx.currentTime + LEAD_S;
    this.playSource(slot, buffer, at, Math.min(Math.max(0, offset), buffer.duration));
    this.scheduleNext();
  }

  private playSource(slot: Slot, buffer: GaplessBuffer, at: number, offset: number, into: GaplessNode = slot.gain) {
    const { ctx } = this.context();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(into);
    source.start(at, offset);
    slot.source = source;
    slot.startedAt = at - offset;
  }

  /**
   * The engine's one <audio> element and its Web Audio node (an element can feed only one node, ever), made on first
   * use. Its events go to whichever slot plays from it.
   */
  private sharedElement(): { element: GaplessElement; node: GaplessNode } {
    if (this.element && this.elementNode) return { element: this.element, node: this.elementNode };
    const { ctx } = this.context();
    const element = this.options.createElement();
    // The window reads the song from the local playback server: CORS lets Web Audio hear it (else it is silenced).
    element.crossOrigin = "anonymous";
    const node = ctx.createMediaElementSource(element);
    element.addEventListener("loadedmetadata", () => {
      const slot = this.elementSlot;
      if (!slot) return;
      if (slot.pendingOffset > 0) element.currentTime = slot.pendingOffset;
      if (Number.isFinite(element.duration) && !slot.buffer) this.options.events.onDuration(element.duration);
    });
    element.addEventListener("ended", () => {
      const slot = this.elementSlot;
      if (slot && slot === this.current && slot.mode === "element") this.finishCurrent();
    });
    element.addEventListener("error", () => {
      const slot = this.elementSlot;
      if (slot && slot === this.current && slot.mode === "element") this.options.events.onError(new Error("the song could not be played"));
    });
    this.element = element;
    this.elementNode = node;
    return { element, node };
  }

  private releaseElement(slot: Slot) {
    if (this.elementSlot !== slot) return;
    this.elementNode?.disconnect();
    this.elementSlot = null;
    slot.element = null;
  }

  private startElement(slot: Slot, offset: number) {
    const { ctx } = this.context();
    if (this.elementSlot && this.elementSlot !== slot) this.dispose(this.elementSlot);
    const { element, node } = this.sharedElement();
    slot.mode = "element";
    slot.pendingOffset = offset;
    slot.element = element;
    this.elementSlot = slot;
    const fade = ctx.createGain();
    fade.connect(slot.gain);
    slot.elementFade = fade;
    node.disconnect();
    node.connect(fade);
    element.src = slot.track.url;
    this.log(`${slot.track.key}: starts from the element while it decodes`);
    if (!this.paused) element.play().catch((error: unknown) => this.options.events.onError(error));
  }

  /** The samples are ready while the element plays: carry on from them, at the same place, with a short crossfade. */
  private handOver(slot: Slot, buffer: GaplessBuffer) {
    const element = slot.element;
    if (!element || !slot.elementFade) return;
    const { ctx } = this.context();
    if (this.paused) {
      slot.pendingOffset = element.currentTime;
      element.pause();
      this.releaseElement(slot);
      slot.elementFade.disconnect();
      slot.mode = "buffer";
      slot.source = null;
      this.log(`${slot.track.key}: hands over to the samples while paused at ${slot.pendingOffset.toFixed(3)} s`);
      this.scheduleNext();
      return;
    }
    const lead = 0.05;
    const at = ctx.currentTime + lead;
    const offset = element.currentTime + lead;
    if (offset >= buffer.duration - 1) return;
    const bufferFade = ctx.createGain();
    bufferFade.connect(slot.gain);
    slot.bufferFade = bufferFade;
    bufferFade.gain.setValueAtTime(0, at);
    bufferFade.gain.linearRampToValueAtTime(1, at + HANDOVER_FADE_S);
    slot.elementFade.gain.setValueAtTime(1, at);
    slot.elementFade.gain.linearRampToValueAtTime(0, at + HANDOVER_FADE_S);
    slot.mode = "buffer";
    this.playSource(slot, buffer, at, offset, bufferFade);
    this.log(`${slot.track.key}: hands over from the element to the samples at ${offset.toFixed(3)} s`);
    this.setTimer(() => {
      if (this.elementSlot !== slot) return;
      element.pause();
      this.releaseElement(slot);
      slot.elementFade?.disconnect();
    }, (lead + HANDOVER_FADE_S) * 1000 + 100);
    this.scheduleNext();
  }

  /** Where the current song is, in seconds. */
  position(): number {
    const slot = this.current;
    if (!slot) return 0;
    if (slot.mode === "element" && slot.element) return slot.element.readyState >= 1 ? slot.element.currentTime : slot.pendingOffset;
    if (slot.mode === "buffer" && slot.buffer) {
      if (!slot.source) return slot.pendingOffset;
      const at = this.context().ctx.currentTime - slot.startedAt;
      return Math.min(Math.max(0, at), slot.buffer.duration);
    }
    return slot.pendingOffset;
  }

  /** Sets (or clears) the song that follows the current one; it is decoded ahead and joined with no gap. */
  setNext(track: GaplessTrack | null) {
    const existing = this.next;
    if (existing && track && existing.track.key === track.key && existing.track.url === track.url) {
      if (existing.track.gainDb !== track.gainDb) {
        existing.track = track;
        existing.gain.gain.value = dbToGain(track.gainDb);
      }
      return;
    }
    if (existing) {
      if (existing.source && this.ctx && this.ctx.currentTime >= existing.startedAt) {
        // Already sounding: the boundary passed before the queue caught up. Keep it; the tick moves it to current.
        return;
      }
      this.dispose(existing);
      this.next = null;
    }
    if (!track) return;
    const slot = this.newSlot(track);
    this.next = slot;
    // Repeat one queues the same song again: its samples are already here.
    if (this.current?.buffer && this.current.track.url === track.url) {
      slot.buffer = this.current.buffer;
      slot.decoding = Promise.resolve(slot.buffer);
    }
    void this.decode(slot).then(() => {
      if (slot === this.next) this.scheduleNext();
    });
  }

  private cancelScheduled(slot: Slot) {
    if (!slot.source) return;
    try {
      slot.source.stop();
    } catch {
      // Never started.
    }
    slot.source.disconnect();
    slot.source = null;
  }

  /** Starts the next song's samples on the audio clock at the exact end of the current song's samples. */
  private scheduleNext() {
    const current = this.current;
    const next = this.next;
    if (!current || !next || !next.buffer || next.source) return;
    if (current.mode !== "buffer" || !current.buffer || !current.source) return;
    const { ctx } = this.context();
    const endAt = current.startedAt + current.buffer.duration;
    const at = Math.max(endAt, ctx.currentTime + LEAD_S);
    this.playSource(next, next.buffer, at, 0);
    next.mode = "buffer";
    this.log(
      `${next.track.key} scheduled at ${at.toFixed(6)} s on the audio clock; ${current.track.key} ends at ${endAt.toFixed(6)} s (gap ${((at - endAt) * 1000).toFixed(3)} ms)`
    );
  }

  /** The current song ran out with nothing joined to it. */
  private finishCurrent() {
    const current = this.current;
    if (!current || current.ended) return;
    current.ended = true;
    const next = this.next;
    if (next && next.buffer && !next.source) {
      // The current song played from the element (or the next was not ready in time): start the next one now.
      this.startNextNow(next);
      return;
    }
    this.log(`${current.track.key}: ended`);
    this.options.events.onEnd();
  }

  private startNextNow(next: Slot) {
    const { ctx } = this.context();
    this.playSource(next, next.buffer as GaplessBuffer, ctx.currentTime + LEAD_S, 0);
    next.mode = "buffer";
    this.log(`${next.track.key}: started late after the previous song (it was not joined)`);
    this.promoteNext();
  }

  private promoteNext() {
    const next = this.next;
    if (!next) return;
    this.dispose(this.current);
    this.current = next;
    this.next = null;
    this.log(`now playing ${next.track.key}`);
    if (next.buffer) this.options.events.onDuration(next.buffer.duration);
    this.options.events.onAdvance(next.track.key);
    this.options.events.onTime(this.position());
  }

  private ensureTicker() {
    if (this.ticker !== null) return;
    this.ticker = this.setRepeating(() => this.tick(), 250);
  }

  /** Follows the audio clock: moves to the joined song once it sounds, notices the end, reports the time. */
  tick() {
    const current = this.current;
    if (!current || !this.ctx) return;
    const now = this.ctx.currentTime;
    const next = this.next;
    if (next?.source && now >= next.startedAt) {
      this.promoteNext();
      return;
    }
    if (current.mode === "buffer" && current.buffer && current.source && now >= current.startedAt + current.buffer.duration) {
      this.finishCurrent();
      return;
    }
    if (!this.paused) this.options.events.onTime(this.position());
  }

  play() {
    const current = this.current;
    if (!current) return;
    this.paused = false;
    const { ctx } = this.context();
    void ctx.resume();
    if (current.mode === "buffer" && !current.source && current.buffer) {
      this.playSource(current, current.buffer, ctx.currentTime + LEAD_S, current.pendingOffset);
      this.scheduleNext();
    }
    if (current.mode === "element" && current.element?.paused) {
      current.element.play().catch((error: unknown) => this.options.events.onError(error));
    }
    if (current.ended) {
      // Play after the end starts the song again, like the element did.
      this.seek(0);
    }
    this.options.events.onPlaying(true);
  }

  /** Pauses on the spot: the audio clock stops, so a joined next song stays joined. */
  pause() {
    if (!this.current) return;
    this.paused = true;
    if (this.ctx?.state === "running") void this.ctx.suspend();
    this.current.element?.pause();
    this.options.events.onPlaying(false);
    this.options.events.onTime(this.position());
  }

  seek(seconds: number) {
    const current = this.current;
    if (!current || !this.ctx) return;
    current.ended = false;
    if (current.mode === "element" && current.element) {
      current.element.currentTime = Math.max(0, seconds);
      current.pendingOffset = Math.max(0, seconds);
    } else if (current.mode === "buffer" && current.buffer) {
      this.cancelScheduled(current);
      if (this.next) this.cancelScheduled(this.next);
      const offset = Math.min(Math.max(0, seconds), current.buffer.duration);
      if (this.paused) current.pendingOffset = offset;
      else {
        this.playSource(current, current.buffer, this.ctx.currentTime + LEAD_S, offset);
        this.scheduleNext();
      }
    } else {
      current.pendingOffset = Math.max(0, seconds);
    }
    this.options.events.onTime(Math.max(0, seconds));
  }

  /** The player's own level (PAR-PLAY-05), on top of each song's even-volume gain; it changes at once, with no fade. */
  setVolume(linear: number) {
    this.volume = linear;
    if (this.master && this.ctx) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setValueAtTime(linear, this.ctx.currentTime);
    }
  }

  /** Changes the playing song's even-volume gain (the setting changed, or album and track values switched), at once. */
  setCurrentGain(gainDb: number) {
    const current = this.current;
    if (!current || !this.ctx) return;
    current.track = { ...current.track, gainDb };
    current.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    current.gain.gain.setValueAtTime(dbToGain(gainDb), this.ctx.currentTime);
  }

  /** Turns the limiter on (Even out volume at Loud) or off; it applies as soon as the limiter is ready. */
  setLimiting(on: boolean) {
    this.limiting = on;
    this.limiter?.setLimiting(on);
    this.log(`limiting ${on ? "on" : "off"}${this.limiter ? "" : " (limiter not ready)"}`);
  }

  /** Stops and forgets everything (no song). */
  stop() {
    this.dispose(this.current);
    this.dispose(this.next);
    this.current = null;
    this.next = null;
    this.paused = true;
    if (this.ticker !== null) this.clearRepeating(this.ticker);
    this.ticker = null;
    if (this.ctx?.state === "running") void this.ctx.suspend();
    this.options.events.onPlaying(false);
  }
}
