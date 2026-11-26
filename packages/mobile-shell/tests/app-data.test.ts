/**
 * @test-id MOBILE-SHELL-APP-DATA-001
 * @level unit
 * @bugfix @regression-proof
 * @covers packages/mobile-shell/src/appData.ts
 *
 * One copy of the Apple TV storage rule for Badger and Parrot (REL-FAM-05; it was `libraryStorage.ts` in Badger and
 * `dbPath.ts` in Parrot, formerly PARROT-MOBILE-DB-PATH-001).
 *
 * Parrot's library file path was Android's only: `<DocumentDirectoryPath minus /files>/databases/<name>`. On the
 * iPhone, react-native-sqlite-storage keeps a `location: "default"` database in `Library/LocalDatabase` (its `nosync`
 * folder), so the path pointed at `Documents/databases/<name>`, a file that never exists: the library was never found
 * again after a restart, and the save backup copied nothing.
 *
 * On a real Apple TV an app may write only to `Library/Caches`: the library opened in `Library/LocalDatabase` failed
 * with "You don't have permission to save the file “LocalDatabase” in the folder “Library”" right after pairing
 * (the tvOS simulator allows the write). The Apple TV keeps it with `location: "Documents"`, which the patched plugin
 * maps to Caches on tvOS.
 */
import { describe, expect, it } from "vitest";
import { appFilesDir, appSqliteDb } from "../src/appData";

const app = "/var/mobile/Containers/Data/Application/ABC";
const iosDirs = { document: `${app}/Documents`, library: `${app}/Library`, caches: `${app}/Library/Caches` };
const androidDirs = { document: "/data/user/0/io.spacefleet.parrot/files", library: "", caches: "/data/user/0/io.spacefleet.parrot/cache" };

describe("[MOBILE-SHELL-APP-DATA-001] appSqliteDb", () => {
  it("is the app's databases folder on Android, phone and TV, whatever the iPhone folder", () => {
    for (const isTV of [false, true]) {
      for (const iphone of ["documents", "localDatabase"] as const) {
        const db = appSqliteDb("android", isTV, androidDirs, "parrot.library.sqlite", iphone);
        console.info("db android", { isTV, iphone, db });
        expect(db).toEqual({ location: "default", path: "/data/user/0/io.spacefleet.parrot/databases/parrot.library.sqlite" });
      }
    }
  });

  it("is Library/LocalDatabase on Parrot's iPhone", () => {
    const db = appSqliteDb("ios", false, iosDirs, "parrot.library.sqlite", "localDatabase");
    console.info("db parrot ios", db);
    expect(db).toEqual({ location: "default", path: `${app}/Library/LocalDatabase/parrot.library.sqlite` });
  });

  it("is Documents on Badger's iPhone", () => {
    const db = appSqliteDb("ios", false, iosDirs, "library.core.sqlite", "documents");
    console.info("db badger ios", db);
    expect(db).toEqual({ location: "Documents", path: `${app}/Documents/library.core.sqlite` });
  });

  it("is Library/Caches on the Apple TV for both apps, the one folder tvOS lets an app write", () => {
    for (const iphone of ["documents", "localDatabase"] as const) {
      const db = appSqliteDb("ios", true, iosDirs, "library.core.sqlite", iphone);
      console.info("db tvos", { iphone, db });
      expect(db).toEqual({ location: "Documents", path: `${app}/Library/Caches/library.core.sqlite` });
    }
  });
});

describe("[MOBILE-SHELL-APP-DATA-001] appFilesDir", () => {
  it("is Caches on the Apple TV and Documents everywhere else", () => {
    const dirs = { tvos: appFilesDir("ios", true, iosDirs), ios: appFilesDir("ios", false, iosDirs), androidTv: appFilesDir("android", true, androidDirs) };
    console.info("files dir", dirs);
    expect(dirs).toEqual({ tvos: `${app}/Library/Caches`, ios: `${app}/Documents`, androidTv: androidDirs.document });
  });
});
