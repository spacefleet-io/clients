import { buildGetPropertyCommand, type MpvCommand, type MpvResponse } from "@space/mpv-protocol";

/**
 * E2E-only decode-load injection (issue #25), never reachable in production:
 * installed only when SF_E2E=1 AND `SF_E2E_INJECT_FRAME_DROPS=<codec>:<dropsPerSecond>`.
 *
 * Wraps the main-process answer to a renderer `get_property frame-drop-count`
 * request: adds a synthetic count that grows by `dropsPerSecond` per
 * wall-clock second, over every interval between two reads that both found
 * mpv's selected video track on `<codec>` (from the real `track-list`). It
 * restarts per mpv process, like mpv's own counter. Everything else stays
 * mpv's: `decoder-frame-drop-count`, the cache, playback, codecs. So the
 * renderer's decode-bound detector sees a codec this machine "cannot decode"
 * in real time, independent of CPU speed, while its healthy-buffer gate and
 * reload/first-frame holds run on real values.
 */

export type FrameDropInjectorState = {
  codec: string;
  dropsPerSecond: number;
  /** Synthetic drops added so far for the current mpv process. */
  injected: number;
  /** Selected video track codec at the last `frame-drop-count` read. */
  lastCodec: string | null;
};

/** The live mpv the reply came from; a new instance = a new mpv process. */
export type FrameDropInjectorMpv = { request(cmd: MpvCommand): Promise<MpvResponse> };

export type FrameDropInjector = {
  apply(command: unknown, reply: MpvResponse, mpv: FrameDropInjectorMpv): Promise<MpvResponse>;
  state(): FrameDropInjectorState;
};

declare global {
  // Read-only view for the Playwright driver: `electronApp.evaluate(() => globalThis.__sfE2eFrameDropInjector?.state())`.
  var __sfE2eFrameDropInjector: { state(): FrameDropInjectorState } | undefined;
}

const SPEC = /^([a-z0-9_]+):(\d+(?:\.\d+)?)$/;

const isFrameDropRead = (command: unknown): boolean => {
  if (!command || typeof command !== "object" || !("command" in command) || !Array.isArray(command.command)) {
    return false;
  }
  const [name, property] = command.command as unknown[];
  return name === "get_property" && property === "frame-drop-count";
};

const selectedVideoCodec = (trackList: unknown): string | null => {
  if (!Array.isArray(trackList)) return null;
  for (const track of trackList as Array<Record<string, unknown>>) {
    if (track?.type === "video" && track.selected === true) {
      return typeof track.codec === "string" ? track.codec : null;
    }
  }
  return null;
};

export const installE2eFrameDropInjector = (
  env: NodeJS.ProcessEnv = process.env,
  nowMs: () => number = Date.now,
): FrameDropInjector | null => {
  if (env.SF_E2E !== "1") return null;
  const raw = env.SF_E2E_INJECT_FRAME_DROPS?.trim();
  if (!raw) return null;
  const match = SPEC.exec(raw.toLowerCase());
  const dropsPerSecond = match ? Number(match[2]) : 0;
  if (!match || !(dropsPerSecond > 0)) {
    throw new Error(`SF_E2E_INJECT_FRAME_DROPS must be <codec>:<dropsPerSecond> (e.g. hevc:4), got ${JSON.stringify(raw)}`);
  }
  const codec = match[1]!;

  let currentMpv: FrameDropInjectorMpv | null = null;
  let injected = 0;
  let lastReadAt: number | null = null;
  let lastCodec: string | null = null;

  const state = (): FrameDropInjectorState => ({ codec, dropsPerSecond, injected: Math.floor(injected), lastCodec });

  const injector: FrameDropInjector = {
    async apply(command, reply, mpv) {
      if (!isFrameDropRead(command) || typeof reply.data !== "number") return reply;
      if (mpv !== currentMpv) {
        currentMpv = mpv;
        injected = 0;
        lastReadAt = null;
        lastCodec = null;
      }
      const playing = selectedVideoCodec((await mpv.request(buildGetPropertyCommand("track-list"))).data);
      const at = nowMs();
      if (playing === codec && lastCodec === codec && lastReadAt !== null && at > lastReadAt) {
        injected += (dropsPerSecond * (at - lastReadAt)) / 1000;
      }
      // Concurrent reads may resolve out of order: the clock only moves forward.
      lastReadAt = lastReadAt === null ? at : Math.max(lastReadAt, at);
      lastCodec = playing;
      return { ...reply, data: reply.data + Math.floor(injected) };
    },
    state,
  };
  globalThis.__sfE2eFrameDropInjector = { state };
  return injector;
};
