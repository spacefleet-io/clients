/**
 * PLAT-WEB-06 over HTTP: a runtime that starts with a web grant in its store
 * answers the web player's old token on `POST /runtime/tool/:op`. The token
 * has no session yet (the process is new), so the route must let the grant
 * decide instead of refusing it as an unknown session.
 *
 * @covers POST /runtime/tool/:op, apps/runtime/src/routes/toolAccess.ts, apps/runtime/src/auth.ts, apps/runtime/src/core/toolAccess.ts
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { TOOL_ACCESS_ERRORS } from "@space/tool-access/contracts";

// The "previous run": its grant store is on disk before the runtime module loads.
const seeded = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs");
  const os = process.getBuiltinModule("node:os");
  const nodePath = process.getBuiltinModule("node:path");
  const crypto = process.getBuiltinModule("node:crypto");
  const dataDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "web-grant-restore-route-"));
  // Own data dir: the other suites' grants must not land in this store.
  process.env.SPACEFLEET_RUNTIME_DATA_DIR = dataDir;
  const token = "rt_web-player-token-from-before-the-restart";
  const grant = {
    id: "grant_from_before",
    toolName: "Badger web player",
    mode: "write",
    userId: "user-1",
    origin: "http://localhost:5173",
    grantedAt: Date.parse("2026-11-01T09:00:00Z"),
    lastUsedAt: null,
    tokenDigest: crypto.createHash("sha256").update(token).digest("hex"),
  };
  fs.writeFileSync(nodePath.join(dataDir, "runtime_tool_grants.json"), JSON.stringify({ version: 1, grants: [grant] }));
  return { dataDir, token, grantId: grant.id, userId: grant.userId, origin: grant.origin };
});

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

import { rmSync } from "node:fs";
import { createApp } from "../src/app";
import { runtimeState, toolAccess } from "../src/runtime";
import { getBadgerLibraryDbService, onKeySet } from "../src/modules";

const TAG = "[web-grant-restore-route]";
const OTHER_WEB = "http://127.0.0.1:4173";

const callTool = (token: string, op: string, origin: string | null) =>
  createApp().request(`/runtime/tool/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(origin === null ? {} : { origin }) },
    body: "{}",
  });

const errorOf = async (res: Response) => {
  const raw: unknown = await res.json();
  return raw && typeof raw === "object" && "error" in raw ? raw.error : undefined;
};

afterAll(() => {
  rmSync(seeded.dataDir, { recursive: true, force: true });
});

describe("web grant restored over HTTP after a restart", () => {
  it("answers the old token once the library is unlocked, and refuses everything else @req PLAT-WEB-06", async () => {
    for (const level of ["log", "info", "warn", "debug"] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
    const library = getBadgerLibraryDbService();
    vi.spyOn(library, "isOpen").mockReturnValue(true);
    vi.spyOn(library, "call").mockImplementation(async (method: string) => (method === "listPlaylists" ? [] : undefined));

    expect(runtimeState.requireSession(seeded.token)).toBeFalsy();
    expect(toolAccess.snapshot().grants.map((grant) => grant.grantId)).toEqual([seeded.grantId]);

    // Nobody signed in yet: the grant waits, the web player is told the library is locked.
    const locked = await callTool(seeded.token, "listPlaylists", seeded.origin);
    const lockedError = await errorOf(locked);
    process.stdout.write(`${TAG} before sign-in ${JSON.stringify({ status: locked.status, error: lockedError })}\n`);
    expect(locked.status).toBe(423);
    expect(lockedError).toBe(TOOL_ACCESS_ERRORS.libraryLocked);

    const unknown = await callTool("rt_never-granted", "listPlaylists", seeded.origin);
    expect(unknown.status).toBe(401);
    expect(await errorOf(unknown)).toBe(TOOL_ACCESS_ERRORS.unauthorized);

    const wrongOrigin = await callTool(seeded.token, "listPlaylists", OTHER_WEB);
    expect(wrongOrigin.status).toBe(403);
    expect(await errorOf(wrongOrigin)).toBe(TOOL_ACCESS_ERRORS.forbiddenOrigin);

    // A first-party app session is still not a tool token.
    const appSession = runtimeState.login("backend-token", ["badger"]);
    expect((await callTool(appSession.token, "listPlaylists", seeded.origin)).status).toBe(403);

    expect(toolAccess.snapshot().grants.map((grant) => grant.grantId)).toEqual([seeded.grantId]);

    // The desktop app unlocks the library: the old token works again, with no new approval.
    onKeySet(seeded.userId, Buffer.alloc(32, 7).toString("base64"), undefined, "live");
    const restored = await callTool(seeded.token, "listPlaylists", seeded.origin);
    process.stdout.write(`${TAG} after sign-in ${JSON.stringify({ status: restored.status })}\n`);
    expect(restored.status).toBe(200);
    expect(runtimeState.requireSession(seeded.token)?.kind).toBe("tool");
    expect((await callTool(seeded.token, "listPlaylists", seeded.origin)).status).toBe(200);

    const grants = toolAccess.snapshot().grants;
    expect(grants.map((grant) => grant.grantId)).toEqual([seeded.grantId]);
    expect(grants[0]?.lastUsedAt).not.toBeNull();
  });
});
