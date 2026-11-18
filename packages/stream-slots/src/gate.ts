import type { StreamDevice, StreamKind, PlayingOnDevice } from "./contract";
import type { StreamSlotsClient } from "./client";
import { StreamSlot, type StreamSlotOptions } from "./streamSlot";

/**
 * The player-facing flow every player shares (ACCT-STREAM-01..04), on top of `StreamSlot`, so the desktop renderer,
 * the phone / TV app and Parrot differ only in how they draw the question and stop their engine:
 *
 * - `await gate.acquire()` before a streamed source loads. `"play"` → load it; `"cancel"` → the user chose Cancel at
 *   "Already playing on {device}. Play here instead?": close the player (or leave the music as it was), nothing else
 *   changes. While the question is open the state is `asking` (draw it with `streamSlotText`) and
 *   `gate.answer("playHere" | "cancel")` settles it; Play here starts again with `takeover: true` (and asks again
 *   when yet another device took the place meanwhile). A place already held for the same `kind` (format reload, next
 *   episode, next song) is reused without a request.
 * - Casting (ACCT-STREAM-03): `acquire({ kind: "cast" })`; a held place of the other kind is given back and taken
 *   again with the new kind (the server replaces the login session's own stream, so this never asks).
 * - `owner`: the screen that holds the place. `release(owner)` frees it only while that owner still holds it, so a
 *   closing player cannot free the place the cast screen that replaced it just took.
 * - Another device takes the place over: `onTakenOver(device)` fires (stop the engine) and the state turns
 *   `takenOver` until `gate.dismiss()`, so the player can show "Playing on {device} now" after it closed.
 * - `await gate.release()` when the player closes or the music stops: frees the place (also one taken by a start
 *   that answered late).
 * - Offline playback of a download never calls `acquire` (ACCT-STREAM-03).
 *
 * The API cannot be reached (network down, 5xx): the player plays without a place and asks again on the next
 * playback, never in the middle of this one (ACCT-STREAM-05, decision pending; this is option A).
 */

export type StreamSlotGateState =
  | { kind: "idle" }
  | { kind: "asking"; device: StreamDevice }
  | { kind: "playing" }
  | { kind: "takenOver"; device: StreamDevice };

export type StreamSlotAnswer = "playHere" | "cancel";

export type StreamSlotGateOptions = Omit<StreamSlotOptions, "profileId" | "onTakenOver" | "client" | "kind"> & {
  client: StreamSlotsClient;
  /** The playing profile, read at every acquire (the user may switch profiles between playbacks). */
  getProfileId: () => string | null | undefined;
  /** Another device took the place: stop the engine. The notice itself is the `takenOver` state. */
  onTakenOver?: (by: StreamDevice) => void;
};

export type StreamSlotAcquireOptions = {
  /** `cast` when the phone plays on a Google Cast / AirPlay receiver (ACCT-STREAM-03); `play` by default. */
  kind?: StreamKind;
  /** Who holds the place (a screen id); see `release`. */
  owner?: string;
};

const IDLE: StreamSlotGateState = { kind: "idle" };

/** The device "Play here" stops: the oldest stream of the profile (the API's takeover ends the oldest). */
export const deviceToTakeOver = (playingOn: PlayingOnDevice[]): StreamDevice => {
  const oldest = [...playingOn].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))[0];
  return { deviceName: oldest?.deviceName ?? null, deviceType: oldest?.deviceType ?? null };
};

export class StreamSlotGate {
  private slot: StreamSlot | null = null;
  private slotKind: StreamKind = "play";
  private owner: string | null = null;
  private state: StreamSlotGateState = IDLE;
  private readonly listeners = new Set<() => void>();
  private pendingAnswer: ((answer: StreamSlotAnswer) => void) | null = null;
  private inFlight: { kind: StreamKind; run: Promise<"play" | "cancel"> } | null = null;
  /** This playback runs without a place because the API could not be reached at its start. */
  private unchecked = false;
  /** Bumped by every release so a late answer of an older acquire is ignored. */
  private generation = 0;

  constructor(private readonly options: StreamSlotGateOptions) {}

  getState = (): StreamSlotGateState => this.state;

  /** True while this device holds a place (or plays unchecked because the API could not be reached). */
  get holding(): boolean {
    return this.slot?.streamId != null || this.unchecked;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async acquire(options: StreamSlotAcquireOptions = {}): Promise<"play" | "cancel"> {
    const kind = options.kind ?? "play";
    if (options.owner !== undefined) this.owner = options.owner;
    if (this.holding && this.slotKind === kind) {
      this.log("stream_slot.gate.reuse", { kind, unchecked: this.unchecked });
      return "play";
    }
    if (this.inFlight?.kind === kind) return this.inFlight.run;
    if (this.holding || this.inFlight) {
      // The other kind (playing → casting): give the place back, then take it again as `kind`.
      this.log("stream_slot.gate.kind_change", { from: this.slotKind, to: kind });
      const owner = this.owner;
      await this.release();
      this.owner = owner;
    }
    const generation = this.generation;
    const run = this.run(generation, kind).finally(() => {
      if (this.inFlight?.run === run) this.inFlight = null;
    });
    this.inFlight = { kind, run };
    return run;
  }

  /** Settles the open "Play here instead?" question. */
  answer(answer: StreamSlotAnswer): void {
    const pending = this.pendingAnswer;
    this.pendingAnswer = null;
    this.log("stream_slot.gate.answer", { answer, open: pending !== null });
    pending?.(answer);
  }

  /** Hides the "Playing on {device} now" notice. */
  dismiss(): void {
    if (this.state.kind === "takenOver") this.setState(IDLE);
  }

  /**
   * The player closed or the music stopped: free the place. With `owner`, only while that owner still holds it
   * (another screen that took the place since keeps it). Never throws.
   */
  async release(owner?: string): Promise<void> {
    if (owner !== undefined && this.owner !== null && this.owner !== owner) {
      this.log("stream_slot.gate.release_skipped", { owner, holder: this.owner });
      return;
    }
    // Logged as its own event: a release (the player screen unmounting, a JS reload in dev) must never read as the
    // user answering Cancel in the logs.
    this.log("stream_slot.gate.release", {
      owner: owner ?? null,
      holder: this.owner,
      streamId: this.slot?.streamId ?? null,
      asking: this.pendingAnswer !== null,
    });
    this.generation += 1;
    this.unchecked = false;
    this.owner = null;
    if (this.pendingAnswer !== null) this.answer("cancel");
    const slot = this.slot;
    this.slot = null;
    if (this.state.kind !== "takenOver") this.setState(IDLE);
    await slot?.stop();
  }

  private async run(generation: number, kind: StreamKind): Promise<"play" | "cancel"> {
    const slot = new StreamSlot({
      ...this.options,
      kind,
      profileId: this.options.getProfileId() ?? undefined,
      onTakenOver: (by) => this.takenOver(slot, by),
    });
    this.slot = slot;
    this.slotKind = kind;
    let takeover = false;
    for (;;) {
      let result;
      try {
        result = await slot.start({ takeover });
      } catch (error) {
        if (generation !== this.generation) return "cancel";
        this.log("stream_slot.gate.unreachable", { kind, takeover });
        this.options.onError?.(error);
        if (this.slot === slot) this.slot = null;
        this.unchecked = true;
        this.setState({ kind: "playing" });
        return "play";
      }
      if (generation !== this.generation) {
        // Released while the request was out: give back the place it took. The slot itself already stopped (its
        // `current` was never set), so free the late stream by id.
        if (result.status === "started") {
          this.log("stream_slot.gate.late_start", { streamId: result.stream.streamId });
          try {
            await this.options.client.stopStream(result.stream.streamId);
          } catch (error) {
            this.options.onError?.(error);
          }
        }
        return "cancel";
      }
      if (result.status === "started") {
        this.setState({ kind: "playing" });
        return "play";
      }
      const device = deviceToTakeOver(result.playingOn);
      const pending = Promise.withResolvers<StreamSlotAnswer>();
      this.pendingAnswer = pending.resolve;
      this.setState({ kind: "asking", device });
      const answer = await pending.promise;
      if (answer === "cancel" || generation !== this.generation) {
        if (this.slot === slot) this.slot = null;
        if (generation === this.generation) this.setState(IDLE);
        return "cancel";
      }
      takeover = true;
    }
  }

  private takenOver(slot: StreamSlot, by: StreamDevice) {
    if (slot !== this.slot) return;
    this.slot = null;
    this.owner = null;
    this.log("stream_slot.gate.taken_over", { deviceType: by.deviceType });
    this.setState({ kind: "takenOver", device: by });
    this.options.onTakenOver?.(by);
  }

  private setState(next: StreamSlotGateState) {
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private log(event: string, fields: Record<string, unknown>) {
    this.options.log?.(event, fields);
  }
}
