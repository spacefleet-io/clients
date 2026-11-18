/**
 * PLAT-WEB-06: the web player's grant lasts until the user revokes it or the
 * desktop app signs out. No 8 h / 30 min limit, and it survives a runtime
 * restart (the store keeps a digest of the token, never the token). A grant
 * made outside a browser keeps the time limits.
 *
 * @covers apps/runtime/src/core/toolAccess.ts, apps/runtime/src/core/toolGrantStore.ts, apps/runtime/src/state.ts
 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOOL_ACCESS_ERRORS, TOOL_READ_OPERATIONS } from "@space/tool-access/contracts";
import { RuntimeState } from "../src/state";
import { TOOL_ACCESS_LIMITS, ToolAccessManager, WEB_GRANT_EXPIRES_AT } from "../src/core/toolAccess";
import { fileToolGrantStore } from "../src/core/toolGrantStore";

const TAG = "[web-grant-lifetime]";
const ORIGIN = "http://localhost:5199";
const READ_OP = TOOL_READ_OPERATIONS[0];
const SLICES = "/tmp/spacefleet-runtime-slices";

let dir: string;
let storePath: string;
let activeUser: string | null;

/** One runtime process: its own memory state and manager, the store file shared across "restarts". */
const startRuntime = () => {
  const state = new RuntimeState(60_000, 50, "1", SLICES);
  const manager = new ToolAccessManager({
    state,
    activeUserId: () => activeUser,
    hasPromptReceiver: () => true,
    publish: () => undefined,
    store: fileToolGrantStore(storePath),
  });
  return { state, manager };
};

const grant = (manager: ToolAccessManager, origin: string | null) => {
  const asked = manager.request({ toolName: "Badger web player", mode: "read" }, origin);
  if (!asked.ok) throw new Error(`request failed: ${asked.message}`);
  expect(manager.decide(asked.requestId, "approve").ok).toBe(true);
  const collected = manager.poll(asked.requestId, asked.pollSecret, origin);
  if (!collected.ok || collected.status !== 200) throw new Error("poll did not hand out a token");
  console.info(TAG, "granted", { origin, grantId: collected.body.grantId, expiresAt: collected.body.expiresAt });
  return collected.body;
};

const stored = () => (existsSync(storePath) ? readFileSync(storePath, "utf8") : null);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-05T10:00:00Z"));
  dir = mkdtempSync(path.join(tmpdir(), "web-grant-lifetime-"));
  storePath = path.join(dir, "runtime_tool_grants.json");
  activeUser = "user-1";
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("web player grant lifetime", () => {
  it("has no 8 h or 30 min limit for a web origin @req PLAT-WEB-06", () => {
    const { manager } = startRuntime();
    const token = grant(manager, ORIGIN);
    expect(Date.parse(token.expiresAt)).toBe(WEB_GRANT_EXPIRES_AT);

    vi.advanceTimersByTime(TOOL_ACCESS_LIMITS.sessionIdleMs + 60_000);
    expect(manager.authorize(token.token, READ_OP, ORIGIN).ok).toBe(true);
    vi.advanceTimersByTime(TOOL_ACCESS_LIMITS.sessionTtlMs * 3);
    const later = manager.authorize(token.token, READ_OP, ORIGIN);
    console.info(TAG, "after 24 h + idle", later);
    expect(later.ok).toBe(true);
    expect(manager.snapshot().grants).toHaveLength(1);
  });

  it("keeps the 8 h / 30 min limits for a tool outside any browser @req PLAT-WEB-06", () => {
    const { manager } = startRuntime();
    const token = grant(manager, null);
    vi.advanceTimersByTime(TOOL_ACCESS_LIMITS.sessionIdleMs + 1_000);
    expect(manager.authorize(token.token, READ_OP, null).ok).toBe(false);
    expect(manager.snapshot().grants).toHaveLength(0);
    expect(stored()).toBeNull();
  });

  it("survives a runtime restart and stores no token @req PLAT-WEB-06", () => {
    const first = startRuntime();
    const token = grant(first.manager, ORIGIN);
    // The runtime stops: only time-limited grants end on shutdown.
    first.manager.revokeTimeLimited();
    const file = stored();
    console.info(TAG, "store after shutdown", file);
    expect(file).not.toBeNull();
    expect(file).not.toContain(token.token);

    const second = startRuntime();
    // Listed in Connected tools before the web player comes back.
    expect(second.manager.snapshot().grants.map((g) => g.grantId)).toEqual([token.grantId]);
    const restored = second.manager.authorize(token.token, READ_OP, ORIGIN);
    console.info(TAG, "first call after restart", restored);
    expect(restored).toEqual({ ok: true, grantId: token.grantId });
    expect(second.manager.authorize(token.token, READ_OP, ORIGIN).ok).toBe(true);
  });

  it("refuses a restored token from another origin or of an unknown digest @req PLAT-WEB-06", () => {
    const first = startRuntime();
    const token = grant(first.manager, ORIGIN);
    const second = startRuntime();
    const elsewhere = second.manager.authorize(token.token, READ_OP, "https://evil.example");
    expect(elsewhere.ok).toBe(false);
    if (!elsewhere.ok) expect(elsewhere.error).toBe(TOOL_ACCESS_ERRORS.forbiddenOrigin);
    expect(second.manager.authorize(`${token.token}x`, READ_OP, ORIGIN).ok).toBe(false);
  });

  it("waits, without ending, while the desktop app has not signed in after a restart @req PLAT-WEB-06", () => {
    const first = startRuntime();
    const token = grant(first.manager, ORIGIN);
    activeUser = null;
    const second = startRuntime();
    const locked = second.manager.authorize(token.token, READ_OP, ORIGIN);
    console.info(TAG, "before the desktop pushed its key", locked);
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.error).toBe(TOOL_ACCESS_ERRORS.libraryLocked);
    activeUser = "user-1";
    expect(second.manager.authorize(token.token, READ_OP, ORIGIN).ok).toBe(true);
  });

  it("ends on revoke and on sign-out, and the store forgets it @req PLAT-WEB-06", () => {
    const { manager } = startRuntime();
    const revoked = grant(manager, ORIGIN);
    expect(manager.revoke(revoked.grantId)).toBe(true);
    expect(stored()).toBeNull();
    expect(startRuntime().manager.authorize(revoked.token, READ_OP, ORIGIN).ok).toBe(false);

    const signedOut = grant(manager, ORIGIN);
    expect(manager.revokeAll()).toBe(1);
    expect(stored()).toBeNull();
    expect(manager.authorize(signedOut.token, READ_OP, ORIGIN).ok).toBe(false);
  });

  it("ends when another user signs in @req PLAT-WEB-06", () => {
    const first = startRuntime();
    const token = grant(first.manager, ORIGIN);
    const second = startRuntime();
    second.manager.revokeForOtherUsers("user-2");
    expect(stored()).toBeNull();
    expect(second.manager.authorize(token.token, READ_OP, ORIGIN).ok).toBe(false);
  });
});
