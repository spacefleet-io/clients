/**
 * testLog: a Parrot build opening a library file saved at a schema newer than it knows latches the shared update
 * screen (reason `library_schema`) before the error propagates; a known schema latches nothing. Opening keeps a library
 * at schema 10; only a change storing a song in parts takes it to schema 11 (API-VER-01).
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  createParrotOp,
  PARROT_LIBRARY_SCHEMA_VERSION,
  PARROT_LIBRARY_WHOLE_FILES_SCHEMA_VERSION,
  ParrotLibraryTooNewError,
} from "@space/parrot-library-db-definition";
import { __resetAppVersionStateForTests, getAppUpdateRequired, LIBRARY_SCHEMA_REASON, setClientIdentity } from "@space/shared/appVersion";
import { parrotLibraryStatementsForOps, parrotLibraryUpgradeStatements } from "../src/librarySchema";

const T = "[PARROT-CORE-LIBRARY-SCHEMA]";

afterEach(() => __resetAppVersionStateForTests());

describe("parrotLibraryUpgradeStatements", () => {
  it("@req PAR-FMT-01 a library newer than this build shows the update screen instead of failing silently", () => {
    setClientIdentity({ app: "parrot", platform: "android", version: "0.1.18" });
    expect(() => parrotLibraryUpgradeStatements(PARROT_LIBRARY_SCHEMA_VERSION + 1)).toThrow(ParrotLibraryTooNewError);
    const latched = getAppUpdateRequired();
    console.log(T, "latched", latched);
    expect(latched).toEqual({
      error: "app_update_required",
      app: "parrot",
      platform: "android",
      version: "0.1.18",
      minVersion: "",
      reason: LIBRARY_SCHEMA_REASON,
    });
  });

  it("@req PAR-FMT-01 a library this build knows is upgraded with nothing latched", () => {
    expect(parrotLibraryUpgradeStatements(0).at(-1)).toBe(`PRAGMA user_version = ${PARROT_LIBRARY_WHOLE_FILES_SCHEMA_VERSION}`);
    expect(parrotLibraryUpgradeStatements(PARROT_LIBRARY_WHOLE_FILES_SCHEMA_VERSION)).toEqual([]);
    expect(parrotLibraryUpgradeStatements(PARROT_LIBRARY_SCHEMA_VERSION)).toEqual([]);
    expect(getAppUpdateRequired()).toBeNull();
  });
});

const meta = { id: "op-1", createdAt: "2026-11-21T00:00:00.000Z" };
const file = {
  id: "tf-1",
  trackId: "t-1",
  codec: "aac",
  container: "m4a",
  mime: "audio/mp4",
  lossless: false,
  bitrateKbps: 256,
  sampleRate: 44_100,
  sizeBytes: 300,
  lightCopy: false,
  createdAt: 1,
};

describe("parrotLibraryStatementsForOps", () => {
  it("@req PAR-FMT-01 only a change storing a song in parts takes a schema-10 library to schema 11", () => {
    const whole = createParrotOp("track_file.upsert", { file, chunks: [] }, meta);
    const split = createParrotOp("track_file.upsert", { file: { ...file, headerBytes: 100, sourceSizeBytes: 400, tagsObjectKey: "tf-1/tags" }, chunks: [] }, meta);
    const forWhole = parrotLibraryStatementsForOps(PARROT_LIBRARY_WHOLE_FILES_SCHEMA_VERSION, [whole]);
    const forSplit = parrotLibraryStatementsForOps(PARROT_LIBRARY_WHOLE_FILES_SCHEMA_VERSION, [whole, split]);
    console.log(T, "whole", forWhole, "split", forSplit);
    expect(forWhole).toEqual([]);
    expect(forSplit.at(-1)).toBe(`PRAGMA user_version = ${PARROT_LIBRARY_SCHEMA_VERSION}`);
    expect(parrotLibraryStatementsForOps(PARROT_LIBRARY_SCHEMA_VERSION, [split])).toEqual([]);
  });
});
