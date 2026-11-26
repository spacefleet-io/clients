/**
 * DEV-LIB-01 (runtime part): a third-party tool reaches the library only
 * through the local runtime, only after the user approved it in an app, and
 * only for the allowlisted operations.
 *
 * @covers POST /runtime/access/request, POST /runtime/access/requests/:id/token, POST /runtime/access/requests/:id/decide, GET /runtime/access/grants, DELETE /runtime/access/grants/:id, POST /runtime/tool/:op, apps/runtime/src/core/toolAccess.ts, apps/runtime/src/core/toolOperations.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TOOL_ACCESS_CHANNEL,
  TOOL_ACCESS_ERRORS,
  TOOL_HANDOFF_OPERATIONS,
  TOOL_OPERATIONS,
  TOOL_READ_OPERATIONS,
  TOOL_WRITE_OPERATIONS,
  toolAccessGrantsResponseSchema,
  toolAccessSnapshotSchema,
  toolAccessTokenResponseSchema,
} from "@space/tool-access/contracts";
import { RUNTIME_OWNER_HEADER } from "@space/runtime-contracts/lifecycle";
import type { RuntimeEventFrame } from "@space/runtime-contracts";
import { createApp } from "../src/app";
import { createRuntimeServerDefinition } from "../src/index";
import { runtimeState, toolAccess } from "../src/runtime";
import { getBadgerLibraryDbService, onKeySet } from "../src/modules";
import { BadgerModule } from "../src/modules/badger";
import { TOOL_ACCESS_LIMITS } from "../src/core/toolAccess";

// A library that can be opened and closed without SQLite, for the "closing the library ends the grants" case.
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

const SUITE = "runtime-tool-access";
const APP_TOKEN_BACKEND = "backend-token-SECRET-do-not-leak";
const LIBRARY_KEY = "library-key-SECRET-do-not-leak";

const app = () => createApp();
const json = { "content-type": "application/json" };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app().request(path, { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify(body) });

/** A first-party app session (badger) listening to the access channel, like the desktop main process. */
const connectApp = () => {
  const session = runtimeState.login(APP_TOKEN_BACKEND, ["badger"]);
  const frames: RuntimeEventFrame[] = [];
  runtimeState.addSubscriber("app-1", session.token, (frame) => frames.push(frame));
  runtimeState.applyClientFrame("app-1", { type: "subscribe", apps: ["badger"], channels: [TOOL_ACCESS_CHANNEL] });
  return { token: session.token, frames };
};

/** The string fields of a JSON body (error bodies, request answers): a read that needs no cast. */
const stringFields = async (res: Response): Promise<Record<string, string>> => {
  const raw: unknown = await res.json();
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw)) if (typeof value === "string") out[key] = value;
  }
  return out;
};

const requestAccess = async (toolName = "My CLI", mode: "read" | "write" = "read", extra: Record<string, unknown> = {}) => {
  const res = await post("/runtime/access/request", { toolName, mode, ...extra });
  return { res, body: await stringFields(res) };
};

const decide = (appToken: string, requestId: string, body: unknown) =>
  post(`/runtime/access/requests/${requestId}/decide`, body, bearer(appToken));

const collect = (requestId: string, pollSecret: string, headers: Record<string, string> = {}) =>
  post(`/runtime/access/requests/${requestId}/token`, { pollSecret }, headers);

/** Request + approve + collect: a tool token. */
const grantTool = async (appToken: string, mode: "read" | "write" = "read", toolName = "My CLI") => {
  const { body } = await requestAccess(toolName, mode);
  const decision = await decide(appToken, body.requestId!, { decision: "approve" });
  expect(decision.status).toBe(200);
  const res = await collect(body.requestId!, body.pollSecret!);
  expect(res.status).toBe(200);
  return toolAccessTokenResponseSchema.parse(await res.json());
};

/** PLAT-WEB-04 operations: answered by the hand-off manager, covered in runtime-desktop-handoff.test.ts. */
const isHandoffOp = (op: string) => (TOOL_HANDOFF_OPERATIONS as readonly string[]).includes(op);

const callTool = (token: string, op: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  post(`/runtime/tool/${op}`, body, { ...bearer(token), ...headers });

const library = getBadgerLibraryDbService();
const MEDIA = {
  id: "m1",
  type: "movie",
  title: "Alien",
  overview: null,
  year: "1979",
  rating: 8.4,
  genres: [27],
  hasFiles: true,
  progressPct: 0,
};
const DETAILS = {
  ...MEDIA,
  cast: [{ id: "c1", personId: "p1", catalogId: 1, name: "Sigourney", role: "Ripley", profilePath: null }],
  playlistIds: [],
  seasons: [],
  episodes: [{ id: "e1", seasonNumber: 1, episodeNumber: 1, name: "Pilot", overview: null, airDate: null }],
  files: [{ id: "f1", filename: "alien.mkv", season: null, episode: null, desiredFormats: [] }],
  formats: [
    {
      id: "fm1",
      mediaId: "m1",
      fileId: "f1",
      quality: "1080p",
      codec: "h264",
      bitrateKbps: 4000,
      sizeMb: 100,
      initKey: "secret/object/init.mp4",
      initSize: 10,
      durationSeconds: 7000,
      totalSize: 1,
      chunks: [{ key: "secret/object/chunk-0.m4s", sizeBytes: 1, startSeconds: 0 }],
      isSource: true,
    },
  ],
  audioTracks: [],
  subtitleTracks: [],
  hasLocalFiles: false,
};

let libraryCalls: Array<{ method: string; args: unknown[] }>;
const openLibrary = () => {
  libraryCalls = [];
  vi.spyOn(library, "isOpen").mockReturnValue(true);
  vi.spyOn(library, "call").mockImplementation(async (method: string, args: unknown[] = []) => {
    libraryCalls.push({ method, args });
    switch (method) {
      case "listMedia":
        return [MEDIA];
      case "getMediaDetails":
        return args[0] === "m1" ? DETAILS : null;
      case "listPlaylists":
        return [{ id: "pl1", name: "Favourites", slug: null, isSystem: false, createdAt: "2026-01-01" }];
      case "listPlaylistItems":
        return ["m1"];
      case "listLocalDownloads":
        return [];
      default:
        return undefined;
    }
  });
};

const USER = "user-1";
const signIn = (userId: string) => onKeySet(userId, Buffer.alloc(32, 7).toString("base64"), undefined, "live");

let logged: string[];
beforeEach(() => {
  runtimeState.resetForTests();
  // The desktop signed user-1 in: a grant binds to the user whose library is open when it is approved.
  signIn(USER);
  logged = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const say = (message: string) => process.stdout.write(`[${SUITE}] ${message}\n`);

describe("asking for access", () => {
  it("answers 409 no_app_connected when no app is there to ask the user @req DEV-LIB-01[runtime]", async () => {
    say("request without any app subscribed");
    const { res, body } = await requestAccess();
    expect(res.status).toBe(409);
    expect(body.error).toBe(TOOL_ACCESS_ERRORS.noAppConnected);
    expect(body.message).toMatch(/open spacefleet/i);
  });

  it("publishes the pending request, with its verification code, to the connected app only @req DEV-LIB-01[runtime]", async () => {
    const appSide = connectApp();
    const { res, body } = await requestAccess("  My\u202E CLI\n", "read", { reason: "sync my watch history" });
    expect(res.status).toBe(200);
    expect(body.pollSecret!.length).toBeGreaterThanOrEqual(43); // 256 bits, base64url
    expect(body.verificationCode).toMatch(/^\d{6}$/);
    const frame = appSide.frames.find((entry) => entry.channel === TOOL_ACCESS_CHANNEL);
    const snapshot = toolAccessSnapshotSchema.parse(frame?.payload);
    expect(snapshot.pending).toHaveLength(1);
    expect(snapshot.pending[0]).toMatchObject({
      requestId: body.requestId,
      toolName: "My CLI",
      reason: "sync my watch history",
      mode: "read",
      verificationCode: body.verificationCode,
    });
    // The poll secret never reaches the apps.
    expect(JSON.stringify(appSide.frames)).not.toContain(body.pollSecret);
  });

  it("does not hand the prompt to a tool session or to an unsubscribed app @req DEV-LIB-01[runtime]", async () => {
    const appSession = runtimeState.login("tok", ["badger"]);
    runtimeState.addSubscriber("quiet", appSession.token, () => undefined); // never subscribed to the channel
    expect((await requestAccess()).res.status).toBe(409);
  });

  it("refuses a request whose Origin is not an allowed web origin, even null @req DEV-LIB-01[runtime]", async () => {
    connectApp();
    // Loopback web origins are allowed since PLAT-WEB-05 (runtime-desktop-handoff.test.ts).
    for (const origin of ["null", "https://evil.example", "file://"]) {
      const res = await post("/runtime/access/request", { toolName: "x", mode: "read" }, { origin });
      expect(res.status, origin).toBe(403);
      expect((await stringFields(res)).error, origin).toBe("forbidden_origin");
    }
    expect(toolAccess.snapshot().pending).toHaveLength(0);
  });

  it("refuses a wrong Host @req DEV-LIB-01[runtime]", async () => {
    connectApp();
    const res = await post("/runtime/access/request", { toolName: "x", mode: "read" }, { host: "evil.example" });
    expect(res.status).toBe(403);
  });

  it("refuses oversized and malformed bodies @req DEV-LIB-01[runtime]", async () => {
    connectApp();
    const big = await post("/runtime/access/request", { toolName: "x", mode: "read", reason: "r".repeat(5000) });
    expect(big.status).toBe(413);
    expect((await post("/runtime/access/request", { toolName: "x" })).status).toBe(400);
    expect((await post("/runtime/access/request", { toolName: "x", mode: "admin" })).status).toBe(400);
    expect((await post("/runtime/access/request", { toolName: "x", mode: "read", extra: 1 })).status).toBe(400);
    expect((await post("/runtime/access/request", { toolName: "a".repeat(65), mode: "read" })).status).toBe(400);
    const notJson = await app().request("/runtime/access/request", { method: "POST", headers: json, body: "{nope" });
    expect(notJson.status).toBe(400);
    expect((await post("/runtime/access/request", { toolName: "\u200B\u202E", mode: "read" })).status).toBe(400);
  });

  it("allows one open request per tool name and three in all @req DEV-LIB-01[runtime]", async () => {
    connectApp();
    expect((await requestAccess("alpha")).res.status).toBe(200);
    const duplicate = await requestAccess("ALPHA");
    expect(duplicate.res.status).toBe(409);
    expect(duplicate.body.error).toBe(TOOL_ACCESS_ERRORS.alreadyPending);
    expect((await requestAccess("beta")).res.status).toBe(200);
    expect((await requestAccess("gamma")).res.status).toBe(200);
    const fourth = await requestAccess("delta");
    expect(fourth.res.status).toBe(429);
    expect(fourth.body.error).toBe(TOOL_ACCESS_ERRORS.tooManyPending);
  });

  it("rate-limits requests whoever sends them @req DEV-LIB-01[runtime]", async () => {
    const appSide = connectApp();
    for (let i = 0; i < TOOL_ACCESS_LIMITS.rateLimitMax; i += 1) {
      const { res, body } = await requestAccess(`tool-${i}`);
      if (res.status === 200) {
        // Settle it again so the pending cap is not what answers (a denial would start a cooldown instead).
        await decide(appSide.token, body.requestId!, { decision: "approve" });
      }
    }
    const limited = await requestAccess("one-too-many");
    expect(limited.res.status).toBe(429);
    expect(limited.body.error).toBe(TOOL_ACCESS_ERRORS.rateLimited);
    expect(limited.res.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("makes a denied tool name wait five minutes, and every tool half a minute @req DEV-LIB-01[runtime]", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const appSide = connectApp();
    const first = await requestAccess("Spammer");
    expect((await decide(appSide.token, first.body.requestId!, { decision: "deny" })).status).toBe(200);

    // Right after the denial: the same name (any case) and any other name both wait.
    const sameName = await requestAccess("SPAMMER");
    expect(sameName.res.status).toBe(429);
    expect(sameName.body.error).toBe(TOOL_ACCESS_ERRORS.rateLimited);
    expect(Number(sameName.res.headers.get("retry-after"))).toBeGreaterThan(TOOL_ACCESS_LIMITS.deniedGlobalCooldownMs / 1000);
    const otherName = await requestAccess("Friendly");
    expect(otherName.res.status).toBe(429);
    expect(Number(otherName.res.headers.get("retry-after"))).toBeLessThanOrEqual(TOOL_ACCESS_LIMITS.deniedGlobalCooldownMs / 1000);

    // After the global half minute another tool may ask; the denied name still may not.
    vi.setSystemTime(Date.now() + TOOL_ACCESS_LIMITS.deniedGlobalCooldownMs + 1000);
    expect((await requestAccess("Friendly")).res.status).toBe(200);
    expect((await requestAccess("Spammer")).res.status).toBe(429);

    // After the full five minutes the denied name may ask again.
    vi.setSystemTime(Date.now() + TOOL_ACCESS_LIMITS.deniedNameCooldownMs);
    expect((await requestAccess("Spammer")).res.status).toBe(200);
  });
});

describe("approval is the only way in", () => {
  it("gives no token while the request is pending, and none to a wrong poll secret @req DEV-LIB-01[runtime]", async () => {
    connectApp();
    const { body } = await requestAccess();
    const pending = await collect(body.requestId!, body.pollSecret!);
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ status: "pending" });
    const wrong = await collect(body.requestId!, "x".repeat(43));
    expect(wrong.status).toBe(401);
    expect((await stringFields(wrong)).error).toBe(TOOL_ACCESS_ERRORS.invalidPollSecret);
    expect((await collect("ar_unknown", body.pollSecret!)).status).toBe(404);
    // Without approval the tool routes stay shut for any bearer.
    expect((await callTool("rt_made-up", "listMedia")).status).toBe(401);
  });

  it("drops a request after five wrong poll secrets @req DEV-LIB-01[runtime]", async () => {
    connectApp();
    const { body } = await requestAccess();
    for (let i = 0; i < TOOL_ACCESS_LIMITS.maxPollFailures; i += 1) await collect(body.requestId!, "guess");
    expect((await collect(body.requestId!, body.pollSecret!)).status).toBe(404);
  });

  it("answers 403 denied after a deny and never issues a token @req DEV-LIB-01[runtime]", async () => {
    const appSide = connectApp();
    const { body } = await requestAccess();
    expect((await decide(appSide.token, body.requestId!, { decision: "deny" })).status).toBe(200);
    const res = await collect(body.requestId!, body.pollSecret!);
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(JSON.parse(text).error).toBe(TOOL_ACCESS_ERRORS.denied);
    expect(text).not.toContain("token\":");
    expect(toolAccess.snapshot().grants).toHaveLength(0);
  });

  it("answers 410 expired when nobody decided within two minutes @req DEV-LIB-01[runtime]", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const appSide = connectApp();
    const { body } = await requestAccess();
    vi.setSystemTime(Date.now() + TOOL_ACCESS_LIMITS.requestTtlMs + 1000);
    const res = await collect(body.requestId!, body.pollSecret!);
    expect(res.status).toBe(410);
    expect((await stringFields(res)).error).toBe(TOOL_ACCESS_ERRORS.expired);
    expect((await decide(appSide.token, body.requestId!, { decision: "approve" })).status).toBeGreaterThanOrEqual(404);
    expect(toolAccess.snapshot().pending).toHaveLength(0);
  });

  it("hands the token out once: a second collect gets 410 @req DEV-LIB-01[runtime]", async () => {
    const appSide = connectApp();
    const { body } = await requestAccess();
    await decide(appSide.token, body.requestId!, { decision: "approve" });
    expect((await collect(body.requestId!, body.pollSecret!)).status).toBe(200);
    const again = await collect(body.requestId!, body.pollSecret!);
    expect(again.status).toBe(410);
    expect((await stringFields(again)).error).toBe(TOOL_ACCESS_ERRORS.claimed);
  });

  it("lets the user approve with less than was asked, never more @req DEV-LIB-01[runtime]", async () => {
    const appSide = connectApp();
    const asked = await requestAccess("writer", "write");
    await decide(appSide.token, asked.body.requestId!, { decision: "approve", mode: "read" });
    const granted = toolAccessTokenResponseSchema.parse(await (await collect(asked.body.requestId!, asked.body.pollSecret!)).json());
    expect(granted.mode).toBe("read");
    expect(granted.allowedOps).toEqual([...TOOL_READ_OPERATIONS]);

    const readOnly = await requestAccess("reader", "read");
    const upgrade = await decide(appSide.token, readOnly.body.requestId!, { decision: "approve", mode: "write" });
    expect(upgrade.status).toBe(400);
  });

  it("makes the token a memory-only tool session with a bounded life @req DEV-LIB-01[runtime]", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const appSide = connectApp();
    const granted = await grantTool(appSide.token);
    const ttl = Date.parse(granted.expiresAt) - Date.now();
    expect(ttl).toBeLessThanOrEqual(TOOL_ACCESS_LIMITS.sessionTtlMs);
    expect(ttl).toBeGreaterThan(TOOL_ACCESS_LIMITS.sessionTtlMs - 5000);
    expect(granted.allowedOps).toEqual([...TOOL_READ_OPERATIONS]);
  });
});

describe("what an approved tool can do", () => {
  it("runs every allowlisted read against the library @req DEV-LIB-01[runtime]", async () => {
    openLibrary();
    const appSide = connectApp();
    const { token } = await grantTool(appSide.token);
    const inputs: Record<string, unknown> = {
      listMedia: { type: "movie" },
      getMediaDetails: { mediaId: "m1" },
      listPlaylists: {},
      listPlaylistItems: { playlistId: "pl1" },
      listLocalDownloads: {},
    };
    // The hand-off operations answer from the hand-off manager (runtime-desktop-handoff.test.ts).
    for (const op of TOOL_READ_OPERATIONS.filter((entry) => !isHandoffOp(entry))) {
      const res = await callTool(token, op, inputs[op]);
      expect(res.status, op).toBe(200);
    }
    expect(await (await callTool(token, "listMedia")).json()).toMatchObject({ items: [{ title: "Alien" }], total: 1 });
    expect((await callTool(token, "getMediaDetails", { mediaId: "nope" })).status).toBe(404);
  });

  it("answers getMediaDetails without storage keys, chunks or init keys @req DEV-LIB-01[runtime]", async () => {
    openLibrary();
    const appSide = connectApp();
    const { token } = await grantTool(appSide.token);
    const text = await (await callTool(token, "getMediaDetails", { mediaId: "m1" })).text();
    expect(text).toContain("Alien");
    expect(text).not.toMatch(/secret\/object|initKey|chunks|objectKey/);
  });

  it("lets a read grant read but not write, and a write grant do both @req DEV-LIB-01[runtime]", async () => {
    openLibrary();
    const appSide = connectApp();
    const reader = await grantTool(appSide.token, "read", "reader");
    const writes: Record<string, unknown> = {
      setProgress: { mediaId: "m1", progressPct: 50 },
      updateMediaMetadata: { mediaId: "m1", media: { title: "Aliens" } },
      createPlaylist: { name: "Horror" },
      addToPlaylist: { playlistId: "pl1", mediaId: "m1" },
      removeFromPlaylist: { playlistId: "pl1", mediaId: "m1" },
    };
    for (const op of TOOL_WRITE_OPERATIONS) {
      const refused = await callTool(reader.token, op, writes[op]);
      expect(refused.status, op).toBe(403);
      expect((await stringFields(refused)).error).toBe(TOOL_ACCESS_ERRORS.writeNotGranted);
    }
    expect(libraryCalls.filter((entry) => !entry.method.startsWith("list") && entry.method !== "getMediaDetails")).toEqual([]);

    const writer = await grantTool(appSide.token, "write", "writer");
    expect(writer.allowedOps).toEqual([...TOOL_OPERATIONS]);
    for (const op of TOOL_WRITE_OPERATIONS.filter((entry) => !isHandoffOp(entry))) {
      const res = await callTool(writer.token, op, writes[op]);
      expect(res.status, op).toBe(200);
    }
    expect(libraryCalls.map((entry) => entry.method)).toEqual(
      expect.arrayContaining(TOOL_WRITE_OPERATIONS.filter((entry) => !isHandoffOp(entry)))
    );
  });

  it("validates input strictly @req DEV-LIB-01[runtime]", async () => {
    openLibrary();
    const appSide = connectApp();
    const { token } = await grantTool(appSide.token, "write");
    expect((await callTool(token, "setProgress", { mediaId: "m1", progressPct: 500 })).status).toBe(400);
    expect((await callTool(token, "getMediaDetails", { mediaId: "m1", sql: "drop" })).status).toBe(400);
    expect((await callTool(token, "createPlaylist", { name: "" })).status).toBe(400);
    const notJson = await app().request("/runtime/tool/listMedia", { method: "POST", headers: { ...json, ...bearer(token) }, body: "{" });
    expect(notJson.status).toBe(400);
  });

  it("answers 423 library_locked while no library key is loaded @req DEV-LIB-01[runtime]", async () => {
    vi.spyOn(library, "isOpen").mockReturnValue(false);
    const callSpy = vi.spyOn(library, "call");
    const appSide = connectApp();
    const { token } = await grantTool(appSide.token, "write");
    for (const op of TOOL_OPERATIONS) {
      const res = await callTool(token, op, {});
      expect(res.status, op).toBe(423);
      expect((await stringFields(res)).error).toBe(TOOL_ACCESS_ERRORS.libraryLocked);
    }
    expect(callSpy).not.toHaveBeenCalled();
  });

  it("turns a library failure into a generic 500 that leaks nothing @req DEV-LIB-01[runtime]", async () => {
    vi.spyOn(library, "isOpen").mockReturnValue(true);
    vi.spyOn(library, "call").mockRejectedValue(new Error(`boom ${LIBRARY_KEY} /home/user/secret.db`));
    const appSide = connectApp();
    const { token } = await grantTool(appSide.token);
    const res = await callTool(token, "listMedia");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain(LIBRARY_KEY);
    expect(text).not.toContain("secret.db");
    expect(JSON.parse(text).error).toBe(TOOL_ACCESS_ERRORS.operationFailed);
  });

  it("checks the episode before it saves progress for it @req DEV-LIB-01[runtime]", async () => {
    openLibrary();
    const appSide = connectApp();
    const { token } = await grantTool(appSide.token, "write");
    const unknown = await callTool(token, "setProgress", { mediaId: "m1", progressPct: 40, episodeId: "e-nope" });
    expect(unknown.status).toBe(404);
    expect((await stringFields(unknown)).error).toBe(TOOL_ACCESS_ERRORS.notFound);
    expect(libraryCalls.some((entry) => entry.method === "setProgress")).toBe(false);

    expect((await callTool(token, "setProgress", { mediaId: "m1", progressPct: 40, episodeId: "e1" })).status).toBe(200);
    expect(libraryCalls.find((entry) => entry.method === "setProgress")?.args).toEqual(["m1", 40, "e1", null]);
    // Without an episode id (or with null) the media's own progress is saved.
    expect((await callTool(token, "setProgress", { mediaId: "m1", progressPct: 10, episodeId: null })).status).toBe(200);
  });
});

describe("default deny", () => {
  it("refuses every route outside the allowlist to a tool session with 403 @req DEV-LIB-01[runtime]", async () => {
    openLibrary();
    const appSide = connectApp();
    const { token } = await grantTool(appSide.token, "write");
    const refused: Array<[string, string, unknown]> = [
      // Operations that must never exist for a tool.
      ["POST", "/runtime/tool/deleteMedia", { mediaId: "m1" }],
      ["POST", "/runtime/tool/deletePlaylist", { playlistId: "pl1" }],
      ["POST", "/runtime/tool/setSetting", { key: "k", value: "v" }],
      ["POST", "/runtime/tool/getLibraryKey", {}],
      ["POST", "/runtime/tool/db.call", { method: "deleteMedia", args: ["m1"] }],
      ["POST", "/runtime/tool/__proto__", {}],
      // The runtime surface: raw db call, keys, sync, storage, ingest, session, access, admin.
      ["POST", "/modules/badger/commands", { module: "badger", command: "badger.db.call", payload: { method: "deleteMedia", args: ["m1"] } }],
      ["POST", "/runtime/connect", { app: "badger", libraryKey: "k" }],
      ["POST", "/runtime/session/login", { backendToken: "tok", apps: ["badger"] }],
      ["POST", "/runtime/session/refresh", {}],
      ["POST", "/runtime/session/logout", {}],
      ["POST", `/runtime/access/requests/ar_x/decide`, { decision: "approve" }],
      ["GET", "/runtime/access/grants", undefined],
      ["GET", "/runtime/access/snapshot", undefined],
      ["DELETE", "/runtime/access/grants/gr_x", undefined],
      ["GET", "/runtime/jobs", undefined],
      ["GET", "/runtime/health", undefined],
      ["GET", "/runtime/events/jobs/v2/stream", undefined],
      ["DELETE", "/runtime/access/grants", undefined],
    ];
    for (const [method, path, body] of refused) {
      const res = await app().request(path, {
        method,
        headers: { ...json, ...bearer(token) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(text, `${method} ${path}`).toMatch(/tool_not_allowed/);
    }
    expect(libraryCalls.filter((entry) => entry.method.startsWith("delete") || entry.method === "setSetting")).toEqual([]);
  });

  // RT-SEC-02: a token the runtime does not know is a 401, whatever the operation; the op allowlist answers only a known bearer.
  it("@bugfix @regression-proof answers 401, not 403, to a junk or logged-out token on any operation @req RT-SEC-02[runtime]", async () => {
    const appSide = connectApp();
    const { token } = await grantTool(appSide.token);
    runtimeState.logout(token);
    for (const bearerToken of ["rt_not_a_session", token]) {
      for (const op of ["probe", "deleteMedia", TOOL_READ_OPERATIONS[0]]) {
        const res = await callTool(bearerToken, op);
        expect(res.status, `${op} with ${bearerToken === token ? "logged-out" : "junk"} token`).toBe(401);
        expect(await res.text()).toContain(TOOL_ACCESS_ERRORS.unauthorized);
      }
    }
  });

  it("is not a way to log in, or to get another session or the owner secret @req DEV-LIB-01[runtime]", async () => {
    const appSide = connectApp();
    const { token } = await grantTool(appSide.token);
    const login = await post("/runtime/session/login", { backendToken: "tok", apps: ["badger"] }, bearer(token));
    expect(login.status).toBe(403);
    const withOwnerHeader = await post(
      "/runtime/session/login",
      { backendToken: "tok", apps: ["badger"] },
      { [RUNTIME_OWNER_HEADER]: "not-the-secret" }
    );
    expect(withOwnerHeader.status).toBe(401);
    expect(runtimeState.requireSession(token)?.kind).toBe("tool");
    expect(runtimeState.requireSession(token)?.scopes.size).toBe(0);
  });

  it("does not let a tool decide its own request or anyone's @req DEV-LIB-01[runtime]", async () => {
    const appSide = connectApp();
    const first = await grantTool(appSide.token, "read", "first");
    const { body } = await requestAccess("second", "write");
    const res = await decide(first.token, body.requestId!, { decision: "approve" });
    expect(res.status).toBe(403);
    expect((await collect(body.requestId!, body.pollSecret!)).status).toBe(202);
    expect((await app().request("/runtime/access/grants", { headers: bearer(first.token) })).status).toBe(403);
    expect(
      (await app().request(`/runtime/access/grants/${first.grantId}`, { method: "DELETE", headers: bearer(first.token) })).status
    ).toBe(403);
    expect(toolAccess.snapshot().grants).toHaveLength(1);
  });

  it("refuses decide, snapshot and revoke without a session, or from a session of another app @req DEV-LIB-01[runtime]", async () => {
    connectApp();
    const { body } = await requestAccess();
    expect((await post(`/runtime/access/requests/${body.requestId}/decide`, { decision: "approve" })).status).toBe(401);
    expect((await app().request("/runtime/access/snapshot")).status).toBe(401);
    const parrot = runtimeState.login("tok", ["parrot"]);
    expect((await decide(parrot.token, body.requestId!, { decision: "approve" })).status).toBe(403);
    expect(toolAccess.snapshot().grants).toHaveLength(0);
  });

  it("refuses the tool routes when the request carries an Origin header @req DEV-LIB-01[runtime]", async () => {
    openLibrary();
    const appSide = connectApp();
    const { token } = await grantTool(appSide.token);
    for (const origin of ["null", "https://evil.example"]) {
      const res = await callTool(token, "listMedia", {}, { origin });
      expect(res.status, origin).toBe(403);
    }
    const { body } = await requestAccess("someone");
    expect((await collect(body.requestId!, body.pollSecret!, { origin: "null" })).status).toBe(403);
  });

  it("refuses an app session on the tool routes @req DEV-LIB-01[runtime]", async () => {
    openLibrary();
    const appSide = connectApp();
    const res = await callTool(appSide.token, "listMedia");
    expect(res.status).toBe(403);
  });

  it("keeps a tool session out of the WebSocket and SSE streams, whether the token comes in the header or the query @req DEV-LIB-01[runtime]", async () => {
    const appSide = connectApp();
    const { token } = await grantTool(appSide.token);
    // The streams are served by the Bun entry point, ahead of the Hono app: go through it.
    const { fetch } = createRuntimeServerDefinition();
    const upgrades: unknown[] = [];
    const server = {
      upgrade: (_request: Request, options?: unknown) => {
        upgrades.push(options);
        return true;
      },
      timeout: () => undefined,
    };
    // Bun.Server is a large interface; the entry point only calls upgrade() and timeout().
    const bunServer = server as unknown as Bun.Server<never>;
    for (const url of ["http://127.0.0.1:3020/runtime/events/jobs/v2/stream", "http://127.0.0.1:3020/runtime/events"]) {
      for (const request of [new Request(url, { headers: bearer(token) }), new Request(`${url}?token=${token}`)]) {
        const res = await fetch(request, bunServer);
        expect(res?.status, request.url).toBe(401);
      }
    }
    expect(upgrades).toHaveLength(0);
    // The same token is refused by the Hono layer too.
    const stream = await app().request("/runtime/events/jobs/v2/stream", { headers: bearer(token) });
    expect(stream.status).toBe(403);
    // An app session still gets its upgrade.
    expect(await fetch(new Request(`http://127.0.0.1:3020/runtime/events?token=${appSide.token}`), bunServer)).toBeUndefined();
    expect(upgrades).toHaveLength(1);
  });
});

describe("a grant belongs to the user who approved it", () => {
  it("refuses to approve while nobody is signed in @req DEV-LIB-01[runtime]", async () => {
    vi.spyOn(BadgerModule.prototype, "getBackendUserId").mockReturnValue(null);
    const appSide = connectApp();
    const { body } = await requestAccess();
    const res = await decide(appSide.token, body.requestId!, { decision: "approve" });
    expect(res.status).toBe(409);
    expect((await stringFields(res)).error).toBe(TOOL_ACCESS_ERRORS.libraryLocked);
    expect((await collect(body.requestId!, body.pollSecret!)).status).toBe(202);
    expect(toolAccess.snapshot().grants).toHaveLength(0);
  });

  it("ends the grant, and the token, the moment another user is active @req DEV-LIB-01[runtime]", async () => {
    openLibrary();
    const appSide = connectApp();
    const granted = await grantTool(appSide.token);
    expect((await callTool(granted.token, "listMedia")).status).toBe(200);
    signIn("user-2");
    const res = await callTool(granted.token, "listMedia");
    expect(res.status).toBe(401);
    expect(toolAccess.snapshot().grants).toHaveLength(0);
    expect(runtimeState.requireSession(granted.token)).toBeNull();
    // Going back to the first user does not bring it back.
    signIn(USER);
    expect((await callTool(granted.token, "listMedia")).status).toBe(401);
  });

  it("ends the grants when a key for another user is set, and keeps them for the same user @req DEV-LIB-01[runtime]", async () => {
    openLibrary();
    const appSide = connectApp();
    const granted = await grantTool(appSide.token);
    const sessionFor = (userId: string) => runtimeState.login("backend-token", ["badger"], userId).token;
    const setKey = (token: string) =>
      post("/runtime/keys/set", { masterKeyBase64: Buffer.alloc(32, 7).toString("base64") }, bearer(token));

    expect((await setKey(sessionFor(USER))).status).toBe(200);
    expect(toolAccess.snapshot().grants).toHaveLength(1);
    expect((await callTool(granted.token, "listMedia")).status).toBe(200);

    expect((await setKey(sessionFor("user-2"))).status).toBe(200);
    expect(toolAccess.snapshot().grants).toHaveLength(0);
    expect(runtimeState.requireSession(granted.token)).toBeNull();
  });

  it("ends every grant when the library is closed (sign-out, cache clear) @req DEV-LIB-01[runtime]", async () => {
    await library.openLocal("backend-token", Buffer.alloc(32, 7).toString("base64"), { userId: "user-tool-access" });
    expect(library.isOpen()).toBe(true);
    const appSide = connectApp();
    const first = await grantTool(appSide.token, "read", "first");
    const second = await grantTool(appSide.token, "read", "second");
    expect(toolAccess.snapshot().grants).toHaveLength(2);
    await library.close();
    expect(toolAccess.snapshot().grants).toHaveLength(0);
    expect(runtimeState.requireSession(first.token)).toBeNull();
    expect(runtimeState.requireSession(second.token)).toBeNull();

    // The same for a cache clear.
    await library.openLocal("backend-token", Buffer.alloc(32, 7).toString("base64"), { userId: "user-tool-access" });
    await grantTool(appSide.token, "read", "third");
    await library.clearLocalCache();
    expect(toolAccess.snapshot().grants).toHaveLength(0);
  });

  it("ends every grant on DELETE /runtime/access/grants, for the app only @req DEV-LIB-01[runtime]", async () => {
    const appSide = connectApp();
    const granted = await grantTool(appSide.token, "read", "first");
    await grantTool(appSide.token, "read", "second");

    const asTool = await app().request("/runtime/access/grants", { method: "DELETE", headers: bearer(granted.token) });
    expect(asTool.status).toBe(403);
    const anonymous = await app().request("/runtime/access/grants", { method: "DELETE" });
    expect(anonymous.status).toBe(401);
    expect(toolAccess.snapshot().grants).toHaveLength(2);

    const res = await app().request("/runtime/access/grants", { method: "DELETE", headers: bearer(appSide.token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revoked: 2 });
    expect(toolAccess.snapshot().grants).toHaveLength(0);
    expect(runtimeState.requireSession(granted.token)).toBeNull();
  });
});

describe("revocation and lifetime", () => {
  it("ends the token, and its streams, the instant the user revokes @req DEV-LIB-01[runtime]", async () => {
    openLibrary();
    const appSide = connectApp();
    const granted = await grantTool(appSide.token);
    expect((await callTool(granted.token, "listMedia")).status).toBe(200);
    const closed = vi.fn();
    runtimeState.addSubscriber("tool-stream", granted.token, () => undefined, closed);

    const listed = toolAccessGrantsResponseSchema.parse(
      await (await app().request("/runtime/access/grants", { headers: bearer(appSide.token) })).json()
    );
    expect(listed.grants.map((grant) => grant.grantId)).toEqual([granted.grantId]);

    const revoked = await app().request(`/runtime/access/grants/${granted.grantId}`, {
      method: "DELETE",
      headers: bearer(appSide.token),
    });
    expect(revoked.status).toBe(200);
    expect((await callTool(granted.token, "listMedia")).status).toBe(401);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(runtimeState.requireSession(granted.token)).toBeNull();
    expect(toolAccess.snapshot().grants).toHaveLength(0);
    // Revoking again, or an unknown grant, is a 404.
    const again = await app().request(`/runtime/access/grants/${granted.grantId}`, { method: "DELETE", headers: bearer(appSide.token) });
    expect(again.status).toBe(404);
    // The app session is untouched.
    expect(runtimeState.requireSession(appSide.token)?.kind).toBe("app");
  });

  it("ends the token after eight hours whatever its use @req DEV-LIB-01[runtime]", async () => {
    openLibrary();
    vi.useFakeTimers({ toFake: ["Date"] });
    const appSide = connectApp();
    const { token } = await grantTool(appSide.token);
    // Keep it busy so only the absolute limit can end it.
    for (let elapsed = 0; elapsed < TOOL_ACCESS_LIMITS.sessionTtlMs - 20 * 60_000; elapsed += 10 * 60_000) {
      vi.setSystemTime(Date.now() + 10 * 60_000);
      expect((await callTool(token, "listMedia")).status).toBe(200);
    }
    vi.setSystemTime(Date.now() + 25 * 60_000);
    expect((await callTool(token, "listMedia")).status).toBe(401);
  });

  it("ends the token after thirty idle minutes @req DEV-LIB-01[runtime]", async () => {
    openLibrary();
    vi.useFakeTimers({ toFake: ["Date"] });
    const appSide = connectApp();
    const { token } = await grantTool(appSide.token);
    vi.setSystemTime(Date.now() + 20 * 60_000);
    expect((await callTool(token, "listMedia")).status).toBe(200);
    vi.setSystemTime(Date.now() + 20 * 60_000);
    expect((await callTool(token, "listMedia")).status).toBe(200);
    vi.setSystemTime(Date.now() + TOOL_ACCESS_LIMITS.sessionIdleMs + 1000);
    expect((await callTool(token, "listMedia")).status).toBe(401);
  });

  it("records use, and shows the grant to the apps without any secret @req DEV-LIB-01[runtime]", async () => {
    openLibrary();
    const appSide = connectApp();
    const granted = await grantTool(appSide.token, "write", "Recorder");
    expect(toolAccess.snapshot().grants[0]?.lastUsedAt).toBeNull();
    await callTool(granted.token, "listMedia");
    const grant = toolAccess.snapshot().grants[0]!;
    expect(grant).toMatchObject({ toolName: "Recorder", mode: "write", grantId: granted.grantId });
    expect(grant.lastUsedAt).not.toBeNull();
    expect(JSON.stringify(appSide.frames)).not.toContain(granted.token);
  });
});

describe("nothing secret leaves", () => {
  it("never puts a key, token or backend token in a response or a log @req DEV-LIB-01[runtime]", async () => {
    openLibrary();
    const appSide = connectApp();
    const granted = await grantTool(appSide.token, "write");
    const responses: string[] = [];
    const record = async (res: Response) => {
      responses.push(await res.text());
    };
    for (const op of TOOL_OPERATIONS) await record(await callTool(granted.token, op, {}));
    await record(await callTool(granted.token, "deleteMedia", {}));
    await record(await app().request("/runtime/health", { headers: bearer(granted.token) }));
    await record(await callTool("rt_nope", "listMedia"));
    const everything = [...responses, ...logged].join("\n");
    expect(everything).not.toContain(APP_TOKEN_BACKEND);
    expect(everything).not.toContain(LIBRARY_KEY);
    expect(everything).not.toContain(appSide.token);
    // A tool's own token never shows up in logs, and nothing a tool gets back contains the app's.
    expect(logged.join("\n")).not.toContain(granted.token);
  });

  it("returns only token, expiry, grant id, mode and allowed ops when the token is collected @req DEV-LIB-01[runtime]", async () => {
    const appSide = connectApp();
    const { body } = await requestAccess();
    await decide(appSide.token, body.requestId!, { decision: "approve" });
    const res = await collect(body.requestId!, body.pollSecret!);
    expect(Object.keys((await res.json()) as object).sort()).toEqual(["allowedOps", "expiresAt", "grantId", "mode", "token"]);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("tool access and the owner secret", () => {
  it("leaves the app login behind the owner secret untouched @req RT-SEC-05[runtime]", async () => {
    // Tool routes never accept the owner header as a credential, and asking for access needs no secret.
    connectApp();
    const { res } = await requestAccess();
    expect(res.status).toBe(200);
    const login = await post("/runtime/session/login", { backendToken: "tok", apps: ["badger"] });
    expect(login.status).toBe(401);
  });
});
