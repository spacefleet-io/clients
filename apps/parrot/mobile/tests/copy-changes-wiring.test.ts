/**
 * @test-id PARROT-MOBILE-COPY-CHANGES-001
 * @level unit (source read)
 * @req PAR-COPY-01[parrot]
 * @why The refresh itself is covered in `packages/parrot-core/tests/copyChanges.test.ts`; this pins that the phone runs
 *   it when the server's library opens (not while browsing), asks the one shared list (`musicCopyChanges`) and the
 *   album lookup by id, stays above the ticket floor, saves through its queue planned again on a library that moved
 *   on, and forgets its check with the library at sign-out, so a new account starts from a first check.
 * @covers apps/parrot/mobile/src/lib/library.ts apps/parrot/mobile/src/state/session.tsx
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const T = "[PARROT-MOBILE-COPY-CHANGES-001]";
const read = (rel: string) => {
  const source = readFileSync(path.resolve(import.meta.dirname, "../src", rel), "utf8");
  console.info(T, `read ${rel} (${source.length} chars)`);
  return source;
};
const block = (source: string, start: string) => {
  const at = source.indexOf(start);
  const text = at < 0 ? "" : source.slice(at, source.indexOf("\n};\n", at) + 3);
  console.info(T, `${start.trim()}: ${text.length} chars`);
  return text;
};

describe("Parrot phone: refresh through one list per copy", () => {
  const library = read("lib/library.ts");
  const session = read("state/session.tsx");

  it("runs the shared pass with the phone's save queue and memory", () => {
    console.info(T, "phase: the library module's pass");
    const pass = block(library, "export const autoRefreshCopyChanges = ");
    expect(pass).toContain("runParrotCopyChanges(");
    expect(pass).toContain("rebaseParrotCopyRefreshOps(");
    expect(pass).toContain("COPY_CHANGES_CHECK_KEY");
    console.info(T, "phase: the check is forgotten with the library");
    expect(block(library, "export const removeLibrary = ")).toContain("AsyncStorage.removeItem(COPY_CHANGES_CHECK_KEY)");
  });

  it("starts it when the server's library opens and stops it at sign-out", () => {
    console.info(T, "phase: session wiring");
    expect(session).toMatch(/startAutoCovers\(\);\n\s+startCopyChanges\(\);/);
    expect(session).toContain("changes: async (since) => (await lookupClient()).musicCopyChanges(since)");
    expect(session).toContain("albums: async (question) => (await lookupClient()).musicAlbums(question)");
    expect(session).toMatch(/autoRefreshCopyChanges\(\{[\s\S]*?canSpend: aboveTicketFloor/);
    expect(session).toMatch(/stopAutoCovers\(\);\n\s+stopCopyChanges\(\);/);
  });
});
