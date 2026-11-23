/**
 * @test-id LIB-DB-OPS-WRITE-VERSION-001
 * @level unit (repository lint)
 * @why LIB-FMT-13: no app may raise an account to op stream 4 before the account is switched. The server raises an
 *   account to whatever a full copy or change declares (LIB-FMT-05), so a single writer declaring 4 early locks every
 *   older app out, irreversibly for users. Writers declare `OP_STREAM_VERSION` (3) and only a writer migrated to v4
 *   declares through `writeOpStreamVersion(targetOpStreamVersion)`. This suite fails when any app or package source:
 *   - uses `READ_OP_STREAM_VERSION` other than in a comparison, an import/export, or a line marked `op-stream: read`
 *     (the `x-library-op-stream-version` header on library READS);
 *   - declares a literal 4 as an op stream version (TS, Kotlin, Swift, Python).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OP_STREAM_VERSION, READ_OP_STREAM_VERSION, writeOpStreamVersion } from "../src/ops";

const SUITE = "op-stream-write-version";
const repoRoot = join(__dirname, "../../..");

const sourceFiles = execFileSync("git", ["ls-files", "apps", "packages"], { cwd: repoRoot, encoding: "utf8" })
  .split("\n")
  .filter((path) => /\.(ts|tsx|kt|swift|py)$/.test(path))
  .filter((path) => !/(^|\/)(tests?|__tests__|e2e|androidTest|test-vectors)\//.test(path))
  .filter((path) => !/\.(test|spec)\.tsx?$/.test(path) && !/Tests?\.(kt|swift)$/.test(path) && !/(^|\/)test_[^/]*\.py$/.test(path))
  .filter((path) => path !== "packages/library-db-definition/src/ops.ts");

const LITERAL_FOUR = [
  /opStreamVersion\s*[:=]\s*4\b/,
  /op_stream_version\s*[:=]\s*4\b/i,
  /x-library-op-stream-version["']?\s*[:,]\s*(String\()?["']?4\b/i,
];

describe("op stream write version (LIB-FMT-13)", () => {
  it("writes 3 until the account is switched, 4 only after", () => {
    console.info(`[${SUITE}] OP_STREAM_VERSION=${OP_STREAM_VERSION} READ_OP_STREAM_VERSION=${READ_OP_STREAM_VERSION}`);
    expect(OP_STREAM_VERSION).toBe(3);
    expect(READ_OP_STREAM_VERSION).toBe(4);
    expect(writeOpStreamVersion(undefined)).toBe(3);
    expect(writeOpStreamVersion(null)).toBe(3);
    expect(writeOpStreamVersion(3)).toBe(3);
    expect(writeOpStreamVersion(4)).toBe(4);
    expect(writeOpStreamVersion(5)).toBe(4);
  });

  it("no source declares op stream 4 except through writeOpStreamVersion", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles) {
      const text = readFileSync(join(repoRoot, path), "utf8");
      if (!text.includes("READ_OP_STREAM_VERSION") && !/stream[-_]?version/i.test(text)) continue;
      text.split("\n").forEach((line, index) => {
        const where = `${path}:${index + 1}: ${line.trim()}`;
        if (line.includes("READ_OP_STREAM_VERSION")) {
          const allowed =
            /^\s*(import|export)\b/.test(line) ||
            /^\s*(READ_OP_STREAM_VERSION|type\b)/.test(line) ||
            /(<=?|>=?|===|!==)\s*READ_OP_STREAM_VERSION|READ_OP_STREAM_VERSION\s*(<=?|>=?|===|!==)/.test(line) ||
            line.includes("op-stream: read");
          if (!allowed) offenders.push(where);
        }
        if (LITERAL_FOUR.some((pattern) => pattern.test(line))) offenders.push(where);
      });
    }
    console.info(`[${SUITE}] scanned ${sourceFiles.length} files; offenders=${JSON.stringify(offenders, null, 2)}`);
    expect(sourceFiles.length).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});
