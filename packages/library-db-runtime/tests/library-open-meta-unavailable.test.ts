/**
 * @test-id LIB-OPEN-META-UNAVAILABLE-001
 * @level integration (real LibraryDb.open, bun:sqlite, fake API)
 * @bugfix @regression-proof
 * @req LIB-SYNC-03
 *
 * When the API cannot confirm the library's manifest (storage gateway down) it
 * now answers `GET /library/db/meta` with 503 `storage_gateway_unavailable`
 * instead of a 200 `exists:false, consistency:"missing_snapshot"`. `open()`
 * must turn that into `SYNC_UNAVAILABLE`: the renderer's
 * `classifyLibraryOpenFallback` maps exactly that message to "open the local
 * library + recovering banner". Pre-fix the raw ApiError escaped `pickBlob`,
 * which the renderer classifies as a hard failure and resets the library view.
 * Either way `open()` must never bootstrap (upload) a fresh library.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as realApi from "../src/api";

const SUITE = "library-open-meta-unavailable";
const log = (phase: string, data?: unknown) =>
  console.info(`[${SUITE}:${phase}]${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const fake = {
  metaStatus: 503,
  calls: [] as string[],
  reset() {
    this.metaStatus = 503;
    this.calls = [];
  },
};

// mock.module is process-global in a bun test run: restore the real exports
// afterwards so sibling suites do not hit this fake.
const originalApi = { ...realApi };
afterAll(() => {
  mock.module("../src/api", () => originalApi);
});

mock.module("../src/api", () => ({
  ...originalApi,
  getLibraryMeta: async () => {
    fake.calls.push(`getLibraryMeta -> ${fake.metaStatus}`);
    throw new realApi.ApiError(fake.metaStatus, { error: "storage_gateway_unavailable" });
  },
  getLibraryDb: async () => {
    fake.calls.push("getLibraryDb");
    throw new realApi.ApiError(fake.metaStatus, { error: "storage_gateway_unavailable" });
  },
  putLibraryDb: async () => {
    fake.calls.push("putLibraryDb");
    return { version: 1, stateHash: null, lastOpId: null, snapshotVersion: 1 };
  },
  uploadStorageObjectViaTunnel: async (_token: string, objectKey: string) => {
    fake.calls.push(`upload ${objectKey}`);
    return { ok: true };
  },
}));

// Dynamic import on purpose: libraryDb must load AFTER mock.module so its
// `./api` bindings resolve to the fake (module-loading boundary under test).
const { LibraryDb } = await import("../src/libraryDb");

const TOKEN = "token-open-meta-unavailable";
const KEY = randomBytes(32).toString("base64");
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-open-meta-unavailable-"));
  process.env.SF_USER_DATA_PATH = root;
  fake.reset();
  log("setup", { root });
});

afterEach(() => {
  log("teardown", { root, calls: fake.calls });
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

describe(`[${SUITE}] meta 502/503 is sync-unavailable, never "no library"`, () => {
  for (const status of [502, 503]) {
    it(`@bugfix @regression-proof open() throws SYNC_UNAVAILABLE on meta ${status} and uploads nothing`, async () => {
      fake.metaStatus = status;
      log("phase:open", { status, cache: "none" });
      let caught: unknown = null;
      try {
        const db = await LibraryDb.open(TOKEN, KEY);
        db.close();
      } catch (error) {
        caught = error;
      }
      log("phase:result", {
        error: caught instanceof Error ? `${caught.name}: ${caught.message}` : caught,
        calls: fake.calls,
      });
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("SYNC_UNAVAILABLE");
      expect(fake.calls.some((call) => call === "putLibraryDb" || call.startsWith("upload "))).toBe(false);
    });
  }
});
