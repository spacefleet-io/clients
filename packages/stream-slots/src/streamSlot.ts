import { STREAM_HEARTBEAT_INTERVAL_SECONDS, type StreamApp, type StreamDevice, type StreamKind } from "./contract";
import type { StartStreamResult, StreamSlotsClient } from "./client";

/**
 * One player's stream slot (ACCT-STREAM-01..04). Every online player (desktop, phone, TV, web, Parrot) holds one
 * while it streams:
 *
 * 1. `await slot.start()` before playback starts. `started` → play. `limit` → ask
 *    "Already playing on {device}. Play here instead?" (`streamSlotText(lang, "alreadyPlaying", …)`); "Play here"
 *    calls `slot.start({ takeover: true })`, "Cancel" leaves everything as it is (ACCT-STREAM-02).
 * 2. While playing, the slot heartbeats every 20 s on its own (ACCT-STREAM-04). When another device takes the slot
 *    over, the heartbeat stops and `onTakenOver(device)` fires once: stop playback and show
 *    "Playing on {device} now" (`streamSlotText(lang, "playingElsewhere", …)`).
 * 3. `await slot.stop()` when playback ends or the player closes. A crash needs nothing: the server drops a stream
 *    not heard from for 60 s.
 *
 * Next episode / restart on the same device: call `start()` again; the server replaces this login session's own
 * stream instead of counting it twice. Casting (ACCT-STREAM-03): the phone keeps its slot (and keeps heartbeating)
 * while the receiver plays; start with `kind: "cast"` when playback begins straight on the receiver; the receiver
 * never takes a slot. Offline playback of downloads never creates a slot.
 *
 * A heartbeat that fails on the network is reported through `onError` and retried at the next tick: the server
 * enforces the limit only when a stream starts, so a short outage never stops playback.
 */

export type StreamSlotTimers = {
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
};

export type StreamSlotOptions = {
  client: StreamSlotsClient;
  app: StreamApp;
  /** The playing profile; omitted = the account's main profile. */
  profileId?: string;
  kind?: StreamKind;
  /** Another device took this slot: stop playback and say "Playing on {device} now". Fires once per stream. */
  onTakenOver: (by: StreamDevice) => void;
  /** A request failed (network, 5xx). Diagnostic only: the slot keeps going. */
  onError?: (error: unknown) => void;
  /** Structured diagnostics (ids and statuses only, never titles). */
  log?: (event: string, fields: Record<string, unknown>) => void;
  timers?: StreamSlotTimers;
};

const defaultTimers: StreamSlotTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class StreamSlot {
  private readonly timers: StreamSlotTimers;
  private handle: unknown = null;
  private current: string | null = null;
  private beating = false;
  /** Bumped by every start/stop so a late heartbeat answer for an older stream is ignored. */
  private generation = 0;

  constructor(private readonly options: StreamSlotOptions) {
    this.timers = options.timers ?? defaultTimers;
  }

  /** The held stream's id, or null when the slot holds none. */
  get streamId(): string | null {
    return this.current;
  }

  /** Asks the API for the slot. Throws `StreamSlotsError` when the API cannot be reached or fails. */
  async start(options: { takeover?: boolean } = {}): Promise<StartStreamResult> {
    this.clearTimer();
    const generation = ++this.generation;
    const result = await this.options.client.startStream({
      app: this.options.app,
      ...(this.options.profileId ? { profileId: this.options.profileId } : {}),
      kind: this.options.kind ?? "play",
      takeover: options.takeover === true,
    });
    this.log("stream_slot.start", {
      app: this.options.app,
      takeover: options.takeover === true,
      status: result.status,
      ...(result.status === "started" ? { streamId: result.stream.streamId } : { limit: result.limit, playing: result.playingOn.length }),
    });
    if (generation !== this.generation) return result;
    if (result.status === "started") {
      this.current = result.stream.streamId;
      const seconds = result.stream.heartbeatIntervalSeconds || STREAM_HEARTBEAT_INTERVAL_SECONDS;
      this.handle = this.timers.setInterval(() => void this.beat(), seconds * 1000);
    } else {
      this.current = null;
    }
    return result;
  }

  /** Stops heartbeating and frees the slot. Never throws; a failed request goes to `onError`. */
  async stop(): Promise<void> {
    this.clearTimer();
    this.generation += 1;
    const streamId = this.current;
    this.current = null;
    if (!streamId) return;
    this.log("stream_slot.stop", { streamId });
    try {
      await this.options.client.stopStream(streamId);
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  /** One heartbeat; exposed for tests and for players that want to beat right after a resume from sleep. */
  async beat(): Promise<void> {
    const streamId = this.current;
    if (!streamId || this.beating) return;
    const generation = this.generation;
    this.beating = true;
    try {
      const result = await this.options.client.heartbeat(streamId);
      if (generation !== this.generation) return;
      if (result.status === "alive") return;
      this.log("stream_slot.heartbeat", { streamId, status: result.status });
      if (result.status === "taken_over") {
        this.release();
        this.options.onTakenOver(result.by);
        return;
      }
      // Expired (the device slept or lost the network for over a minute): take a slot again, without taking over.
      const restarted = await this.start();
      if (restarted.status === "limit") {
        const other = restarted.playingOn[0];
        this.options.onTakenOver({ deviceName: other?.deviceName ?? null, deviceType: other?.deviceType ?? null });
      }
    } catch (error) {
      this.log("stream_slot.heartbeat_failed", { streamId });
      this.options.onError?.(error);
    } finally {
      this.beating = false;
    }
  }

  private release() {
    this.clearTimer();
    this.generation += 1;
    this.current = null;
  }

  private clearTimer() {
    if (this.handle !== null) this.timers.clearInterval(this.handle);
    this.handle = null;
  }

  private log(event: string, fields: Record<string, unknown>) {
    this.options.log?.(event, fields);
  }
}
