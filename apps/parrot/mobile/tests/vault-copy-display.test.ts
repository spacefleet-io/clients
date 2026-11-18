/**
 * @test-id PARROT-MOBILE-VAULT-COPY-001
 * @level unit (source scan)
 * @req PAR-COPY-01[parrot]
 * @why Chris 2026-11-16: pictures and lyrics are fetched at import and kept in the user's vault; the app shows them from
 *   there, never by asking the metadata service while browsing or playing. On the phone the lookups live in the
 *   session's paced background passes (`state/session.tsx`), the edit dialog (`state/editLookups.ts`, user-asked) and
 *   the Lyrics sheet's own "Search again" button. Before this, the Lyrics sheet looked a song up itself as soon as it
 *   showed it; this scan fails if any screen or other state file reaches the metadata client again outside a button.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const TEST_ID = "PARROT-MOBILE-VAULT-COPY-001";
const log = (phase: string, detail: unknown = {}) => console.info(`[${TEST_ID}] phase=${phase}`, JSON.stringify(detail));

const SRC = join(__dirname, "../src");
const LOOKUP = /\b(lookupClient|musicCover|musicArtistImage|musicLyrics|musicAlbums|musicRecordings|fetchMetadata)\b/g;
/** Where a lookup may run: the paced background passes and the user's edit dialog. */
const ALLOWED = new Set(["state/session.tsx", "state/editLookups.ts"]);

const walk = (at: string): string[] =>
  readdirSync(at).flatMap((name) => {
    const path = join(at, name);
    return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(name) ? [path] : [];
  });

describe(`${TEST_ID} the phone's screens show only the library's copies`, () => {
  it("no screen or state file reaches the metadata client, except the Lyrics sheet's Search again button", () => {
    const files = [...walk(join(SRC, "screens")), ...walk(join(SRC, "state"))];
    log("arrange", { files: files.length });
    const hits = files.flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return [...source.matchAll(LOOKUP)].map((match) => ({ file: relative(SRC, path), name: match[1]!, at: match.index!, source }));
    });
    log("scan", { hits: hits.map((hit) => `${hit.file}:${hit.name}`) });
    const outside = hits.filter((hit) => !ALLOWED.has(hit.file));
    // The Lyrics sheet may look up only inside `fetchNow`, the handler of its "Search again" button.
    const offending = outside.filter((hit) => {
      if (hit.file !== "screens/PlayerLyrics.tsx") return true;
      const start = hit.source.indexOf("const fetchNow = ");
      const end = hit.source.indexOf("\n  };", start);
      const isImport = hit.source.lastIndexOf("\n", hit.at) === hit.source.lastIndexOf("\nimport ", hit.at);
      return !isImport && !(hit.at > start && hit.at < end);
    });
    const lyrics = readFileSync(join(SRC, "screens/PlayerLyrics.tsx"), "utf8");
    const fetchNowUses = [...lyrics.matchAll(/\bfetchNow\b/g)].map((match) => lyrics.slice(Math.max(0, match.index! - 30), match.index! + 10));
    log("assert", { offending: offending.map((hit) => `${hit.file}:${hit.name}`), fetchNowUses });
    expect(offending).toEqual([]);
    // Declared once, used once: as the button's onPress, never from an effect.
    expect(fetchNowUses).toHaveLength(2);
    expect(fetchNowUses[1]).toContain("onPress={fetchNow");
  });
});
