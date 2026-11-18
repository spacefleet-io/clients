import { StreamSlotGate, streamSlotText, type StreamDevice, type StreamSlotsClient, type StreamSlotTimers } from "@space/stream-slots";

/**
 * The Jellyfin server's place in the profile's stream limit (ACCT-STREAM-01..04), on top of the shared
 * `StreamSlotGate` (`packages/stream-slots`). The plugin (`StreamLimitGuard.cs`) reports every Jellyfin playback of a
 * Badger item here: `start` when it starts, `poll` while it plays, `stop` when it ends.
 *
 * - The Jellyfin server signs in once, so the API sees one device: the gate holds that device's one place, for the
 *   followed profile (INTG-PROF-01), while one Jellyfin session (the `holder`) plays. A second Jellyfin session on the
 *   same server is a second video of the same profile, so it meets the limit here, naming the playing session's
 *   device (the API would only replace the server's own stream and never count it twice).
 * - Jellyfin apps have no yes/no dialog a server can open, so the question "Already playing on {device}. Play here
 *   instead?" (ACCT-STREAM-02) goes to the viewer's app as a message and its playback is stopped (Cancel changes
 *   nothing). Starting the same title again in the same Jellyfin session within `PLAY_HERE_WINDOW_MS` is "Play here":
 *   the start goes again with `takeover: true` (or takes the place from the other Jellyfin session).
 * - Taken over (by another device through the API, or by another Jellyfin session): the next `poll` of the session
 *   that held the place answers `takenOver` with "Playing on {device} now"; the plugin stops that playback.
 * - The API cannot be reached: the gate lets the playback run without a place (ACCT-STREAM-05, option A).
 */

/** How long after the question a new start of the same title in the same Jellyfin session counts as "Play here". */
export const PLAY_HERE_WINDOW_MS = 120_000;

/** `deviceType` of a Jellyfin session as the shared texts label it ("Jellyfin" when the session has no name). */
const JELLYFIN_DEVICE_TYPE = "jellyfin";

export type StreamStartInput = {
  /** The Jellyfin session id (one app on one device). */
  session: string;
  /** The Jellyfin item id: a new start of the same item after the question is "Play here". */
  item: string;
  /** The Jellyfin session's device name, shown to the other session if this one takes its place. */
  deviceName: string | null;
  /** UI language for the texts (en, fr, nl, de; anything else is English). */
  language: string;
};

export type StreamStartAnswer =
  | { status: "play"; takeover: boolean }
  /** Stop this playback and show `text` (ACCT-STREAM-02). */
  | { status: "limit"; device: StreamDevice; text: string };

export type StreamPollAnswer =
  | { status: "play" }
  /** This session holds no place (never asked, already stopped, or played without a place). */
  | { status: "idle" }
  /** Another device took the place: stop this playback and show `text`. */
  | { status: "takenOver"; device: StreamDevice; text: string };

export type JellyfinStreamSlotsOptions = {
  client: StreamSlotsClient;
  /** The followed profile (INTG-PROF-01), read at each start. */
  getProfileId: () => string | null;
  log: (message: string, meta?: Record<string, unknown>) => void;
  now?: () => number;
  timers?: StreamSlotTimers;
};

type Holder = { session: string; device: StreamDevice };

export class JellyfinStreamSlots {
  private readonly gate: StreamSlotGate;
  private readonly now: () => number;
  private holder: Holder | null = null;
  /** `${session}|${item}` → when the question was sent. */
  private readonly offered = new Map<string, number>();
  /** Jellyfin sessions whose place another Jellyfin session took, with that session's device. */
  private readonly evicted = new Map<string, StreamDevice>();

  constructor(private readonly options: JellyfinStreamSlotsOptions) {
    this.now = options.now ?? Date.now;
    this.gate = new StreamSlotGate({
      client: options.client,
      app: "badger",
      getProfileId: options.getProfileId,
      log: (event, fields) => options.log(event, fields),
      onError: (error) => options.log("stream slot request failed", { error: error instanceof Error ? error.message : String(error) }),
      ...(options.timers ? { timers: options.timers } : {}),
    });
  }

  /** The Jellyfin session holding the place, for diagnostics and tests. */
  get holderSession(): string | null {
    return this.holder?.session ?? null;
  }

  async start(input: StreamStartInput): Promise<StreamStartAnswer> {
    const self: Holder = { session: input.session, device: { deviceName: input.deviceName?.trim() || null, deviceType: JELLYFIN_DEVICE_TYPE } };
    this.evicted.delete(input.session);
    if (this.holder?.session === input.session && this.gate.getState().kind !== "takenOver") {
      // Next episode or a restart in the same Jellyfin session: the place is reused (the gate asks no one).
      await this.gate.acquire({ owner: input.session });
      this.log("stream place reused", { session: input.session });
      return { status: "play", takeover: false };
    }
    const key = `${input.session}|${input.item}`;
    this.pruneOffers();
    const playHere = this.offered.has(key);
    this.offered.delete(key);

    if (this.holder && this.holder.session !== input.session && this.gate.getState().kind === "playing") {
      const other = this.holder;
      if (!playHere) return this.ask(key, other.device, input.language, "jellyfin_session");
      // "Play here" against another Jellyfin session of this server: the server's place moves to this session.
      this.evicted.set(other.session, self.device);
      this.holder = self;
      await this.gate.acquire({ owner: input.session });
      this.log("stream place taken from another Jellyfin session", { session: input.session, from: other.session });
      return { status: "play", takeover: true };
    }

    // No Jellyfin session plays (or the one that did was taken over): ask the API.
    const before = this.gate.getState();
    if (this.holder && this.holder.session !== input.session && before.kind === "takenOver") this.evicted.set(this.holder.session, before.device);
    this.holder = null;
    this.gate.dismiss();
    let asked: StreamDevice | null = null;
    const unsubscribe = this.gate.subscribe(() => {
      const state = this.gate.getState();
      if (state.kind !== "asking") return;
      asked = state.device;
      this.gate.answer(playHere ? "playHere" : "cancel");
    });
    let outcome: "play" | "cancel";
    try {
      outcome = await this.gate.acquire({ owner: input.session });
    } finally {
      unsubscribe();
    }
    if (outcome === "cancel") {
      return this.ask(key, asked ?? { deviceName: null, deviceType: null }, input.language, "api");
    }
    this.holder = self;
    this.log("stream place taken", { session: input.session, takeover: playHere, held: this.gate.holding });
    return { status: "play", takeover: playHere };
  }

  poll(session: string, language: string): StreamPollAnswer {
    const by = this.evicted.get(session);
    if (by) {
      this.evicted.delete(session);
      return this.takenOver(session, by, language, "jellyfin_session");
    }
    if (this.holder?.session !== session) return { status: "idle" };
    const state = this.gate.getState();
    if (state.kind === "takenOver") {
      this.holder = null;
      this.gate.dismiss();
      return this.takenOver(session, state.device, language, "api");
    }
    return { status: "play" };
  }

  /** The Jellyfin playback ended: frees the place when this session held it. */
  async stop(session: string): Promise<void> {
    this.evicted.delete(session);
    if (this.holder?.session !== session) {
      this.log("stream stop ignored: session holds no place", { session, holder: this.holder?.session ?? null });
      return;
    }
    this.holder = null;
    await this.gate.release(session);
    this.log("stream place released", { session });
  }

  private ask(key: string, device: StreamDevice, language: string, source: string): StreamStartAnswer {
    this.offered.set(key, this.now());
    this.log("stream limit: asked to play here instead", { key, source, deviceType: device.deviceType });
    return { status: "limit", device, text: streamSlotText(language, "alreadyPlaying", device) };
  }

  private takenOver(session: string, device: StreamDevice, language: string, source: string): StreamPollAnswer {
    this.log("stream taken over", { session, source, deviceType: device.deviceType });
    return { status: "takenOver", device, text: streamSlotText(language, "playingElsewhere", device) };
  }

  private pruneOffers() {
    const cutoff = this.now() - PLAY_HERE_WINDOW_MS;
    for (const [key, at] of this.offered) if (at < cutoff) this.offered.delete(key);
  }

  private log(message: string, meta: Record<string, unknown>) {
    this.options.log(message, meta);
  }
}
