// Same as compiled-sqlite-entry.ts without registerBunSqlite(): documents the failure the registration fixes.
import { createOrm, openDatabase } from "../../src/db";

createOrm(openDatabase(":memory:"));
console.log("sqlite-ok");
