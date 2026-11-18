/**
 * @bugfix @regression-proof retranscode-auth-restart (issue #25).
 *
 * After the guardian respawns the runtime, the desktop re-fires
 * `badger.db.open` (libraryDbRuntimeProxy.reopenAfterRuntimeReady) carrying the
 * real backend bearer + library key. The runtime used to use that token ONLY to
 * open the library and never stamp it on the module, so `getActiveIngestToken()`
 * (what every resumed job resolves) stayed null until the renderer happened to
 * re-send keys — resumed retranscode jobs then failed AUTH_REQUIRED.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BadgerModule } from "../src/modules/badger";

const SUITE = "badger-db-open-attaches-auth";
const KEY = Buffer.alloc(32, 7).toString("base64");

describe(`[${SUITE}] badger.db.open attaches the session credentials`, () => {
  const mods: BadgerModule[] = [];
  beforeEach(() => {
    process.env.BADGER_GC_INTERVAL_MS = "0";
  });
  afterEach(() => {
    for (const mod of mods.splice(0)) mod.shutdown();
    delete process.env.BADGER_GC_INTERVAL_MS;
  });

  const exec = async (command: "badger.db.open" | "badger.db.open_local", token: string) => {
    const mod = new BadgerModule();
    mods.push(mod);
    const method = command === "badger.db.open" ? "open" : "openLocal";
    vi.spyOn(mod.libraryDbService, method).mockResolvedValue({ version: 1, mediaCount: 0 });
    expect(mod.getActiveIngestToken()).toBeNull();
    const result = await mod.execute({
      requestId: "r1",
      module: "badger",
      command,
      payload: { token, keyBase64: KEY, userId: "user-a" },
    });
    console.info(`[${SUITE}] ${command} ok=${result.response.ok} token=${mod.getActiveIngestToken()?.slice(0, 8)}`);
    expect(result.response.ok).toBe(true);
    return mod;
  };

  it("badger.db.open stamps the backend token and library key", async () => {
    const mod = await exec("badger.db.open", "tok-live-123456");
    expect(mod.getActiveIngestToken()).toBe("tok-live-123456");
    expect(mod.getActiveLibraryKey()).toBe(KEY);
  });

  it("badger.db.open_local stamps the backend token and library key", async () => {
    const mod = await exec("badger.db.open_local", "tok-local-123456");
    expect(mod.getActiveIngestToken()).toBe("tok-local-123456");
    expect(mod.getActiveLibraryKey()).toBe(KEY);
  });

  it("the token is stamped even when the library open fails (jobs still need auth)", async () => {
    const mod = new BadgerModule();
    mods.push(mod);
    vi.spyOn(mod.libraryDbService, "open").mockRejectedValue(new Error("boom"));
    const result = await mod.execute({
      requestId: "r2",
      module: "badger",
      command: "badger.db.open",
      payload: { token: "tok-live-123456", keyBase64: KEY, userId: "user-a" },
    });
    expect(result.response.ok).toBe(false);
    expect(mod.getActiveIngestToken()).toBe("tok-live-123456");
  });

  // @bugfix @regression-proof @req RT-JOBS-07
  it("makes the opened account the session's account, after its token, and reports the switch", async () => {
    const order: string[] = [];
    const mod = new BadgerModule({
      onSessionChanged: () => order.push(`session:${mod.getActiveIngestUserId()}:${mod.getActiveIngestToken()}`),
    });
    mods.push(mod);
    vi.spyOn(mod.libraryDbService, "open").mockResolvedValue({ version: 1, mediaCount: 0 });
    const open = (userId: string, token: string) =>
      mod.execute({ requestId: `r-${userId}`, module: "badger", command: "badger.db.open", payload: { token, keyBase64: KEY, userId } });

    await open("user-a", "tok-a");
    await open("user-a", "tok-a");
    await open("user-b", "tok-b");
    console.info(`[${SUITE}:session] order=${JSON.stringify(order)} active=${mod.getActiveIngestUserId()}`);
    // One report per change of account (a reopen for the same account is not a change), each seeing the new token.
    expect(order).toEqual(["session:user-a:tok-a", "session:user-b:tok-b"]);
    expect(mod.getActiveIngestUserId()).toBe("user-b");
  });
});
