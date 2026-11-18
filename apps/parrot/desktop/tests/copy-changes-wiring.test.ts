/**
 * @test-id PARROT-DESKTOP-COPY-CHANGES-001
 * @level unit (source read of the main process)
 * @req PAR-COPY-01[parrot]
 * Why: the refresh itself is covered in `packages/parrot-core/tests/copyChanges.test.ts`; this pins that the desktop
 * runs it at library sync (not while browsing), asks the one shared list (`musicCopyChanges`) and the album lookup by
 * id, stays above the ticket floor, rebases its ops on a library that moved on, and forgets its check at sign-out so a
 * new account starts from a first check. Source-read: the main process needs Electron to boot.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const T = "[copy-changes-wiring]";
const source = readFileSync(path.resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");
const body = (name: string) => {
  const start = source.indexOf(`const ${name} = `);
  const text = start < 0 ? "" : source.slice(start, source.indexOf("\n};\n", start) + 3);
  console.info(T, `${name}: ${text.length} chars`);
  return text;
};

describe("Parrot desktop: refresh through one list per copy", () => {
  it("runs the check at library load, with the shared list and the by-id album lookup", () => {
    console.info(T, "phase: library load starts the check");
    expect(body("loadLibrary")).toMatch(/autoCopyChanges\(\);/);
    console.info(T, "phase: the check asks the list and the album, above the ticket floor");
    const pass = body("autoCopyChanges");
    expect(pass).toContain("runParrotCopyChanges(");
    expect(pass).toContain(".musicCopyChanges(");
    expect(pass).toContain(".musicAlbums(");
    expect(pass).toContain("canSpend: aboveTicketFloor");
    expect(pass).toContain("rebaseParrotCopyRefreshOps(");
    expect(pass).toContain("signal: stop.signal");
  });

  it("stops the check and forgets it at sign-out", () => {
    console.info(T, "phase: sign-out");
    expect(body("stopLookup")).toContain("autoCopyChangesStop?.abort();");
    expect(body("resetToSignIn")).toMatch(/rmSync\(copyChangesCheckFile/);
  });
});

describe("Parrot desktop: background lookups and the ticket refill", () => {
  // @req META-ANON-02[parrot]
  it("starts the ticket refill when the library loads", () => {
    expect(body("loadLibrary")).toMatch(/startLookup\(\);/);
  });

  // @req META-ANON-13[parrot]
  // @req META-ANON-14[parrot]
  it("holds every background pass behind the random gate and sends the generic User-Agent", () => {
    console.info(T, "phase: the ticket floor waits for the background gate");
    expect(body("aboveTicketFloor")).toContain("await metadata.backgroundReady();");
    expect(source).toMatch(/userAgent: NEUTRAL_USER_AGENT/);
  });
});
