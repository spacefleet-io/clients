import { SPACE_APP_HEADER } from "@space/shared/appScope";
import { clientIdentityHeaders, getClientIdentity } from "@space/shared/appVersion";
import {
  STREAM_ERRORS,
  type HeartbeatBody,
  type PlayingOnDevice,
  type StartedStream,
  type StartStreamRequest,
  type StreamDevice,
  type StreamLimitBody,
  type TakenOverBody,
} from "./contract";

/**
 * Typed client of the stream slot routes (ACCT-STREAM-01..04). Pure `fetch`: runs in the Electron renderer,
 * React Native (phone, TV), browsers and Bun. Answers the API gives on purpose come back as values; anything
 * else (network down, 401, 5xx) throws `StreamSlotsError` so the caller decides.
 */

export type StreamSlotsClientOptions = {
  /** API origin, e.g. `https://api.spacefleet.io`; a trailing slash is ignored. A function is read at each request
   * (an app whose API origin can change at runtime, e.g. Badger phone's API picker). */
  baseUrl: string | (() => string);
  /** The login session token sent as `Authorization: Bearer`. */
  getToken: () => string | null | Promise<string | null>;
  fetch?: typeof fetch;
};

export type StartStreamResult =
  | { status: "started"; stream: StartedStream }
  /** ACCT-STREAM-02: ask "Already playing on <device>. Play here instead?"; yes = start again with `takeover: true`. */
  | { status: "limit"; limit: number; playingOn: PlayingOnDevice[] };

export type HeartbeatResult =
  | { status: "alive"; expiresInSeconds: number }
  /** Another device took the slot: stop playing and show "Playing on <device> now". */
  | { status: "taken_over"; by: StreamDevice }
  /** The stream expired or was stopped; the device may start a new one. */
  | { status: "ended" };

export class StreamSlotsError extends Error {
  constructor(
    readonly operation: "start" | "heartbeat" | "stop",
    /** HTTP status, or 0 when the request never got an answer. */
    readonly status: number,
    /** The API's `error` code when it sent one. */
    readonly code: string | null,
    options?: { cause?: unknown }
  ) {
    super(`stream slots ${operation} failed: ${status}${code ? ` ${code}` : ""}`, options);
    this.name = "StreamSlotsError";
  }
}

export type StreamSlotsClient = {
  startStream: (request: StartStreamRequest) => Promise<StartStreamResult>;
  heartbeat: (streamId: string) => Promise<HeartbeatResult>;
  /** Frees the slot. Already gone is fine (204 either way). */
  stopStream: (streamId: string) => Promise<void>;
};

const readJson = async (response: Response): Promise<Record<string, unknown>> => {
  try {
    const body = (await response.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export const createStreamSlotsClient = (options: StreamSlotsClientOptions): StreamSlotsClient => {
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  const send = async (operation: StreamSlotsError["operation"], method: string, path: string, body?: unknown) => {
    const token = await options.getToken();
    // REL-CD-29, REL-LOG-28: the build calling (`x-space-client`) and its app (`x-space-app`), as every other API call
    // of the process states them; nothing while the process has set no identity (a dev build).
    const app = getClientIdentity()?.app;
    const headers: Record<string, string> = { ...clientIdentityHeaders(), ...(app ? { [SPACE_APP_HEADER]: app } : {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    try {
      const base = (typeof options.baseUrl === "function" ? options.baseUrl() : options.baseUrl).replace(/\/+$/u, "");
      return await doFetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (cause) {
      throw new StreamSlotsError(operation, 0, null, { cause });
    }
  };

  const fail = async (operation: StreamSlotsError["operation"], response: Response): Promise<never> => {
    const body = await readJson(response);
    throw new StreamSlotsError(operation, response.status, typeof body.error === "string" ? body.error : null);
  };

  return {
    startStream: async (request) => {
      const response = await send("start", "POST", "/playback/streams", request);
      if (response.status === 201) return { status: "started", stream: (await response.json()) as StartedStream };
      if (response.status === 409) {
        const body = (await readJson(response)) as Partial<StreamLimitBody>;
        if (body.error === STREAM_ERRORS.limit) {
          return { status: "limit", limit: Number(body.limit ?? 0), playingOn: Array.isArray(body.playingOn) ? body.playingOn : [] };
        }
        throw new StreamSlotsError("start", 409, typeof body.error === "string" ? body.error : null);
      }
      return fail("start", response);
    },

    heartbeat: async (streamId) => {
      const response = await send("heartbeat", "POST", `/playback/streams/${encodeURIComponent(streamId)}/heartbeat`);
      if (response.status === 200) {
        const body = (await response.json()) as HeartbeatBody;
        return { status: "alive", expiresInSeconds: body.expiresInSeconds };
      }
      if (response.status === 409 || response.status === 404) {
        const body = await readJson(response);
        if (response.status === 409 && body.error === STREAM_ERRORS.takenOver) {
          const taken = body as Partial<TakenOverBody>;
          return { status: "taken_over", by: { deviceName: taken.byDeviceName ?? null, deviceType: taken.byDeviceType ?? null } };
        }
        if (response.status === 404 && body.error === STREAM_ERRORS.ended) return { status: "ended" };
        throw new StreamSlotsError("heartbeat", response.status, typeof body.error === "string" ? body.error : null);
      }
      return fail("heartbeat", response);
    },

    stopStream: async (streamId) => {
      const response = await send("stop", "DELETE", `/playback/streams/${encodeURIComponent(streamId)}`);
      if (response.status === 204 || response.status === 404) return;
      await fail("stop", response);
    },
  };
};
