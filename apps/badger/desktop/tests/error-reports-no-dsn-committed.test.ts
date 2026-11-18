/**
 * REL-LOG-06: the reporting address (DSN) is a build-time secret and never lives in the source tree.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const P = "[error-reports-no-dsn]";
const APP = resolve(__dirname, "..");
const SRC = join(APP, "src");

// A Sentry-style DSN: scheme://<public key>@<host>/<project id>.
const DSN_LIKE = /https?:\/\/[0-9a-f]{16,}@|https?:\/\/[^\s/"'`@]+@[^\s/"'`]+\/\d+/;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

describe("@req REL-LOG-06[badger-desktop] no reporting address is committed", () => {
  it("no source file holds a DSN-looking string", () => {
    const files = walk(SRC).filter((f) => /\.(ts|tsx|js|mjs|json|html)$/.test(f));
    console.info(`${P} scanned ${files.length} files under ${SRC}`);
    expect(files.length).toBeGreaterThan(50);
    const hits = files.filter((f) => DSN_LIKE.test(readFileSync(f, "utf8")));
    console.info(`${P} hits=${JSON.stringify(hits)}`);
    expect(hits).toEqual([]);
  });

  it("the build reads the address from SF_BUGSINK_DSN_BADGER_DESKTOP and holds no literal", () => {
    const config = readFileSync(join(APP, "electron.vite.config.ts"), "utf8");
    expect(config).toContain("process.env.SF_BUGSINK_DSN_BADGER_DESKTOP");
    expect(DSN_LIKE.test(config)).toBe(false);
    console.info(`${P} electron.vite.config.ts reads the env var, no literal`);
  });
});
