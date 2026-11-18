/**
 * @test-id LIB-DB-CLIENT-DELEGATION-001
 * @level unit (source-text inspection, no SQLite)
 * @why The library-db unification rests on a single SQL generator
 *   (`buildOpStatements` in ops.ts) feeding both desktop and mobile op-
 *   apply paths. A future refactor or merge could accidentally
 *   re-introduce hand-rolled SQL in either client's `applyLibraryOps`,
 *   silently splitting the implementations again — exactly the
 *   pre-unification failure mode this whole rollout exists to prevent.
 *
 *   This guard reads each client's libraryDb.ts and asserts:
 *   1. The file imports `buildOpStatements` from the shared package
 *      (`@space/library-db-definition` or `/ops` subpath).
 *   2. Within the body of `applyLibraryOps`, no raw INSERT/UPDATE/DELETE
 *      SQL strings appear — only the call to `buildOpStatements` and the
 *      result-dispatching machinery.
 *
 *   The check is intentionally narrow: it targets the wire-format op-
 *   apply path (`applyLibraryOps`). Direct-write helpers like
 *   `applyMediaCore` (called by local ingest flows on mobile) are NOT
 *   gated — they have a different lifecycle and may legitimately keep
 *   inline SQL.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const SUITE = "client-delegation-drift";

// Resolve from this test file's location to repo root, then to each client.
// The package layout is: <repo>/packages/library-db-definition/tests/<this>.test.ts
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

const DESKTOP_LIBRARY_DB = resolve(
  REPO_ROOT,
  "packages/library-db-runtime/src/libraryDb.ts"
);
const MOBILE_LIBRARY_DB = resolve(
  REPO_ROOT,
  "apps/badger/mobile/src/lib/libraryDb.ts"
);

/**
 * Slice out the body of `private async applyLibraryOps(...)` from a
 * source file. Returns null if the function can't be located — the test
 * will then fail with a meaningful diagnostic rather than silently
 * passing on an empty string.
 */
const extractApplyLibraryOpsBody = (source: string): string | null => {
  // Match either `private async applyLibraryOps` or `async applyLibraryOps`
  // (in case visibility changes). Capture from `{` after the param list to
  // the matching closing brace.
  const headerRe = /(?:private\s+)?async\s+applyLibraryOps\s*\([^)]*\)\s*\{/;
  const match = headerRe.exec(source);
  if (!match) return null;
  const start = match.index + match[0].length;
  let depth = 1;
  let i = start;
  let inString: '"' | "'" | "`" | null = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < source.length && depth > 0) {
    const ch = source[i]!;
    const next = source[i + 1] ?? "";
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
    } else if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
    } else if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === inString) {
        inString = null;
      }
    } else {
      if (ch === "/" && next === "/") {
        inLineComment = true;
        i++;
      } else if (ch === "/" && next === "*") {
        inBlockComment = true;
        i++;
      } else if (ch === '"' || ch === "'" || ch === "`") {
        inString = ch;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
      }
    }
    i++;
  }
  if (depth !== 0) return null;
  return source.slice(start, i - 1);
};

/**
 * Detect SQL keywords inside string literals — INSERT/UPDATE/DELETE that
 * look like hand-rolled mutations rather than logging or table-name
 * mentions in a comment-stripped function body. Whitelists DROP TABLE,
 * which would be a migration concern, not an op-apply concern.
 */
const findInlineMutationSql = (body: string): ReadonlyArray<string> => {
  const hits: string[] = [];
  // Look for the SQL verb at the start of a string literal — that's the
  // shape both desktop's pre-Phase-5.2 inline calls and mobile's pre-
  // Phase-5.3 inline calls had.
  const sqlInStringRe =
    /(["'`])\s*(INSERT\s+(?:OR\s+(?:REPLACE|IGNORE)\s+)?INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b[^"'`]*\1/gi;
  let m: RegExpExecArray | null;
  while ((m = sqlInStringRe.exec(body)) !== null) {
    hits.push(m[0]!.slice(0, 80));
  }
  return hits;
};

type DelegationContract = {
  client: string;
  path: string;
  sourceLength: number;
  bodyLength: number | null;
  imports: ReadonlyArray<string>;
  importsBuildOpStatements: boolean;
  inlineMutationHits: ReadonlyArray<string>;
  disallowedHits: ReadonlyArray<string>;
};

const inspectClient = (client: string, path: string): DelegationContract => {
  let source = "";
  try {
    source = readFileSync(path, "utf8");
  } catch {
    source = "";
  }
  const imports =
    source.match(/from\s+["']@space\/library-db-definition(?:\/ops)?["']/g) ?? [];
  const importsBuildOpStatements =
    imports.length > 0 && source.includes("buildOpStatements");
  const body = extractApplyLibraryOpsBody(source);
  const hits = body ? findInlineMutationSql(body) : [];
  const allowed = (sql: string): boolean =>
    /UPDATE\s+media_items\s+SET\s+has_files/i.test(sql);
  const disallowed = hits.filter((sql) => !allowed(sql));
  return {
    client,
    path,
    sourceLength: source.length,
    bodyLength: body === null ? null : body.length,
    imports,
    importsBuildOpStatements,
    inlineMutationHits: hits,
    disallowedHits: disallowed,
  };
};

const dumpDelegationSnapshot = (
  label: string,
  ctx: { contracts: ReadonlyArray<DelegationContract>; driftEntries?: ReadonlyArray<string>; note?: string },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.note) console.error(`note: ${ctx.note}`);
    const summarized = ctx.contracts.map((c) => ({
      client: c.client,
      path: c.path,
      sourceLength: c.sourceLength,
      bodyLength: c.bodyLength,
      imports: c.imports,
      importsBuildOpStatements: c.importsBuildOpStatements,
      inlineMutationHits: c.inlineMutationHits,
      disallowedHits: c.disallowedHits,
    }));
    console.error(`delegation contract per client:\n${JSON.stringify(summarized, null, 2)}`);
    if (ctx.driftEntries) {
      console.error(`drift entries:\n${JSON.stringify(ctx.driftEntries, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("client delegation drift guard", () => {
  console.info(`[${SUITE}:setup] desktop=${DESKTOP_LIBRARY_DB} mobile=${MOBILE_LIBRARY_DB}`);

  test("desktop's libraryDb.ts imports buildOpStatements from the shared package", () => {
    const contract = inspectClient("desktop", DESKTOP_LIBRARY_DB);
    console.info(
      `[${SUITE}:desktop-import] importsCount=${contract.imports.length} importsBuildOpStatements=${contract.importsBuildOpStatements}`,
    );
    try {
      expect(
        contract.importsBuildOpStatements,
        "desktop libraryDb.ts must import buildOpStatements from @space/library-db-definition",
      ).toBe(true);
    } catch (err) {
      dumpDelegationSnapshot("desktop-import-missing", { contracts: [contract] });
      throw err;
    }
  });

  test("mobile's libraryDb.ts imports buildOpStatements from the shared package", () => {
    const contract = inspectClient("mobile", MOBILE_LIBRARY_DB);
    console.info(
      `[${SUITE}:mobile-import] importsCount=${contract.imports.length} importsBuildOpStatements=${contract.importsBuildOpStatements}`,
    );
    try {
      expect(
        contract.importsBuildOpStatements,
        "mobile libraryDb.ts must import buildOpStatements from @space/library-db-definition",
      ).toBe(true);
    } catch (err) {
      dumpDelegationSnapshot("mobile-import-missing", { contracts: [contract] });
      throw err;
    }
  });

  test("desktop's applyLibraryOps delegates — only the documented has_files recompute may remain inline", () => {
    // Phase 3 follow-up (libraryDb.ts ~6095): a cross-group has_files
    // recompute lives inline because it spans the metadata DB (read
    // media_files) and the core DB (update media_items). The shared
    // builder is single-group-aware by design and can't express this
    // legacy attached-DB read. It's commented as net-neutral today.
    //
    // We allow exactly that one shape and assert nothing else slipped in.
    const contract = inspectClient("desktop", DESKTOP_LIBRARY_DB);
    console.info(
      `[${SUITE}:desktop-inline-check] hits=${contract.inlineMutationHits.length} disallowed=${contract.disallowedHits.length}`,
    );
    try {
      expect(contract.bodyLength, "could not locate `applyLibraryOps` in desktop libraryDb.ts").not.toBeNull();
      expect(
        contract.disallowedHits,
        "desktop applyLibraryOps contains inline mutation SQL beyond the documented has_files recompute — route through buildOpStatements",
      ).toEqual([]);
    } catch (err) {
      dumpDelegationSnapshot("desktop-inline-sql-drift", {
        contracts: [contract],
        driftEntries: contract.disallowedHits,
        note: "desktop applyLibraryOps must delegate through buildOpStatements (allow-listed: has_files recompute only)",
      });
      throw err;
    }
  });

  test("mobile's applyLibraryOps delegates — no inline INSERT/UPDATE/DELETE strings", () => {
    const contract = inspectClient("mobile", MOBILE_LIBRARY_DB);
    console.info(
      `[${SUITE}:mobile-inline-check] hits=${contract.inlineMutationHits.length}`,
    );
    try {
      expect(contract.bodyLength, "could not locate `applyLibraryOps` in mobile libraryDb.ts").not.toBeNull();
      expect(
        contract.inlineMutationHits,
        "mobile applyLibraryOps contains inline mutation SQL — should route through buildOpStatements",
      ).toEqual([]);
    } catch (err) {
      dumpDelegationSnapshot("mobile-inline-sql-drift", {
        contracts: [contract],
        driftEntries: contract.inlineMutationHits,
        note: "mobile applyLibraryOps must delegate through buildOpStatements (no allow-list)",
      });
      throw err;
    }
  });

  test("both clients reference buildOpStatements inside their applyLibraryOps body", () => {
    const contracts: DelegationContract[] = [];
    const drift: string[] = [];
    for (const [client, path] of [
      ["desktop", DESKTOP_LIBRARY_DB] as const,
      ["mobile", MOBILE_LIBRARY_DB] as const,
    ]) {
      const c = inspectClient(client, path);
      contracts.push(c);
      const source = readFileSync(path, "utf8");
      const body = extractApplyLibraryOpsBody(source);
      const calls = body?.includes("buildOpStatements") ?? false;
      console.info(`[${SUITE}:both-call-builder:${client}] calls-builder-in-body=${calls}`);
      if (!body) drift.push(`${client}: applyLibraryOps body not found`);
      else if (!calls) drift.push(`${client}: applyLibraryOps does not call buildOpStatements`);
    }
    try {
      for (const [client, path] of [
        ["desktop", DESKTOP_LIBRARY_DB] as const,
        ["mobile", MOBILE_LIBRARY_DB] as const,
      ]) {
        const source = readFileSync(path, "utf8");
        const body = extractApplyLibraryOpsBody(source);
        expect(body, `${client} applyLibraryOps body not found`).not.toBeNull();
        expect(
          body!.includes("buildOpStatements"),
          `${client} applyLibraryOps does not call buildOpStatements — drift introduced`,
        ).toBe(true);
      }
    } catch (err) {
      dumpDelegationSnapshot("both-clients-call-builder-violation", {
        contracts,
        driftEntries: drift,
        note: "both clients must invoke buildOpStatements inside applyLibraryOps body",
      });
      throw err;
    }
  });

  test("source-extraction helper's brace tracker handles strings + comments correctly", () => {
    // Self-test for the parser used above. If this fails, the lint above
    // could silently pass on a malformed extraction.
    const fixture = `
      class X {
        async applyLibraryOps(ops: any[]) {
          const sql = "} won't close"; // also } not closing
          /* } also commented */
          if (true) { return; }
          const tmpl = \`{ \${ops.length} }\`;
        }
      }
    `;
    const body = extractApplyLibraryOpsBody(fixture);
    console.info(`[${SUITE}:parser-self-test] body-extracted=${body !== null} length=${body?.length ?? "n/a"}`);
    try {
      expect(body).not.toBeNull();
      expect(body!).toContain("const sql = ");
      expect(body!).toContain("if (true) { return; }");
      expect(body!).toContain("const tmpl = ");
    } catch (err) {
      console.error(`=== [${SUITE}:parser-self-test-failed] fixture body extraction ===`);
      console.error(`extracted body=\n${body ?? "(null — parser failed)"}`);
      console.error(`fixture=\n${fixture}`);
      throw err;
    }
  });
});
