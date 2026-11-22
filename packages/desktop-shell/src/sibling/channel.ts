/**
 * ACCT-PAIR-07: the local channel between Badger and Parrot on one computer. A signed-in app listens on a socket in
 * the user-only sibling folder (a named pipe on Windows); never on the network. One request per connection, one JSON
 * line each way, a size cap and timeouts.
 *
 * The per-user secret never goes on the channel: a named pipe's name can be taken first by another user, so whoever
 * answers may not be the sister app. Each request carries a fresh nonce and an HMAC of its fields under the secret;
 * each answer carries an HMAC of that nonce and its exact body. Either side drops a message whose HMAC does not check.
 *
 *   approve -> the listening app checks the request really is its sister app's sign-in on this computer
 *              (`approveSiblingRequest`), tells the API to approve with `localKey` and answers with the library key
 *              sealed for that request: the key never goes through the server, not even sealed.
 *   refuse  -> the asking app gave up (Cancel, time limit): the request is denied so it cannot be approved later.
 *
 * The asking side starts the sister app in the background (`--sibling-sign-in`) when nothing answers yet.
 */
import { spawn as spawnProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import {
  approvePairingErrorKind,
  approveSiblingRequest,
  isSealedKey,
  refuseSiblingRequest,
  type SealedKey,
  type SiblingApproveDeps,
} from "@space/pairing-crypto";
import { normalizeSpaceAppId, siblingAppOf, type SpaceAppId } from "@space/shared/appScope";
import { PAIRING_DEVICE_TYPE } from "../pairing/main";
import { SIBLING_SIGN_IN_ARG, prepareSiblingDir, siblingSocketPath, type SiblingPlace } from "./place";
import { ensureSiblingSecret, sameSiblingMac, siblingMac } from "./secret";
import { readSiblingStatus } from "./status";

type Log = (message: string, extra?: Record<string, unknown>) => void;

export type SiblingOp = "approve" | "refuse";

type SiblingRequest = { v: 1; op: SiblingOp; asker: SpaceAppId; requestId: string; code: string; nonce: string; mac: string };

const requestMacText = (request: Pick<SiblingRequest, "op" | "asker" | "requestId" | "code" | "nonce">) =>
  `sf-sibling-req|v1|${request.op}|${request.asker}|${request.requestId}|${request.code}|${request.nonce}`;
const answerMacText = (nonce: string, body: string) => `sf-sibling-ans|v1|${nonce}|${body}`;

/** The answer on the wire; the asking side reports any refusal as `failed`. */
type WireAnswer = { ok: true; sealedKey?: SealedKey } | { ok: false; error: string };

export type SiblingAnswer = { ok: true; sealedKey?: SealedKey } | { ok: false; error: "failed" | "unreachable" };

const REQUEST_MAX_BYTES = 16 * 1024;
/** Time a caller has to send its request once connected. */
const REQUEST_READ_TIMEOUT_MS = 10_000;

const readLine = (socket: Socket, maxBytes: number, onLine: (line: string | null) => void) => {
  let buffer = "";
  let done = false;
  const finish = (line: string | null) => {
    if (done) return;
    done = true;
    onLine(line);
  };
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const end = buffer.indexOf("\n");
    if (end >= 0) finish(buffer.slice(0, end));
    else if (buffer.length > maxBytes) finish(null);
  });
  socket.on("end", () => finish(buffer || null));
  socket.on("error", () => finish(null));
  socket.on("close", () => finish(null));
};

const parseRequest = (line: string | null, self: SpaceAppId): SiblingRequest | null => {
  if (!line || line.length > REQUEST_MAX_BYTES) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (raw?.v !== 1 || (raw.op !== "approve" && raw.op !== "refuse")) return null;
  if (typeof raw.requestId !== "string" || typeof raw.code !== "string" || typeof raw.nonce !== "string") return null;
  if (!/^[0-9a-f]{32}$/.test(raw.nonce)) return null;
  if (raw.code.length > 32 || raw.requestId.length > 128) return null;
  const asker = normalizeSpaceAppId(raw.asker);
  if (!asker || asker !== siblingAppOf(self)) return null;
  // A missing mac is a well-formed request that fails the mac check ("bad_mac"), never a trusted one.
  return { v: 1, op: raw.op, asker, requestId: raw.requestId, code: raw.code, nonce: raw.nonce, mac: typeof raw.mac === "string" ? raw.mac : "" };
};

export type SiblingServerOptions = {
  place: SiblingPlace;
  /** The listening, signed-in app. */
  app: SpaceAppId;
  /** This computer's name as the asking app announces it (`resolveDeviceName`). */
  deviceName: string;
  /** This app's session; null when signed out. */
  token: () => string | null;
  libraryKey: () => Promise<string | null>;
  api: Pick<SiblingApproveDeps, "lookup" | "approveLocal" | "deny">;
  log?: Log;
  /** After an approve or refuse was answered (the hidden start quits soon after). */
  onAnswered?: () => void;
};

export type SiblingServer = { path: string; close: () => Promise<void> };

export const startSiblingServer = async (options: SiblingServerOptions): Promise<SiblingServer> => {
  const { place, app } = options;
  const log: Log = options.log ?? (() => undefined);
  const secret = ensureSiblingSecret(place);
  const path = siblingSocketPath(place, app);
  const unix = !place.namedPipe;
  const asker = siblingAppOf(app);
  if (!asker) throw new Error(`${app} has no sister app`);
  const deps: SiblingApproveDeps = {
    ...options.api,
    getLibraryKey: options.libraryKey,
    now: () => Date.now(),
    log: (message, extra) => log(`sibling: ${message}`, extra),
  };
  const expectation = { asker, deviceType: PAIRING_DEVICE_TYPE, deviceName: options.deviceName };

  const answer = async (request: SiblingRequest): Promise<WireAnswer> => {
    const token = options.token();
    if (!token) return { ok: false, error: "signed_out" };
    try {
      if (request.op === "refuse") {
        await refuseSiblingRequest(deps, token, request.code, expectation);
        return { ok: true };
      }
      const approved = await approveSiblingRequest(deps, token, request.code, expectation);
      return { ok: true, sealedKey: approved.sealedKey };
    } catch (err) {
      return { ok: false, error: approvePairingErrorKind(err) };
    }
  };

  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.setTimeout(REQUEST_READ_TIMEOUT_MS, () => socket.destroy());
    readLine(socket, REQUEST_MAX_BYTES, (line) => {
      void (async () => {
        const request = parseRequest(line, app);
        const trusted = request !== null && sameSiblingMac(request.mac, siblingMac(secret, requestMacText(request)));
        let reply: WireAnswer = { ok: false, error: request ? "bad_mac" : "bad_request" };
        if (request && trusted) {
          socket.setTimeout(0);
          reply = await answer(request);
        }
        log("sibling: answered", { op: request?.op ?? null, requestId: request?.requestId ?? null, ok: reply.ok, error: reply.ok ? null : reply.error });
        const body = JSON.stringify(reply);
        const signed = { body, mac: siblingMac(secret, answerMacText(request?.nonce ?? "", body)) };
        if (!socket.destroyed) socket.end(`${JSON.stringify(signed)}\n`);
        if (trusted) options.onAnswered?.();
      })();
    });
  });

  if (unix) {
    prepareSiblingDir(place);
    // Only one copy of an app runs (the single-instance lock): a socket left here is a crashed run's.
    rmSync(path, { force: true });
  }
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(path, () => listening.resolve());
  await listening.promise;
  server.off("error", listening.reject);
  server.on("error", (err) => log("sibling: server error", { message: err.message }));
  if (unix) place.ownerOnly.file(path);
  log("sibling: listening", { app, path });

  return {
    path,
    close: async () => {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
      if (unix && existsSync(path)) rmSync(path, { force: true });
      log("sibling: closed", { app });
    },
  };
};

export type SiblingAskInput = {
  place: SiblingPlace;
  /** The app asking to be signed in. */
  asker: SpaceAppId;
  op: SiblingOp;
  requestId: string;
  code: string;
  log?: Log;
  /** Starts the sister app (`exePath` and its arguments); a detached background process by default. */
  spawn?: (exePath: string, args: string[]) => unknown;
  retryMs?: number;
  /** Time for the sister app to start and listen. */
  connectTimeoutMs?: number;
  /** Time for the sister app to answer once asked (it calls the API). */
  answerTimeoutMs?: number;
};

const spawnDetached = (exePath: string, args: string[]) => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnProcess(exePath, args, { detached: true, stdio: "ignore", windowsHide: true, env });
  child.on("error", () => undefined);
  child.unref();
};

const connectOnce = (path: string): Promise<Socket | null> => {
  const connected = Promise.withResolvers<Socket | null>();
  const socket = createConnection(path);
  socket.once("connect", () => connected.resolve(socket));
  socket.once("error", () => {
    socket.destroy();
    connected.resolve(null);
  });
  return connected.promise;
};

/** The answer, or null when none came, it is malformed, or its HMAC does not check (not the sister app). */
const exchange = (socket: Socket, request: SiblingRequest, secret: string, timeoutMs: number, log: Log): Promise<WireAnswer | null> => {
  const answered = Promise.withResolvers<WireAnswer | null>();
  socket.setTimeout(timeoutMs, () => {
    socket.destroy();
    answered.resolve(null);
  });
  readLine(socket, REQUEST_MAX_BYTES, (line) => {
    socket.destroy();
    if (!line) return answered.resolve(null);
    try {
      const signed = JSON.parse(line) as { body?: unknown; mac?: unknown };
      if (typeof signed?.body !== "string" || !sameSiblingMac(signed.mac, siblingMac(secret, answerMacText(request.nonce, signed.body)))) {
        log("sibling: answer dropped, its mac does not check", { requestId: request.requestId });
        return answered.resolve(null);
      }
      const parsed = JSON.parse(signed.body) as WireAnswer;
      answered.resolve(parsed && typeof parsed.ok === "boolean" ? parsed : null);
    } catch {
      answered.resolve(null);
    }
  });
  socket.write(`${JSON.stringify(request)}\n`);
  return answered.promise;
};

/** Asks the sister app on this computer, starting it in the background first when it is not running. */
export const askSibling = async (input: SiblingAskInput): Promise<SiblingAnswer> => {
  const log: Log = input.log ?? (() => undefined);
  const sister = siblingAppOf(input.asker);
  const status = sister ? readSiblingStatus(input.place, sister) : null;
  if (!sister || !status) {
    log("sibling: no signed-in sister app", { asker: input.asker });
    return { ok: false, error: "unreachable" };
  }
  const secret = ensureSiblingSecret(input.place);
  const path = siblingSocketPath(input.place, sister);
  const retryMs = input.retryMs ?? 300;
  const deadline = Date.now() + (input.connectTimeoutMs ?? 20_000);
  let started = false;
  let socket = await connectOnce(path);
  while (!socket) {
    if (!started) {
      started = true;
      log("sibling: starting the sister app in the background", { sister, exePath: status.exePath });
      await (input.spawn ?? spawnDetached)(status.exePath, [...status.args, SIBLING_SIGN_IN_ARG]);
    }
    if (Date.now() >= deadline) {
      log("sibling: the sister app never answered", { sister });
      return { ok: false, error: "unreachable" };
    }
    await sleep(retryMs);
    socket = await connectOnce(path);
  }
  const fields = { op: input.op, asker: input.asker, requestId: input.requestId, code: input.code, nonce: randomBytes(16).toString("hex") };
  const request: SiblingRequest = { v: 1, ...fields, mac: siblingMac(secret, requestMacText(fields)) };
  const answer = await exchange(socket, request, secret, input.answerTimeoutMs ?? 60_000, log);
  log("sibling: sister app answered", { op: input.op, requestId: input.requestId, ok: answer?.ok ?? null, error: answer && !answer.ok ? answer.error : null });
  // No trustworthy answer: a missing or forged one is a failure, never a key.
  if (!answer || !answer.ok) return { ok: false, error: "failed" };
  if (input.op === "approve" && !isSealedKey(answer.sealedKey)) return { ok: false, error: "failed" };
  return answer.sealedKey ? { ok: true, sealedKey: answer.sealedKey } : { ok: true };
};
