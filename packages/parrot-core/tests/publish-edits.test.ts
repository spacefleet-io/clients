/**
 * @test-id PARROT-CORE-PUBLISH-EDITS-001
 * @level unit
 * @why Every Parrot client saves playlists through this loop (PAR-PL-03). Replaying on anything but "someone else
 *   published first" would re-send a save the network lost, and a missing replay drops one device's edits.
 * @covers packages/parrot-core/src/publish-edits.ts
 */
import { describe, expect, it } from "bun:test";
import type { ParrotLibraryOp } from "@space/parrot-library-db-definition";
import { isParrotPublishConflict, publishParrotEditsWith, type ParrotPublishEditsDeps } from "../src/publish-edits";

/** A "database" is the list of op ids applied to it; the server holds a version and the published list. */
type Db = { name: string; applied: string[] };
const op = (opId: string) => ({ opId }) as unknown as ParrotLibraryOp;
const conflict = () => Object.assign(new Error("library_db_conflict"), { status: 409 });

const harness = (failures: unknown[]) => {
  const server = { version: 3, applied: ["server-edit"], publishes: [] as number[], loads: 0, closed: [] as string[] };
  const log: string[] = [];
  const deps: ParrotPublishEditsDeps<Db> = {
    loadLatest: async () => {
      server.loads += 1;
      return { db: { name: `latest-${server.loads}`, applied: [...server.applied] }, baseVersion: server.version };
    },
    applyOps: async (db, ops) => void db.applied.push(...ops.map((o) => (o as unknown as { opId: string }).opId)),
    publish: async (db, baseVersion) => {
      server.publishes.push(baseVersion);
      const failure = failures.shift();
      if (failure) throw failure;
      server.version += 1;
      server.applied = [...db.applied];
      return server.version;
    },
    isConflict: isParrotPublishConflict,
    close: (db) => void server.closed.push(db.name),
    log: (message) => log.push(message),
  };
  return { server, deps, log };
};

describe("publishParrotEditsWith", () => {
  // @req PAR-PL-03
  it("replays the same change once on the latest library when another device published first", async () => {
    const { server, deps, log } = harness([conflict()]);
    const state = { db: { name: "mine", applied: ["mine-edit"] }, baseVersion: 2 };
    const version = await publishParrotEditsWith(state, () => [op("mine-edit")], deps);
    console.log("[PARROT-CORE-PUBLISH-EDITS-001] log", log);
    expect(version).toBe(4);
    expect(state.baseVersion).toBe(4);
    expect(server.publishes).toEqual([2, 3]);
    expect(server.applied).toEqual(["server-edit", "mine-edit"]);
    expect(state.db.name).toBe("latest-1");
    expect(server.closed).toEqual(["mine"]);
  });

  // @req PAR-PL-03
  it("throws on a second conflict, keeping the latest library with the replayed change", async () => {
    const { server, deps } = harness([conflict(), conflict()]);
    const state = { db: { name: "mine", applied: ["mine-edit"] }, baseVersion: 2 };
    await expect(publishParrotEditsWith(state, () => [op("mine-edit")], deps)).rejects.toThrow("library_db_conflict");
    expect(server.publishes).toEqual([2, 3]);
    expect(server.loads).toBe(1);
    expect(state.db.applied).toEqual(["server-edit", "mine-edit"]);
  });

  // @req PAR-PL-03
  it("rethrows any other failure at once, without loading the latest library", async () => {
    const { server, deps, log } = harness([new Error("network down")]);
    const state = { db: { name: "mine", applied: ["mine-edit"] }, baseVersion: 2 };
    await expect(publishParrotEditsWith(state, () => [op("mine-edit")], deps)).rejects.toThrow("network down");
    expect(server.publishes).toEqual([2]);
    expect(server.loads).toBe(0);
    expect(state.db.name).toBe("mine");
    expect(log.some((m) => m.includes("replaying"))).toBe(false);
  });

  it("knows a conflict only by its 409 status", () => {
    expect(isParrotPublishConflict(conflict())).toBe(true);
    expect(isParrotPublishConflict(new Error("library_db_conflict"))).toBe(false);
    expect(isParrotPublishConflict({ status: 500 })).toBe(false);
    expect(isParrotPublishConflict(null)).toBe(false);
  });

  // @req LIB-FMT-09[parrot]
  it("does not replay a format refusal: a 409 library_format_downgrade means this build must update", () => {
    const refusal = { status: 409, payload: { error: "library_format_downgrade", surface: "op-stream", observed: 2, stored: 4 } };
    console.info("[publish-edits] format refusal", refusal);
    expect(isParrotPublishConflict(refusal)).toBe(false);
    expect(isParrotPublishConflict({ status: 409, payload: { error: "version_conflict" } })).toBe(true);
  });
});
