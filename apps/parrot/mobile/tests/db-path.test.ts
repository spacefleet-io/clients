/**
 * @test-id PARROT-MOBILE-DB-PATH-001
 * @level unit
 * @bugfix @regression-proof
 *
 * The library file's path was Android's only: `<DocumentDirectoryPath minus /files>/databases/<name>`. On the iPhone,
 * react-native-sqlite-storage keeps a `location: "default"` database in `Library/LocalDatabase` (its `nosync` folder),
 * so the path pointed at `Documents/databases/<name>`, a file that never exists: the library was never found again
 * after a restart, and the save backup copied nothing.
 */
import { describe, expect, it } from "vitest";
import { sqliteDefaultDbPath } from "../src/lib/dbPath";

describe("sqliteDefaultDbPath", () => {
  it("is the app's databases folder on Android", () => {
    const path = sqliteDefaultDbPath("android", { document: "/data/user/0/io.spacefleet.parrot/files", library: "" }, "parrot.library.sqlite");
    console.info("db path android", path);
    expect(path).toBe("/data/user/0/io.spacefleet.parrot/databases/parrot.library.sqlite");
  });

  it("is Library/LocalDatabase on the iPhone", () => {
    const app = "/var/mobile/Containers/Data/Application/ABC";
    const path = sqliteDefaultDbPath("ios", { document: `${app}/Documents`, library: `${app}/Library` }, "parrot.library.sqlite");
    console.info("db path ios", path);
    expect(path).toBe(`${app}/Library/LocalDatabase/parrot.library.sqlite`);
  });
});
