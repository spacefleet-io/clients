/**
 * @test-id PARROT-MOBILE-CLAIM-DB-PATH-001
 * @level unit
 * @bugfix @regression-proof
 *
 * A new account's key is claimed by publishing an empty library made in a throwaway SQLite file
 * (`parrot.claim.sqlite`, `claimAccountKey`). That file's path was Android's only (`<files minus /files>/databases/`),
 * so on the iPhone, where react-native-sqlite-storage keeps a `location: "default"` database in
 * `Library/LocalDatabase`, the claim read `Documents/databases/parrot.claim.sqlite`, a file that never exists: the
 * read failed, the new key was never kept, and the setup stayed on the key step after "Yes, I understand" (seen in
 * the Parrot iPhone UI test testNewAccountMakesKeyAndShowsEmptyLibrary). The SQLite plugin, the files and the publish
 * are replaced; the path choice and the claim's steps are the real code.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const APP = "/var/mobile/Containers/Data/Application/ABC";
const state = vi.hoisted(() => ({
  os: "ios",
  tv: false,
  // Where the SQLite plugin really writes a file, per platform and `location` (the patched plugin keeps a tvOS
  // "Documents" database in Caches).
  pluginDir: (location: string) =>
    state.os === "android"
      ? "/data/user/0/io.spacefleet.parrot/databases"
      : location === "Documents"
        ? state.tv
          ? "/var/mobile/Containers/Data/Application/ABC/Library/Caches"
          : "/var/mobile/Containers/Data/Application/ABC/Documents"
        : "/var/mobile/Containers/Data/Application/ABC/Library/LocalDatabase",
  written: new Set<string>(),
  reads: [] as string[],
  published: [] as Array<{ bytes: number; baseVersion: number }>,
}));
const log = (step: string, detail: unknown) => console.info(`[PARROT-MOBILE-CLAIM-DB-PATH-001] ${step}`, JSON.stringify(detail));

vi.mock("react-native-quick-crypto", async () => ({ default: await vi.importActual("node:crypto") }));
vi.mock("react-native", () => ({
  Image: { getSize: async () => ({ width: 0, height: 0 }) },
  Platform: {
    get OS() {
      return state.os;
    },
    get isTV() {
      return state.tv;
    },
  },
}));
vi.mock("react-native-fs", () => ({
  default: {
    get DocumentDirectoryPath() {
      return state.os === "ios" ? "/var/mobile/Containers/Data/Application/ABC/Documents" : "/data/user/0/io.spacefleet.parrot/files";
    },
    LibraryDirectoryPath: "/var/mobile/Containers/Data/Application/ABC/Library",
    CachesDirectoryPath: "/var/mobile/Containers/Data/Application/ABC/Library/Caches",
    mkdir: async () => undefined,
    writeFile: async () => undefined,
    unlink: async () => undefined,
    exists: async (path: string) => state.written.has(path),
    // The file exists only where the plugin wrote it; anywhere else the read fails as on the phone.
    readFile: async (path: string) => {
      state.reads.push(path);
      if (!state.written.has(path)) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      return Buffer.from("SQLite format 3\0").toString("base64");
    },
  },
}));
vi.mock("react-native-sqlite-storage", () => ({
  default: {
    enablePromise: () => undefined,
    openDatabase: async ({ name, location }: { name: string; location: string }) => {
      state.written.add(`${state.pluginDir(location)}/${name}`);
      return { sqlBatch: async () => undefined, executeSql: async () => [{ rows: { length: 0, item: () => ({}) } }], close: async () => undefined };
    },
  },
}));
vi.mock("@bam.tech/react-native-image-resizer", () => ({ default: { createResizedImage: async () => ({ path: "" }) } }));
vi.mock("@space/shared/api", () => ({
  setApiBaseUrl: () => undefined,
  setApiClientType: () => undefined,
  setStorageTunnelOptions: () => undefined,
}));
vi.mock("@space/library-db-definition/snapshotPublish", () => ({
  publishLibrarySnapshotWith: async (bytes: Uint8Array, baseVersion: number) => {
    state.published.push({ bytes: bytes.length, baseVersion });
    return { version: 1 };
  },
}));

import { claimAccountKey } from "../src/lib/library";

describe("claiming a new account's key", () => {
  beforeEach(() => {
    state.written = new Set();
    state.reads = [];
    state.published = [];
  });

  it("publishes the empty library from Library/LocalDatabase on the iPhone", async () => {
    state.os = "ios";
    state.tv = false;
    const result = await claimAccountKey("token", "key").catch((err: Error) => ({ error: err.message }));
    log("ios claim", { result, reads: state.reads, written: [...state.written], published: state.published });
    expect(result).toEqual({ version: 1 });
    expect(state.reads).toEqual([`${APP}/Library/LocalDatabase/parrot.claim.sqlite`]);
    expect(state.published).toEqual([{ bytes: 16, baseVersion: 0 }]);
  });

  it("publishes the empty library from Library/Caches on the Apple TV", async () => {
    state.os = "ios";
    state.tv = true;
    const result = await claimAccountKey("token", "key").catch((err: Error) => ({ error: err.message }));
    log("tvos claim", { result, reads: state.reads, written: [...state.written], published: state.published });
    expect(result).toEqual({ version: 1 });
    expect(state.reads).toEqual([`${APP}/Library/Caches/parrot.claim.sqlite`]);
    expect(state.published).toEqual([{ bytes: 16, baseVersion: 0 }]);
  });

  it("still reads the app's databases folder on Android", async () => {
    state.os = "android";
    state.tv = false;
    const result = await claimAccountKey("token", "key").catch((err: Error) => ({ error: err.message }));
    log("android claim", { result, reads: state.reads, published: state.published });
    expect(result).toEqual({ version: 1 });
    expect(state.reads).toEqual(["/data/user/0/io.spacefleet.parrot/databases/parrot.claim.sqlite"]);
  });
});
