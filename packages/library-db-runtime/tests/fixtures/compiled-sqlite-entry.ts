// Entry for compiled-binary-sqlite.test.ts: a `bun build --compile` binary opening a library DB the
// way the packaged runtime does (registering bun's sqlite modules first, via the same guarded dynamic import).
import { createOrm, openDatabase } from "../../src/db";

if (typeof Bun !== "undefined") {
  (await import("../../src/bunSqlite")).registerBunSqlite();
}
const db = openDatabase(":memory:");
createOrm(db);
db.exec("create table t (x integer)");
console.log("sqlite-ok");
