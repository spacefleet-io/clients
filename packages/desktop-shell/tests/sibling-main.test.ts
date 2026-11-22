/**
 * @req ACCT-PAIR-07 @req PRIV-KEY-05
 * Same-device sign-in on a computer: a signed-in Badger signs in a freshly started Parrot on the same computer (and the
 * reverse) with one click. The signed-in app publishes a status file (only the app, the email, the user id and how to
 * start it: never a token or a key) in a user-only folder, and answers on a user-only local socket guarded by a
 * per-user secret. The asking app opens an ordinary pairing request, hands its code over that socket, gets the library
 * key back sealed for its own request, and finishes like any paired sign-in. The API is faked; the sealing, the
 * socket, the files and the pairing core are real.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  createPairingClientCore,
  sealLibraryKey,
  generateDeviceKeyPair,
  openSealedKey,
  type DeviceKeyPair,
  type PairingRequestInfo,
  type SealedKey,
} from "@space/pairing-crypto";
import {
  SIBLING_SIGN_IN_ARG,
  armSiblingHiddenQuit,
  askSibling,
  createSiblingSignIn,
  ensureSiblingSecret,
  isSiblingSignInLaunch,
  readSiblingOffer,
  removeSiblingStatus,
  resolveSiblingDir,
  siblingLaunchTarget,
  siblingSocketPath,
  startSiblingServer,
  writeSiblingStatus,
  createSiblingHost,
  type SiblingAnswer,
  type SiblingAskInput,
  type SiblingPlace,
  type SiblingServer,
  type SiblingServerOptions,
  type SiblingStatusInput,
} from "../src/sibling";

const SUITE = "[sibling-main]";
const LIBRARY_KEY = bytesToBase64(Uint8Array.from({ length: 32 }, (_, i) => 3 + i));
const DEVICE_NAME = "Linux desktop";
const log = (message: string, extra?: Record<string, unknown>) => console.info(SUITE, message, extra ?? "");
const hmac = (key: string, text: string) => createHmac("sha256", key).update(text).digest("hex");

const ownerOnly = {
  file: (path: string) => chmodSync(path, 0o600),
  dir: (path: string) => chmodSync(path, 0o700),
};

let root: string;
let place: SiblingPlace;
const servers: SiblingServer[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-sibling-"));
  place = { dir: join(root, "sibling"), namedPipe: false, ownerOnly };
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  rmSync(root, { recursive: true, force: true });
});

const status = (overrides: Partial<SiblingStatusInput> = {}): SiblingStatusInput => ({
  app: "badger" as const,
  email: "chris@example.test",
  userId: "user-1",
  exePath: process.execPath,
  args: [],
  pid: process.pid,
  ...overrides,
});

describe("where the sibling files live", () => {
  it("is SpaceFleet/sibling under the per-user data folder, -dev for development builds, overridable for tests", () => {
    const base = { userDataBase: () => "/home/u/.local/share" };
    const prod = resolveSiblingDir({ ...base, dev: false, env: {} });
    const dev = resolveSiblingDir({ ...base, dev: true, env: {} });
    const forced = resolveSiblingDir({ ...base, dev: false, env: { SF_SIBLING_DIR: "/tmp/x" } });
    log("dirs", { prod, dev, forced });
    expect(prod).toBe(join("/home/u/.local/share", "SpaceFleet", "sibling"));
    expect(dev).toBe(join("/home/u/.local/share", "SpaceFleet", "sibling-dev"));
    expect(forced).toBe("/tmp/x");
  });

  it("uses a socket in the folder on Linux and macOS, a named pipe per folder on Windows", () => {
    const unix = siblingSocketPath({ ...place, namedPipe: false }, "parrot");
    const win = siblingSocketPath({ ...place, namedPipe: true }, "parrot");
    const winOther = siblingSocketPath({ ...place, dir: join(root, "other"), namedPipe: true }, "parrot");
    log("sockets", { unix, win, winOther });
    expect(unix).toBe(join(place.dir, "parrot.sock"));
    expect(win).toMatch(/^\\\\\.\\pipe\\spacefleet-sibling-parrot-[0-9a-f]{16}$/);
    expect(winOther).not.toBe(win);
  });

  it("starts the installed app, or the AppImage file rather than its temporary mount, or the dev script", () => {
    expect(siblingLaunchTarget({ execPath: "/opt/Parrot/parrot", argv: ["/opt/Parrot/parrot"], defaultApp: false, env: {} })).toEqual({
      exePath: "/opt/Parrot/parrot",
      args: [],
    });
    expect(
      siblingLaunchTarget({ execPath: "/tmp/.mount_x/parrot", argv: ["/tmp/.mount_x/parrot"], defaultApp: false, env: { APPIMAGE: "/home/u/Parrot.AppImage" } }),
    ).toEqual({ exePath: "/home/u/Parrot.AppImage", args: [] });
    expect(siblingLaunchTarget({ execPath: "/n/electron", argv: ["/n/electron", "out/main/index.js"], defaultApp: true, env: {} }).args).toHaveLength(1);
    // A development or test run passes Chromium switches before the app folder: the folder is what restarts the app.
    expect(
      siblingLaunchTarget({ execPath: "/n/electron", argv: ["/n/electron", "--password-store=basic", "/w/apps/badger/desktop"], defaultApp: true, env: {} }).args,
    ).toEqual(["/w/apps/badger/desktop"]);
    expect(isSiblingSignInLaunch(["/opt/Parrot/parrot", SIBLING_SIGN_IN_ARG])).toBe(true);
    expect(isSiblingSignInLaunch(["/opt/Parrot/parrot"])).toBe(false);
  });
});

describe("the status file", () => {
  it("is user-only and holds the email and how to start the app, never a token or a key", () => {
    writeSiblingStatus(place, status());
    const path = join(place.dir, "badger.json");
    const raw = readFileSync(path, "utf8");
    const fileMode = statSync(path).mode & 0o777;
    const dirMode = statSync(place.dir).mode & 0o777;
    log("status written", { fileMode: fileMode.toString(8), dirMode: dirMode.toString(8), raw });
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["app", "args", "email", "exePath", "pid", "updatedAt", "userId", "v"]);
    expect(raw).not.toMatch(/token|libraryKey|key"/i);
  });

  it("offers the sister's account to the other app only, and only while it is signed in and installed", () => {
    expect(readSiblingOffer(place, "parrot")).toBeNull();
    writeSiblingStatus(place, status());
    const offer = readSiblingOffer(place, "parrot");
    log("offer for parrot", { offer });
    expect(offer).toEqual({ app: "badger", email: "chris@example.test" });
    expect(readSiblingOffer(place, "badger")).toBeNull();
    writeSiblingStatus(place, status({ exePath: join(root, "uninstalled") }));
    expect(readSiblingOffer(place, "parrot")).toBeNull();
    writeSiblingStatus(place, status());
    removeSiblingStatus(place, "badger");
    expect(readSiblingOffer(place, "parrot")).toBeNull();
  });

  it("ignores a malformed status", () => {
    ownerOnly.dir(root);
    writeSiblingStatus(place, status());
    writeFileSync(join(place.dir, "badger.json"), "{\"app\":\"badger\"}");
    expect(readSiblingOffer(place, "parrot")).toBeNull();
  });
});

describe("the per-user secret", () => {
  it("is created once, user-only, and shared by both apps", () => {
    const first = ensureSiblingSecret(place);
    const second = ensureSiblingSecret(place);
    const mode = statSync(join(place.dir, "secret")).mode & 0o777;
    log("secret", { length: first.length, mode: mode.toString(8) });
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(mode).toBe(0o600);
  });
});

describe("the local channel", () => {
  let parrot: DeviceKeyPair;
  let request: PairingRequestInfo;
  let approvedIds: string[];
  let deniedIds: string[];

  const startBadger = async (overrides: Partial<SiblingServerOptions> = {}) => {
    const server = await startSiblingServer({
      place,
      app: "badger",
      deviceName: DEVICE_NAME,
      token: () => "badger-token",
      libraryKey: async () => LIBRARY_KEY,
      api: {
        lookup: async (_token, code) => {
          if (code.replace(/[^A-Z0-9]/gi, "").toUpperCase() !== "ABCDEFGH") throw Object.assign(new Error("nf"), { status: 404, payload: { error: "pairing_not_found" } });
          return request;
        },
        approveLocal: async (_token, requestId) => {
          approvedIds.push(requestId);
          return { ok: true, sessionId: "sess-parrot" };
        },
        deny: async (_token, requestId) => {
          deniedIds.push(requestId);
          return { ok: true };
        },
      },
      log,
      ...overrides,
    });
    servers.push(server);
    return server;
  };

  beforeEach(() => {
    parrot = generateDeviceKeyPair();
    approvedIds = [];
    deniedIds = [];
    request = {
      requestId: "req-parrot",
      app: "parrot",
      purpose: "sign_in",
      deviceType: "desktop",
      deviceName: DEVICE_NAME,
      publicKey: parrot.publicKey,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    writeSiblingStatus(place, status());
  });

  it("approves the sister's request and hands back the key sealed for it alone", async () => {
    await startBadger();
    const answer = await askSibling({ place, asker: "parrot", op: "approve", requestId: "req-parrot", code: "ABCD-EFGH", log });
    log("answer", answer);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(approvedIds).toEqual(["req-parrot"]);
    const opened = openSealedKey({ devicePrivateKey: parrot.privateKey, requestId: "req-parrot", sealed: answer.sealedKey as SealedKey });
    expect(bytesToBase64(opened)).toBe(LIBRARY_KEY);
    expect(JSON.stringify(answer)).not.toContain(LIBRARY_KEY);
  });

  it.each([
    ["another app's request", { app: "other-app" }],
    ["another computer's request", { deviceName: "Windows (elsewhere)" }],
    ["an expired request", { expiresAt: new Date(Date.now() - 1000).toISOString() }],
  ])("refuses %s without approving", async (_label, patch) => {
    request = { ...request, ...(patch as Partial<PairingRequestInfo>) };
    await startBadger();
    const answer = await askSibling({ place, asker: "parrot", op: "approve", requestId: "req-parrot", code: "ABCD-EFGH", log });
    log("refused", answer);
    expect(answer).toMatchObject({ ok: false, error: "failed" });
    expect(approvedIds).toEqual([]);
  });

  /** One raw request line to `path`, and the raw answer line. */
  const sendRaw = async (path: string, request: Record<string, unknown>) => {
    const answered = Promise.withResolvers<string>();
    const socket = createConnection(path);
    let data = "";
    socket.on("data", (chunk) => (data += chunk.toString()));
    socket.on("end", () => answered.resolve(data));
    socket.on("error", answered.reject);
    socket.write(`${JSON.stringify(request)}\n`);
    return answered.promise;
  };

  it("never approves a request whose mac was not made with the per-user secret", async () => {
    const server = await startBadger();
    const secret = ensureSiblingSecret(place);
    const nonce = "a".repeat(32);
    const fields = { v: 1, op: "approve", asker: "parrot", requestId: "req-parrot", code: "ABCDEFGH", nonce };
    const wrongKey = hmac("0".repeat(64), `sf-sibling-req|v1|approve|parrot|req-parrot|ABCDEFGH|${nonce}`);
    const otherCode = hmac(secret, `sf-sibling-req|v1|approve|parrot|req-parrot|WXYZWXYZ|${nonce}`);
    for (const [label, request] of [
      ["wrong key", { ...fields, mac: wrongKey }],
      ["mac of another code", { ...fields, mac: otherCode }],
      ["the secret itself instead of a mac", { ...fields, secret }],
    ] as const) {
      const line = await sendRaw(server.path, request);
      log("forged request answer", { label, line });
      const parsed = JSON.parse(line) as { body: string; mac: string };
      expect(JSON.parse(parsed.body)).toEqual({ ok: false, error: "bad_mac" });
    }
    expect(approvedIds).toEqual([]);
  });

  it("never sends the secret, and drops an answer whose mac does not check (a squatter on the socket)", async () => {
    const secret = ensureSiblingSecret(place);
    const seen: string[] = [];
    const path = siblingSocketPath(place, "badger");
    const squatter = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.once("data", (line: string) => {
        seen.push(line);
        const { nonce } = JSON.parse(line) as { nonce: string };
        const body = JSON.stringify({ ok: true, sealedKey: { v: 1, epk: "x", iv: "y", ct: "z" } });
        socket.end(`${JSON.stringify({ body, mac: hmac("f".repeat(64), `sf-sibling-ans|v1|${nonce}|${body}`) })}\n`);
      });
    });
    const listening = Promise.withResolvers<void>();
    squatter.listen(path, () => listening.resolve());
    await listening.promise;
    try {
      const answer = await askSibling({ place, asker: "parrot", op: "approve", requestId: "req-parrot", code: "ABCD-EFGH", log });
      log("squatter", { seen, answer });
      expect(seen).toHaveLength(1);
      expect(seen[0]).not.toContain(secret);
      const sent = JSON.parse(seen[0]!) as Record<string, string>;
      expect(sent.mac).toBe(hmac(secret, `sf-sibling-req|v1|approve|parrot|req-parrot|ABCD-EFGH|${sent.nonce}`));
      expect(answer).toEqual({ ok: false, error: "failed" });
    } finally {
      const closed = Promise.withResolvers<void>();
      squatter.close(() => closed.resolve());
      await closed.promise;
    }
  });

  it("refuses when this app is signed out", async () => {
    await startBadger({ token: () => null });
    const answer = await askSibling({ place, asker: "parrot", op: "approve", requestId: "req-parrot", code: "ABCD-EFGH", log });
    expect(answer).toMatchObject({ ok: false, error: "failed" });
    expect(approvedIds).toEqual([]);
  });

  it("denies the request when the asking app cancels", async () => {
    await startBadger();
    const answer = await askSibling({ place, asker: "parrot", op: "refuse", requestId: "req-parrot", code: "ABCD-EFGH", log });
    log("refuse answer", answer);
    expect(answer.ok).toBe(true);
    expect(deniedIds).toEqual(["req-parrot"]);
  });

  it("starts the sister app in the background when it is not running, then asks it", async () => {
    const spawn = vi.fn(async () => {
      await startBadger();
    });
    const answer = await askSibling({ place, asker: "parrot", op: "approve", requestId: "req-parrot", code: "ABCD-EFGH", log, spawn, retryMs: 20 });
    log("after spawn", { calls: spawn.mock.calls, ok: answer.ok });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]).toEqual([process.execPath, [SIBLING_SIGN_IN_ARG]]);
    expect(answer.ok).toBe(true);
  });

  it("gives up when the sister app never answers", async () => {
    const spawn = vi.fn();
    const answer = await askSibling({ place, asker: "parrot", op: "approve", requestId: "req-parrot", code: "ABCD-EFGH", log, spawn, retryMs: 10, connectTimeoutMs: 100 });
    log("unreachable", answer);
    expect(answer).toEqual({ ok: false, error: "unreachable" });
  });

  it("removes its socket when it closes", async () => {
    const server = await startBadger();
    expect(existsSync(server.path)).toBe(true);
    await server.close();
    servers.length = 0;
    expect(existsSync(server.path)).toBe(false);
  });
});

describe("signing in with the sister app", () => {
  const user = { id: "user-1", email: "chris@example.test" };

  /** A real pairing core against a faked API: the API approves with `localKey` and returns the token only. */
  const pairingAgainst = (api: { approved: () => boolean; user?: { id: string; email: string } }) => {
    let publicKey = "";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      if (method === "POST" && url.endsWith("/pairing/requests")) {
        const body = JSON.parse(input instanceof Request ? await input.text() : String(init?.body));
        publicKey = body.publicKey;
        return Response.json({ requestId: "req-parrot", shortCode: "ABCD-EFGH", pollSecret: "poll", qrPayload: "q", expiresAt: new Date(Date.now() + 300_000).toISOString() });
      }
      if (url.includes("/pairing/requests/req-parrot")) {
        return Response.json(api.approved() ? { status: "approved", token: "parrot-token", user: api.user ?? user, localKey: true, clientType: "parrot-desktop" } : { status: "pending" });
      }
      return new Response("{}", { status: 404 });
    });
    const core = createPairingClientCore({
      getApiBaseUrl: () => "http://api.test",
      appId: "parrot",
      deviceType: "desktop",
      deviceName: () => DEVICE_NAME,
      fallbackDeviceName: "Computer",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log,
    });
    return { core, publicKey: () => publicKey };
  };

  beforeEach(() => writeSiblingStatus(place, status()));

  it("offers the sister's account and signs in with its key once both the API and the sister approved", async () => {
    let approved = false;
    const { core, publicKey } = pairingAgainst({ approved: () => approved });
    const ask = vi.fn(async (input: SiblingAskInput): Promise<SiblingAnswer> => {
      log("asked sister", { op: input.op, requestId: input.requestId, code: input.code });
      approved = true;
      return { ok: true, sealedKey: sealLibraryKey({ devicePublicKey: publicKey(), requestId: input.requestId, libraryKey: base64ToBytes(LIBRARY_KEY) }) };
    });
    const signIn = createSiblingSignIn({ place, app: "parrot", pairing: core, log, ask });
    expect(signIn.offer()).toEqual({ app: "badger", email: "chris@example.test" });
    const result = await signIn.signIn();
    log("sign-in result", { status: result.status });
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ asker: "parrot", op: "approve", requestId: "req-parrot", code: "ABCD-EFGH" }));
    expect(result).toEqual({ status: "approved", token: "parrot-token", user, libraryKey: LIBRARY_KEY });
  });

  it("refuses an approval for another account than the one the sister app is signed in with", async () => {
    let approved = false;
    const { core, publicKey } = pairingAgainst({ approved: () => approved, user: { id: "user-squatter", email: "other@example.test" } });
    const ops: string[] = [];
    const ask = async (input: SiblingAskInput): Promise<SiblingAnswer> => {
      ops.push(input.op);
      if (input.op === "refuse") return { ok: true };
      approved = true;
      return { ok: true, sealedKey: sealLibraryKey({ devicePublicKey: publicKey(), requestId: input.requestId, libraryKey: base64ToBytes(LIBRARY_KEY) }) };
    };
    const signIn = createSiblingSignIn({ place, app: "parrot", pairing: core, log, ask });
    const result = await signIn.signIn();
    log("other account", { result, ops });
    expect(result).toEqual({ status: "failed" });
  });

  it("fails when the sister app refuses or cannot be reached, and drops the request", async () => {
    const { core } = pairingAgainst({ approved: () => false });
    const cancel = vi.spyOn(core, "cancel");
    const signIn = createSiblingSignIn({ place, app: "parrot", pairing: core, log, ask: async () => ({ ok: false, error: "unreachable" }) });
    const result = await signIn.signIn();
    log("failed", result);
    expect(result).toEqual({ status: "failed" });
    expect(cancel).toHaveBeenCalled();
  });

  it("fails after the time limit and tells the sister app to deny the request", async () => {
    const { core } = pairingAgainst({ approved: () => false });
    const ops: string[] = [];
    const signIn = createSiblingSignIn({
      place,
      app: "parrot",
      pairing: core,
      log,
      timeoutMs: 150,
      ask: async (input) => {
        ops.push(input.op);
        return input.op === "approve" ? new Promise<SiblingAnswer>(() => undefined) : { ok: true };
      },
    });
    const result = await signIn.signIn();
    log("timed out", { result, ops });
    expect(result).toEqual({ status: "failed" });
    expect(ops).toEqual(["approve", "refuse"]);
  });

  it("stops at once on Cancel", async () => {
    const { core } = pairingAgainst({ approved: () => false });
    const asked = Promise.withResolvers<void>();
    const signIn = createSiblingSignIn({
      place,
      app: "parrot",
      pairing: core,
      log,
      ask: async (input) => {
        if (input.op !== "approve") return { ok: true };
        asked.resolve();
        return new Promise<SiblingAnswer>(() => undefined);
      },
    });
    const pending = signIn.signIn();
    await asked.promise;
    signIn.cancel();
    const result = await pending;
    log("cancelled", result);
    expect(result).toEqual({ status: "cancelled" });
  });
});

describe("the hidden start", () => {
  it("quits soon after answering, or after a minute with no request", () => {
    vi.useFakeTimers();
    try {
      const quit = vi.fn();
      const hidden = armSiblingHiddenQuit({ quit, idleMs: 60_000, afterAnswerMs: 1_500, log });
      vi.advanceTimersByTime(1_000);
      hidden.answered();
      vi.advanceTimersByTime(1_499);
      expect(quit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(quit).toHaveBeenCalledTimes(1);

      const idleQuit = vi.fn();
      armSiblingHiddenQuit({ quit: idleQuit, idleMs: 60_000, log });
      vi.advanceTimersByTime(60_000);
      expect(idleQuit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the signed-in app's side (both apps)", () => {
  const api = { lookup: vi.fn(), approveLocal: vi.fn(), deny: vi.fn() };
  const pairing = { start: vi.fn(), poll: vi.fn(), cancel: vi.fn(), deliverLocalKey: vi.fn() };

  it("publishes the account and listens while signed in, and removes both on sign-out", async () => {
    const host = createSiblingHost({
      app: "badger",
      place,
      launch: { exePath: process.execPath, args: ["main.js"] },
      deviceName: DEVICE_NAME,
      api,
      pairing,
      log,
    });
    const socket = siblingSocketPath(place, "badger");
    await host.setAccount({ token: "badger-token", user: { id: "user-1", email: "chris@example.test" }, libraryKey: async () => LIBRARY_KEY });
    const raw = JSON.parse(readFileSync(join(place.dir, "badger.json"), "utf8")) as Record<string, unknown>;
    log("signed in", { raw, socket: existsSync(socket) });
    expect(raw).toMatchObject({ app: "badger", email: "chris@example.test", userId: "user-1", args: ["main.js"], pid: process.pid });
    expect(existsSync(socket)).toBe(true);
    // Parrot sees the offer.
    expect(readSiblingOffer(place, "parrot")).toEqual({ app: "badger", email: "chris@example.test" });

    // The same account again (the window re-saving its session) changes nothing; another one is republished.
    await host.setAccount({ token: "badger-token-2", user: { id: "user-1", email: "chris@example.test" }, libraryKey: async () => LIBRARY_KEY });
    expect(existsSync(socket)).toBe(true);

    await host.setAccount(null);
    log("signed out", { status: existsSync(join(place.dir, "badger.json")), socket: existsSync(socket) });
    expect(existsSync(join(place.dir, "badger.json"))).toBe(false);
    expect(existsSync(socket)).toBe(false);
    expect(readSiblingOffer(place, "parrot")).toBeNull();
    await host.close();
  });

  it("tells the asking app's window only the sister app and its email", async () => {
    writeSiblingStatus(place, status({ app: "badger" }));
    const host = createSiblingHost({ app: "parrot", place, launch: { exePath: process.execPath, args: [] }, deviceName: DEVICE_NAME, api, pairing, log });
    expect(host.offer()).toEqual({ app: "badger", email: "chris@example.test" });
    await host.close();
  });
});
