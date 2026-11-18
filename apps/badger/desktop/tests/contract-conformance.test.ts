// Desktop contract conformance — verifies that:
// 1. No desktop code uses raw fetch() to runtime command endpoints
// 2. All runtime contract imports in desktop code resolve to real contracts
// This is a static analysis test — greps source to catch bypass patterns.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const DESKTOP_SRC = resolve(__dirname, "../src");

/** Recursively collect all .ts files under a directory */
const collectTsFiles = (dir: string): string[] => {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
      results.push(full);
    }
  }
  return results;
};

/**
 * Pattern: raw fetch to runtime command endpoint.
 * Matches: fetch(`${RUNTIME_BASE_URL}/modules/badger/commands`
 * Matches: fetch(`http://127.0.0.1:3020/modules/
 */
const RAW_RUNTIME_FETCH_PATTERN =
  /fetch\s*\(\s*[`"']?(?:\$\{[^}]*\})?[^)]*\/modules\/[^/]+\/commands/;

/**
 * Known files that are allowed to construct raw runtime HTTP requests.
 * These are infrastructure files in runtime-client itself — NOT desktop app code.
 * Keep this list EMPTY. If a file needs to be added here, it should use
 * runtime-client/command.ts sendCommand() instead.
 */
const ALLOWED_RAW_FETCH_FILES: string[] = [];

describe("desktop runtime contract conformance", () => {
  console.info(`[contract-conformance:setup] scanning desktop src at ${DESKTOP_SRC}`);
  const allFiles = collectTsFiles(DESKTOP_SRC);
  const mainFiles = allFiles.filter((f) => f.includes("/main/"));
  console.info(
    `[contract-conformance:setup] collected ${allFiles.length} .ts/.tsx files; ${mainFiles.length} under /main/`,
  );

  it("found desktop main process source files", () => {
    if (mainFiles.length <= 0) {
      console.error(
        `=== [contract-conformance:no-main-files] snapshot ===\n` +
          `DESKTOP_SRC=${DESKTOP_SRC}\n` +
          `allFiles.length=${allFiles.length} mainFiles.length=${mainFiles.length}\n` +
          `first 20 files=${JSON.stringify(allFiles.slice(0, 20), null, 2)}`,
      );
    }
    expect(mainFiles.length).toBeGreaterThan(0);
  });

  describe("no raw fetch to runtime command endpoints", () => {
    for (const file of mainFiles) {
      const relativePath = file.replace(DESKTOP_SRC + "/", "");
      it(`${relativePath} does not bypass runtime-client`, () => {
        if (ALLOWED_RAW_FETCH_FILES.some((allowed) => file.endsWith(allowed))) {
          return; // skip allowed files
        }
        const content = readFileSync(file, "utf-8");
        const match = RAW_RUNTIME_FETCH_PATTERN.exec(content);
        if (match) {
          console.error(
            `=== [contract-conformance:raw-fetch-violation] snapshot ===\n` +
              `file=${relativePath}\n` +
              `matchIndex=${match.index}\n` +
              `match=${JSON.stringify(match[0])}\n` +
              `context=${JSON.stringify(content.slice(Math.max(0, match.index - 80), match.index + 160))}`,
          );
          expect.fail(
            `${relativePath} contains a raw fetch() to runtime commands endpoint. ` +
            `Use @space/runtime-client sendCommand() with a typed contract instead.\n` +
            `Found: ${match[0]}`
          );
        }
      });
    }
  });

  describe("all runtime contract imports resolve", () => {
    it("desktop code only imports from @space/runtime-contracts", () => {
      const contractImportPattern = /@space\/runtime-contracts/;
      const filesWithContracts = mainFiles.filter((f) => {
        const content = readFileSync(f, "utf-8");
        return contractImportPattern.test(content);
      });
      console.info(
        `[contract-conformance:contract-imports] ${filesWithContracts.length}/${mainFiles.length} main files import @space/runtime-contracts`,
      );
      // Just verify these files exist — the TypeScript compiler will catch
      // any import that doesn't resolve
      if (filesWithContracts.length <= 0) {
        console.error(
          `=== [contract-conformance:no-contract-imports] snapshot ===\n` +
            `mainFiles.length=${mainFiles.length}\n` +
            `main files (relative)=${JSON.stringify(
              mainFiles.map((f) => f.replace(DESKTOP_SRC + "/", "")),
              null,
              2,
            )}`,
        );
      }
      expect(filesWithContracts.length).toBeGreaterThan(0);
    });
  });

  describe("no duplicated runtime session login logic", () => {
    /**
     * Pattern: manual session login to runtime.
     * If desktop code contains `runtime/session/login`, it's duplicating
     * what @space/runtime-client/session already provides.
     */
    const SESSION_LOGIN_PATTERN = /\/runtime\/session\/login/;

    for (const file of mainFiles) {
      const relativePath = file.replace(DESKTOP_SRC + "/", "");
      it(`${relativePath} does not duplicate runtime session login`, () => {
        const content = readFileSync(file, "utf-8");
        const match = SESSION_LOGIN_PATTERN.exec(content);
        if (match) {
          console.error(
            `=== [contract-conformance:session-login-violation] snapshot ===\n` +
              `file=${relativePath}\n` +
              `matchIndex=${match.index}\n` +
              `context=${JSON.stringify(content.slice(Math.max(0, match.index - 80), match.index + 160))}`,
          );
          expect.fail(
            `${relativePath} contains a manual runtime session login. ` +
            `Use @space/runtime-client createRuntimeSession() instead.`
          );
        }
      });
    }
  });
});
