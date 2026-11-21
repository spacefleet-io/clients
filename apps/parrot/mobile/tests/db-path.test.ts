/**
 * @test-id PARROT-MOBILE-DB-PATH-001
 * @level unit
 * @bugfix @regression-proof
 *
 * The library file's path was Android's only: `<DocumentDirectoryPath minus /files>/databases/<name>`. On the iPhone,
 * react-native-sqlite-storage keeps a `location: "default"` database in `Library/LocalDatabase` (its `nosync` folder),
 * so the path pointed at `Documents/databases/<name>`, a file that never exists: the library was never found again
 * after a restart, and the save backup copied nothing.
 *
 * On a real Apple TV an app may write only to `Library/Caches`: the library opened in `Library/LocalDatabase` failed
 * with "You don't have permission to save the file “LocalDatabase” in the folder “Library”" right after pairing
 * (the tvOS simulator allows the write). The Apple TV keeps it with `location: "Documents"`, which the patched plugin
 * maps to Caches on tvOS.
 */
import { describe, expect, it } from "vitest";
import { sqliteDb } from "../src/lib/dbPath";

const app = "/var/mobile/Containers/Data/Application/ABC";
const iosDirs = { document: `${app}/Documents`, library: `${app}/Library`, caches: `${app}/Library/Caches` };

describe("sqliteDb", () => {
  it("is the app's databases folder on Android", () => {
    const db = sqliteDb("android", false, { document: "/data/user/0/io.spacefleet.parrot/files", library: "", caches: "" }, "parrot.library.sqlite");
    console.info("db android", db);
    expect(db).toEqual({ location: "default", path: "/data/user/0/io.spacefleet.parrot/databases/parrot.library.sqlite" });
  });

  it("is the databases folder on Android TV too", () => {
    const db = sqliteDb("android", true, { document: "/data/user/0/io.spacefleet.parrot/files", library: "", caches: "/data/user/0/io.spacefleet.parrot/cache" }, "parrot.library.sqlite");
    console.info("db android tv", db);
    expect(db).toEqual({ location: "default", path: "/data/user/0/io.spacefleet.parrot/databases/parrot.library.sqlite" });
  });

  it("is Library/LocalDatabase on the iPhone", () => {
    const db = sqliteDb("ios", false, iosDirs, "parrot.library.sqlite");
    console.info("db ios", db);
    expect(db).toEqual({ location: "default", path: `${app}/Library/LocalDatabase/parrot.library.sqlite` });
  });

  it("is Library/Caches on the Apple TV, the one folder tvOS lets the app write", () => {
    const db = sqliteDb("ios", true, iosDirs, "parrot.library.sqlite");
    console.info("db tvos", db);
    expect(db).toEqual({ location: "Documents", path: `${app}/Library/Caches/parrot.library.sqlite` });
  });
});
