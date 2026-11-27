/**
 * PLAT-WEB-04 / PLAT-WEB-05 (runtime part): the web player reaches the runtime
 * from its loopback origin with a grant bound to that origin, and hands a
 * movie's playback to the Badger desktop player, which reports back.
 *
 * @covers GET /runtime/web/status, POST /runtime/handoff/:id/state, POST /runtime/tool/playOnDesktop, POST /runtime/tool/getDesktopPlayback, POST /runtime/access/request, POST /runtime/access/requests/:id/token, apps/runtime/src/core/desktopHandoff.ts, apps/runtime/src/core/toolAccess.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_HANDOFF_CHANNEL,
  DESKTOP_HANDOFF_PLAY_EVENT,
  TOOL_ACCESS_CHANNEL,
  TOOL_ACCESS_ERRORS,
  TOOL_NAME_MAX_LENGTH,
  desktopHandoffPlayPayloadSchema,
  desktopPlaybackStateSchema,
  playOnDesktopResponseSchema,
  runtimeWebStatusSchema,
  toolAccessTokenResponseSchema,
  type DesktopPlaybackState,
} from "@space/tool-access/contracts";
import type { RuntimeEventFrame } from "@space/runtime-contracts";
import { createApp } from "../src/app";
import { desktopHandoff, runtimeState, toolAccess } from "../src/runtime";
import { getBadgerLibraryDbService, onKeySet } from "../src/modules";
import { DESKTOP_HANDOFF_LIMITS } from "../src/core/desktopHandoff";

// Same library stand-in as runtime-tool-access.test.ts: no SQLite needed.
vi.mock("../../../packages/library-db-runtime/src/libraryDb", () => {
  const open = () => ({
    setSyncEnabled: () => undefined,
    getSnapshot: () => ({ media: [], playlists: [] }),
    getVersion: () => 1,
    takeChangedMedia: () => ({ mediaIds: [], all: false }),
    close: () => undefined,
  });
  return { LibraryDb: { openLocal: async () => open(), open: async () => open(), clearLocalCache: async () => undefined } };
});

const SUITE = "runtime-desktop-handoff";
const WEB = "http://localhost:5173";
const OTHER_WEB = "http://127.0.0.1:4173";
const USER = "user-1";

const app = () => createApp();
const json = { "content-type": "application/json" };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app().request(path, { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify(body) });
const fromOrigin = (origin: string | null): Record<string, string> => (origin === null ? {} : { origin });

const say = (test: string, message: string, state?: unknown) =>
  process.stdout.write(`[${SUITE}] [${test}] ${message}${state === undefined ? "" : ` ${JSON.stringify(state)}`}\n`);

const readJson = async (res: Response): Promise<Record<string, unknown>> => {
  const raw: unknown = await res.json();
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
};

/**
 * The desktop main process: a badger app session listening for access prompts
 * and, when `player` is set, for hand-offs on `badger.handoff`.
 */
const connectDesktop = (player = true) => {
  const session = runtimeState.login("backend-token", ["badger"]);
  const frames: RuntimeEventFrame[] = [];
  runtimeState.addSubscriber("desktop", session.token, (frame) => frames.push(frame));
  runtimeState.applyClientFrame("desktop", {
    type: "subscribe",
    apps: ["badger"],
    channels: player ? [TOOL_ACCESS_CHANNEL, DESKTOP_HANDOFF_CHANNEL] : [TOOL_ACCESS_CHANNEL],
  });
  return { token: session.token, frames };
};

const requestAccess = (origin: string | null, toolName = "Badger web player", mode: "read" | "write" = "write") =>
  post("/runtime/access/request", { toolName, mode }, fromOrigin(origin));

/** Request (from `origin`) + approve + collect (from `origin`): a tool token bound to that origin. */
const grantFrom = async (desktopToken: string, origin: string | null, mode: "read" | "write" = "write", toolName = "Badger web player") => {
  const requested = await readJson(await requestAccess(origin, toolName, mode));
  const requestId = String(requested.requestId);
  const decided = await post(`/runtime/access/requests/${requestId}/decide`, { decision: "approve" }, bearer(desktopToken));
  expect(decided.status).toBe(200);
  const collected = await post(`/runtime/access/requests/${requestId}/token`, { pollSecret: requested.pollSecret }, fromOrigin(origin));
  expect(collected.status).toBe(200);
  return toolAccessTokenResponseSchema.parse(await collected.json());
};

const callTool = (token: string, op: string, body: unknown, origin: string | null = WEB) =>
  post(`/runtime/tool/${op}`, body, { ...bearer(token), ...fromOrigin(origin) });

const report = (desktopToken: string, handoffId: string, body: unknown) =>
  post(`/runtime/handoff/${handoffId}/state`, body, bearer(desktopToken));

const playback = async (token: string, handoffId: string): Promise<DesktopPlaybackState> => {
  const res = await callTool(token, "getDesktopPlayback", { handoffId });
  expect(res.status).toBe(200);
  return desktopPlaybackStateSchema.parse(await res.json());
};

const play = async (token: string, mediaId = "m1") => {
  const res = await callTool(token, "playOnDesktop", { mediaId });
  expect(res.status).toBe(200);
  return playOnDesktopResponseSchema.parse(await res.json()).handoffId;
};

const library = getBadgerLibraryDbService();
const openLibrary = () => {
  vi.spyOn(library, "isOpen").mockReturnValue(true);
  vi.spyOn(library, "call").mockImplementation(async (method: string, args: unknown[] = []) => {
    if (method === "getMediaDetails") return args[0] === "m1" || args[0] === "m2" ? { id: args[0], title: "Alien" } : null;
    return undefined;
  });
};

const signIn = () => onKeySet(USER, Buffer.alloc(32, 7).toString("base64"), undefined, "live");
const freshRuntime = () => {
  runtimeState.resetForTests();
  signIn();
};

beforeEach(() => {
  freshRuntime();
  openLibrary();
  // Keep the runtime's own logs out of the reporter, but let the suite's phase markers through.
  for (const level of ["log", "info", "warn", "debug"] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.RUNTIME_ALLOWED_ORIGINS;
});

describe("browser origins on the tool routes", () => {
  it("lets loopback web origins and configured origins ask, refuses null, file:// and the rest @req PLAT-WEB-05", async () => {
    const t = "origin-matrix-request";
    process.env.RUNTIME_ALLOWED_ORIGINS = "https://badger.example";
    const allowed = ["http://localhost:5173", "http://127.0.0.1:8080", "https://localhost", "http://[::1]:3000", "https://badger.example"];
    for (const origin of allowed) {
      freshRuntime();
      connectDesktop();
      const res = await requestAccess(origin);
      const body = await readJson(res);
      say(t, "allowed origin", { origin, status: res.status, error: body.error });
      expect(res.status, origin).toBe(200);
      expect(res.headers.get("access-control-allow-origin"), origin).toBe(origin);
      const pending = toolAccess.snapshot().pending;
      say(t, "pending", pending.map((entry) => entry.toolName));
      expect(pending[0]?.toolName).toBe(`Badger web player (${origin})`);
    }
    for (const origin of ["null", "file://", "https://evil.example", "http://localhost.evil.example", "chrome-extension://abc"]) {
      freshRuntime();
      connectDesktop();
      const res = await requestAccess(origin);
      const body = await readJson(res);
      say(t, "refused origin", { origin, status: res.status, error: body.error });
      expect(res.status, origin).toBe(403);
      expect(body.error, origin).toBe(TOOL_ACCESS_ERRORS.forbiddenOrigin);
      expect(toolAccess.snapshot().pending).toHaveLength(0);
    }
  });

  it("trims the tool name so the origin suffix always fits @req PLAT-WEB-05", async () => {
    connectDesktop();
    const res = await requestAccess(WEB, "x".repeat(TOOL_NAME_MAX_LENGTH));
    expect(res.status).toBe(200);
    const shown = toolAccess.snapshot().pending[0]?.toolName ?? "";
    say("name-trim", "shown", { shown, length: shown.length });
    expect(shown.length).toBeLessThanOrEqual(TOOL_NAME_MAX_LENGTH);
    expect(shown.endsWith(` (${WEB})`)).toBe(true);
    expect(shown.startsWith("xxxx")).toBe(true);
  });

  it("hands the token only to the origin that asked @req PLAT-WEB-05", async () => {
    const t = "origin-bound-token";
    const desktop = connectDesktop();
    const requested = await readJson(await requestAccess(WEB));
    const requestId = String(requested.requestId);
    await post(`/runtime/access/requests/${requestId}/decide`, { decision: "approve" }, bearer(desktop.token));
    for (const origin of [OTHER_WEB, null]) {
      const res = await post(`/runtime/access/requests/${requestId}/token`, { pollSecret: requested.pollSecret }, fromOrigin(origin));
      const body = await readJson(res);
      say(t, "collect from another origin", { origin, status: res.status, error: body.error });
      expect(res.status).toBe(403);
      expect(body.error).toBe(TOOL_ACCESS_ERRORS.forbiddenOrigin);
    }
    const nullOrigin = await post(`/runtime/access/requests/${requestId}/token`, { pollSecret: requested.pollSecret }, { origin: "null" });
    expect(nullOrigin.status).toBe(403);
    const ok = await post(`/runtime/access/requests/${requestId}/token`, { pollSecret: requested.pollSecret }, fromOrigin(WEB));
    say(t, "collect from the same origin", { status: ok.status });
    expect(ok.status).toBe(200);
  });

  it("binds the grant to its origin: any other origin, or none, is refused @req PLAT-WEB-05", async () => {
    const t = "origin-bound-grant";
    const desktop = connectDesktop();
    const web = await grantFrom(desktop.token, WEB);
    const cli = await grantFrom(desktop.token, null, "write", "My CLI");
    const cases: Array<{ token: string; origin: string | null; status: number }> = [
      { token: web.token, origin: WEB, status: 200 },
      { token: web.token, origin: OTHER_WEB, status: 403 },
      { token: web.token, origin: null, status: 403 },
      { token: web.token, origin: "null", status: 403 },
      { token: cli.token, origin: null, status: 200 },
      { token: cli.token, origin: WEB, status: 403 },
    ];
    for (const entry of cases) {
      const res = await callTool(entry.token, "listPlaylists", {}, entry.origin);
      const body = await readJson(res);
      say(t, "tool call", { grant: entry.token === web.token ? "web" : "cli", origin: entry.origin, status: res.status, error: body.error });
      expect(res.status, `${entry.origin}`).toBe(entry.status);
      if (entry.status === 403) expect(body.error).toBe(TOOL_ACCESS_ERRORS.forbiddenOrigin);
    }
    expect(toolAccess.snapshot().grants.map((grant) => grant.toolName).sort()).toEqual(["Badger web player (http://localhost:5173)", "My CLI"]);
  });

  it("answers the CORS preflight of the web player's routes from a loopback origin @req PLAT-WEB-05", async () => {
    const t = "cors-preflight";
    for (const path of ["/runtime/tool/playOnDesktop", "/runtime/access/request", "/runtime/access/requests/ar_x/token", "/runtime/web/status"]) {
      const res = await app().request(path, {
        method: "OPTIONS",
        headers: {
          origin: WEB,
          "access-control-request-method": path.endsWith("status") ? "GET" : "POST",
          "access-control-request-headers": "authorization,content-type",
        },
      });
      const allowHeaders = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
      say(t, "preflight", { path, status: res.status, acao: res.headers.get("access-control-allow-origin"), allowHeaders });
      expect(res.status, path).toBeLessThan(300);
      expect(res.headers.get("access-control-allow-origin"), path).toBe(WEB);
      expect(allowHeaders).toContain("authorization");
      expect(allowHeaders).toContain("content-type");
    }
  });
});

describe("GET /runtime/web/status", () => {
  it("says whether a desktop player listens, with no auth and no caching @req PLAT-WEB-05", async () => {
    const t = "status";
    const read = async () => {
      const res = await app().request("/runtime/web/status", { headers: { origin: WEB } });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("access-control-allow-origin")).toBe(WEB);
      return runtimeWebStatusSchema.parse(await res.json());
    };
    const none = await read();
    say(t, "nobody connected", none);
    expect(none).toEqual({ runtime: "spacefleet", desktopPlayer: false });

    connectDesktop(false);
    const accessOnly = await read();
    say(t, "desktop listening for access prompts only", accessOnly);
    expect(accessOnly.desktopPlayer).toBe(false);

    connectDesktop(true);
    const player = await read();
    say(t, "desktop listening on badger.handoff", player);
    expect(player.desktopPlayer).toBe(true);
  });

  it("does not count a session of another app on badger.handoff @req PLAT-WEB-05", async () => {
    const parrot = runtimeState.login("parrot-backend", ["parrot"]);
    runtimeState.addSubscriber("parrot", parrot.token, () => undefined);
    runtimeState.applyClientFrame("parrot", { type: "subscribe", apps: ["badger"], channels: [DESKTOP_HANDOFF_CHANNEL] });
    const body = runtimeWebStatusSchema.parse(await (await app().request("/runtime/web/status")).json());
    say("status-other-app", "parrot subscribed", body);
    expect(body.desktopPlayer).toBe(false);
  });
});

describe("playOnDesktop", () => {
  it("answers 409 no_desktop_player when no desktop player listens @req PLAT-WEB-04", async () => {
    const desktop = connectDesktop(false);
    const web = await grantFrom(desktop.token, WEB);
    const res = await callTool(web.token, "playOnDesktop", { mediaId: "m1" });
    const body = await readJson(res);
    say("no-desktop", "playOnDesktop", { status: res.status, body });
    expect(res.status).toBe(409);
    expect(body.error).toBe(TOOL_ACCESS_ERRORS.noDesktopPlayer);
  });

  it("answers 404 for a media the library does not have, and publishes nothing @req PLAT-WEB-04", async () => {
    const desktop = connectDesktop();
    const web = await grantFrom(desktop.token, WEB);
    const res = await callTool(web.token, "playOnDesktop", { mediaId: "nope" });
    const body = await readJson(res);
    say("unknown-media", "playOnDesktop", { status: res.status, body });
    expect(res.status).toBe(404);
    expect(body.error).toBe(TOOL_ACCESS_ERRORS.notFound);
    expect(desktop.frames.filter((frame) => frame.channel === DESKTOP_HANDOFF_CHANNEL)).toHaveLength(0);
  });

  it("publishes badger.handoff.play to the desktop, live only, and starts in `requested` @req PLAT-WEB-04", async () => {
    const t = "publish";
    const desktop = connectDesktop();
    const web = await grantFrom(desktop.token, WEB);
    const handoffId = await play(web.token);
    const frames = desktop.frames.filter((frame) => frame.channel === DESKTOP_HANDOFF_CHANNEL);
    say(t, "frames on badger.handoff", frames.map((frame) => ({ event: frame.event, payload: frame.payload })));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.event).toBe(DESKTOP_HANDOFF_PLAY_EVENT);
    const payload = desktopHandoffPlayPayloadSchema.parse(frames[0]!.payload);
    expect(payload.handoffId).toBe(handoffId);
    expect(payload.mediaId).toBe("m1");
    expect(Number.isNaN(Date.parse(payload.requestedAt))).toBe(false);
    // Live only: a reconnecting desktop must not replay a hand-off.
    runtimeState.addSubscriber("late", desktop.token, () => undefined);
    runtimeState.applyClientFrame("late", { type: "subscribe", apps: ["badger"], channels: [DESKTOP_HANDOFF_CHANNEL] });
    const replay = runtimeState.applyClientFrame("late", { type: "ack", lastEventId: "none" });
    say(t, "replay for a late subscriber", replay.length);
    expect(replay.filter((frame) => frame.channel === DESKTOP_HANDOFF_CHANNEL)).toHaveLength(0);

    const state = await playback(web.token, handoffId);
    say(t, "state", state);
    expect(state).toMatchObject({ handoffId, mediaId: "m1", state: "requested", positionSeconds: null, durationSeconds: null, error: null });
  });

  it("supersedes the unfinished hand-off of the same grant @req PLAT-WEB-04", async () => {
    const t = "supersede";
    const desktop = connectDesktop();
    const web = await grantFrom(desktop.token, WEB);
    const first = await play(web.token, "m1");
    expect((await report(desktop.token, first, { state: "playing", positionSeconds: 5 })).status).toBe(200);
    const second = await play(web.token, "m2");
    const old = await playback(web.token, first);
    const current = await playback(web.token, second);
    say(t, "states", { old, current });
    expect(old).toMatchObject({ state: "closed", error: "superseded", positionSeconds: 5 });
    expect(current).toMatchObject({ state: "requested", mediaId: "m2" });
  });

  it("is refused to a read grant, which may still read a hand-off @req PLAT-WEB-04", async () => {
    const desktop = connectDesktop();
    const reader = await grantFrom(desktop.token, WEB, "read");
    const res = await callTool(reader.token, "playOnDesktop", { mediaId: "m1" });
    const body = await readJson(res);
    say("read-grant", "playOnDesktop", { status: res.status, body });
    expect(res.status).toBe(403);
    expect(body.error).toBe(TOOL_ACCESS_ERRORS.writeNotGranted);
    expect(desktop.frames.filter((frame) => frame.channel === DESKTOP_HANDOFF_CHANNEL)).toHaveLength(0);
    expect((await callTool(reader.token, "getDesktopPlayback", { handoffId: "ho_x" })).status).toBe(404);
  });

  it("validates its input strictly @req PLAT-WEB-04", async () => {
    const desktop = connectDesktop();
    const web = await grantFrom(desktop.token, WEB);
    expect((await callTool(web.token, "playOnDesktop", {})).status).toBe(400);
    expect((await callTool(web.token, "playOnDesktop", { mediaId: "m1", path: "/etc" })).status).toBe(400);
    expect((await callTool(web.token, "getDesktopPlayback", {})).status).toBe(400);
  });
});

describe("getDesktopPlayback", () => {
  it("shows a hand-off to the grant that started it only @req PLAT-WEB-04", async () => {
    const t = "ownership";
    const desktop = connectDesktop();
    const owner = await grantFrom(desktop.token, WEB);
    const other = await grantFrom(desktop.token, OTHER_WEB, "write", "Other page");
    const handoffId = await play(owner.token);
    const res = await post("/runtime/tool/getDesktopPlayback", { handoffId }, { ...bearer(other.token), origin: OTHER_WEB });
    say(t, "other grant", { status: res.status });
    expect(res.status).toBe(404);
    expect((await readJson(res)).error).toBe(TOOL_ACCESS_ERRORS.notFound);
    expect((await callTool(owner.token, "getDesktopPlayback", { handoffId: "ho_unknown" })).status).toBe(404);
    expect((await playback(owner.token, handoffId)).state).toBe("requested");
  });
});

describe("POST /runtime/handoff/:id/state", () => {
  it("walks requested → starting → playing → closed, then ignores late reports @req PLAT-WEB-04", async () => {
    const t = "transitions";
    const desktop = connectDesktop();
    const web = await grantFrom(desktop.token, WEB);
    const handoffId = await play(web.token);
    const steps: Array<{ body: Record<string, unknown>; expected: Partial<DesktopPlaybackState> }> = [
      { body: { state: "starting" }, expected: { state: "starting", positionSeconds: null } },
      { body: { state: "playing", positionSeconds: 12, durationSeconds: 7000 }, expected: { state: "playing", positionSeconds: 12, durationSeconds: 7000 } },
      { body: { state: "playing", positionSeconds: 13.5 }, expected: { state: "playing", positionSeconds: 13.5, durationSeconds: 7000 } },
      { body: { state: "closed", positionSeconds: 60 }, expected: { state: "closed", positionSeconds: 60, error: null } },
    ];
    for (const step of steps) {
      const res = await report(desktop.token, handoffId, step.body);
      const answer = await readJson(res);
      const state = await playback(web.token, handoffId);
      say(t, "report", { sent: step.body, status: res.status, answer, state });
      expect(res.status).toBe(200);
      expect(answer).toEqual({ ok: true });
      expect(state).toMatchObject(step.expected);
    }
    const late = await report(desktop.token, handoffId, { state: "playing", positionSeconds: 99 });
    const lateAnswer = await readJson(late);
    const after = await playback(web.token, handoffId);
    say(t, "late report", { status: late.status, lateAnswer, after });
    expect(late.status).toBe(200);
    expect(lateAnswer).toEqual({ ok: true, ignored: true });
    expect(after).toMatchObject({ state: "closed", positionSeconds: 60 });
  });

  it("records a failure with its error @req PLAT-WEB-04", async () => {
    const desktop = connectDesktop();
    const web = await grantFrom(desktop.token, WEB);
    const handoffId = await play(web.token);
    expect((await report(desktop.token, handoffId, { state: "failed", error: "not_signed_in" })).status).toBe(200);
    const state = await playback(web.token, handoffId);
    say("failure", "state", state);
    expect(state).toMatchObject({ state: "failed", error: "not_signed_in" });
  });

  it("is for the desktop app only, answers 404 for an unknown id and 400 for a bad body @req PLAT-WEB-04", async () => {
    const t = "report-gate";
    const desktop = connectDesktop();
    const web = await grantFrom(desktop.token, WEB);
    const handoffId = await play(web.token);
    const noAuth = await post(`/runtime/handoff/${handoffId}/state`, { state: "starting" });
    const asTool = await post(`/runtime/handoff/${handoffId}/state`, { state: "starting" }, { ...bearer(web.token), origin: WEB });
    const parrot = runtimeState.login("parrot-backend", ["parrot"]);
    const asParrot = await report(parrot.token, handoffId, { state: "starting" });
    const unknown = await report(desktop.token, "ho_unknown", { state: "starting" });
    const bad = await report(desktop.token, handoffId, { state: "requested" });
    const extra = await report(desktop.token, handoffId, { state: "starting", mediaId: "m2" });
    say(t, "statuses", { noAuth: noAuth.status, asTool: asTool.status, asParrot: asParrot.status, unknown: unknown.status, bad: bad.status, extra: extra.status });
    expect(noAuth.status).toBe(401);
    expect(asTool.status).toBe(403);
    expect(asParrot.status).toBe(403);
    expect(unknown.status).toBe(404);
    expect(bad.status).toBe(400);
    expect(extra.status).toBe(400);
    expect((await playback(web.token, handoffId)).state).toBe("requested");
  });
});

describe("timeouts and endings", () => {
  it("fails a hand-off the desktop did not acknowledge within 20 s with desktop_unresponsive @req PLAT-WEB-04", async () => {
    const t = "ack-timeout";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const desktop = connectDesktop();
    const web = await grantFrom(desktop.token, WEB);
    const unanswered = await play(web.token, "m1");
    vi.advanceTimersByTime(DESKTOP_HANDOFF_LIMITS.ackTimeoutMs - 1);
    const before = await playback(web.token, unanswered);
    say(t, "just before the deadline", before);
    expect(before.state).toBe("requested");
    vi.advanceTimersByTime(1);
    const after = await playback(web.token, unanswered);
    say(t, "at the deadline", after);
    expect(after).toMatchObject({ state: "failed", error: "desktop_unresponsive" });

    // An acknowledged hand-off never times out.
    const answered = await play(web.token, "m2");
    vi.advanceTimersByTime(5_000);
    expect((await report(desktop.token, answered, { state: "starting" })).status).toBe(200);
    vi.advanceTimersByTime(DESKTOP_HANDOFF_LIMITS.ackTimeoutMs * 2);
    const acknowledged = await playback(web.token, answered);
    say(t, "acknowledged hand-off after 45 s", acknowledged);
    expect(acknowledged.state).toBe("starting");
  });

  it("forgets a finished hand-off ten minutes after its end @req PLAT-WEB-04", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const desktop = connectDesktop();
    const web = await grantFrom(desktop.token, WEB);
    const handoffId = await play(web.token);
    await report(desktop.token, handoffId, { state: "closed", positionSeconds: 1 });
    vi.advanceTimersByTime(DESKTOP_HANDOFF_LIMITS.finishedRetentionMs - 1_000);
    // Keep the grant's idle window alive with a call before reading again.
    expect((await playback(web.token, handoffId)).state).toBe("closed");
    vi.advanceTimersByTime(1_000);
    const gone = await callTool(web.token, "getDesktopPlayback", { handoffId });
    say("retention", "after ten minutes", { status: gone.status });
    expect(gone.status).toBe(404);
  });

  it("closes the unfinished hand-offs of a revoked grant with error revoked @req PLAT-WEB-04", async () => {
    const t = "revoke";
    const desktop = connectDesktop();
    const web = await grantFrom(desktop.token, WEB);
    const handoffId = await play(web.token);
    expect((await report(desktop.token, handoffId, { state: "playing", positionSeconds: 30 })).status).toBe(200);
    const revoked = await app().request(`/runtime/access/grants/${web.grantId}`, { method: "DELETE", headers: bearer(desktop.token) });
    expect(revoked.status).toBe(200);
    const state = desktopHandoff.get(web.grantId, handoffId);
    say(t, "state after revoke", state);
    expect(state).toMatchObject({ state: "closed", error: "revoked", positionSeconds: 30 });
    expect((await callTool(web.token, "getDesktopPlayback", { handoffId })).status).toBe(401);
    const late = await readJson(await report(desktop.token, handoffId, { state: "playing", positionSeconds: 31 }));
    say(t, "late report after revoke", late);
    expect(late).toEqual({ ok: true, ignored: true });
  });

  it("closes them too when every grant ends at sign-out @req PLAT-WEB-04", async () => {
    const desktop = connectDesktop();
    const web = await grantFrom(desktop.token, WEB);
    const handoffId = await play(web.token);
    expect((await app().request("/runtime/access/grants", { method: "DELETE", headers: bearer(desktop.token) })).status).toBe(200);
    const state = desktopHandoff.get(web.grantId, handoffId);
    say("revoke-all", "state", state);
    expect(state).toMatchObject({ state: "closed", error: "revoked" });
  });
});
