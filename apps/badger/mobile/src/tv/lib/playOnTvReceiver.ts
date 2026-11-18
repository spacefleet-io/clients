/**
 * The TV side of "Play on TV" (UX-TV-02): takes the phone's sealed commands from the relay, starts the title at the
 * phone's resume point, hands every other command to the open player (`playerLink.ts`) and reports the player's state back
 * to the phone that is driving it. Pure: the channel, the title start and the player link are injected.
 *
 * Decisions are logged as `tv.cast.*` lines (`console.info`, JSON): the e2e scenario `tv-remote-cast` reads them from logcat.
 * They carry the command and its numbers, never a title or a media id.
 */
import type { PlayOnTvChannel } from "../../lib/playOnTv/channel";
import type { RemotePlayer, RemotePlayerEvent } from "../../lib/playOnTv/playerLink";
import { describeBody, IDLE_STATE, type RemoteBody, type StartCommand, type TvState } from "../../lib/playOnTv/protocol";

export type StartOutcome = "ok" | "media_not_found" | "start_failed";

export type TvReceiverDeps = {
  channel: PlayOnTvChannel;
  /** Opens the player on the title (TV: navigation to the Player screen with the remote start). */
  startTitle: (command: StartCommand) => Promise<StartOutcome>;
  currentPlayer: () => RemotePlayer | null;
  log?: (event: string, data: Record<string, unknown>) => void;
};

export type TvReceiver = {
  handle: (fromPeerId: string, body: RemoteBody) => Promise<void>;
  /** Feed of the player link: forwards states to the phone in charge. */
  onPlayerEvent: (event: RemotePlayerEvent) => void;
  /** The phone that sent the last command (states go to it), or null. */
  controller: () => string | null;
};

const defaultLog = (event: string, data: Record<string, unknown>) => console.info(event, JSON.stringify(data));

export const createTvReceiver = (deps: TvReceiverDeps): TvReceiver => {
  const log = deps.log ?? defaultLog;
  let controller: string | null = null;
  let lastPhase: TvState["phase"] | null = null;
  /** Set while a remote start is opening the player, so the first states say `loading` for that title. */
  let pendingStart: StartCommand | null = null;

  const report = async (state: TvState, why: string) => {
    if (!controller) return;
    if (state.phase !== lastPhase || why !== "tick") {
      log("tv.cast.state", { why, ...describeBody(state) });
      lastPhase = state.phase;
    }
    const delivered = await deps.channel.send(controller, state);
    if (delivered === 0) log("tv.cast.state.undelivered", { why });
  };

  const handle = async (fromPeerId: string, body: RemoteBody) => {
    if (body.type === "state") return; // only phones send commands; a state from elsewhere is ignored
    controller = fromPeerId;
    log("tv.cast.command", describeBody(body));

    if (body.type === "hello") {
      await report(deps.currentPlayer()?.state() ?? IDLE_STATE, "hello");
      return;
    }

    if (body.type === "start") {
      pendingStart = body;
      let outcome: StartOutcome;
      try {
        outcome = await deps.startTitle(body);
      } catch (error) {
        log("tv.cast.start.error", { error: String(error) });
        outcome = "start_failed";
      }
      log("tv.cast.start", { outcome, positionSeconds: Math.round(body.positionSeconds), episode: body.episodeId !== null, tracks: body.tracks });
      if (outcome !== "ok") {
        pendingStart = null;
        await report({ ...IDLE_STATE, phase: "failed", error: outcome }, "start");
        return;
      }
      await report(
        { ...IDLE_STATE, phase: "loading", mediaId: body.mediaId, episodeId: body.episodeId, positionSeconds: body.positionSeconds },
        "start",
      );
      return;
    }

    const player = deps.currentPlayer();
    if (!player) {
      log("tv.cast.command.no_player", { type: body.type });
      await report({ ...IDLE_STATE, error: "not_playing" }, body.type);
      return;
    }
    let error: string | null;
    try {
      error = await player.apply(body);
    } catch (thrown) {
      error = "command_failed";
      log("tv.cast.command.error", { type: body.type, error: String(thrown) });
    }
    log("tv.cast.applied", { type: body.type, error });
    if (body.type === "stop") return; // the player closes; its detach reports `ended`
    await report({ ...player.state(), error }, body.type);
  };

  const onPlayerEvent = (event: RemotePlayerEvent) => {
    if (event.kind === "attached") {
      log("tv.cast.player.attached", { controlled: controller !== null, remoteStart: pendingStart !== null });
      pendingStart = null;
      return;
    }
    if (event.kind === "detached") {
      // A remote start that replaces the open player closes the old one first, and the next episode replaces the player
      // too: neither is the end of the session.
      const replacing = pendingStart !== null;
      log("tv.cast.player.detached", { controlled: controller !== null, replacing, handover: event.handover });
      if (!replacing && !event.handover) void report({ ...event.last, phase: "ended", error: null }, "detached");
      return;
    }
    void report(event.state, "tick");
  };

  return { handle, onPlayerEvent, controller: () => controller };
};
