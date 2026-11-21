/**
 * @test-id PARROT-MOBILE-VAULT-COPY-001
 * @level unit (source scan)
 * @req PAR-COPY-01[parrot]
 * @req PAR-META-18[parrot]
 * @why Chris 2026-11-16: pictures and lyrics are fetched at import and kept in the user's vault; the app shows them from
 *   there, never by asking the metadata service while browsing or playing. On the phone and the TV the lookups live in
 *   the session's paced background passes (`state/session.tsx`), the edit dialog (`state/editLookups.ts`, user-asked:
 *   its lyrics and the autocomplete's `musicSuggest` as the user types, PAR-META-18) and the Lyrics views' own "Search
 *   again" button, whose lookup is `searchAgain` in the shared `state/useTrackLyrics.ts`. Before this, the Lyrics sheet
 *   looked a song up itself as soon as it showed it; this scan fails if any screen, TV page or state file reaches the
 *   metadata client again outside a button.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const TEST_ID = "PARROT-MOBILE-VAULT-COPY-001";
const log = (phase: string, detail: unknown = {}) => console.info(`[${TEST_ID}] phase=${phase}`, JSON.stringify(detail));

const SRC = join(__dirname, "../src");
const LOOKUP = /\b(lookupClient|musicCover|musicArtistImage|musicLyrics|musicAlbums|musicRecordings|musicSuggest)\b/g;
/** Where a lookup may run: the paced background passes and the user's edit dialog. */
const ALLOWED = new Set(["state/session.tsx", "state/editLookups.ts"]);

const walk = (at: string): string[] =>
  readdirSync(at).flatMap((name) => {
    const path = join(at, name);
    return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(name) ? [path] : [];
  });

/** The lyrics hook may look up only inside `searchAgain`, which the Lyrics views hand to their "Search again" button. */
const HOOK = "state/useTrackLyrics.ts";

describe(`${TEST_ID} the phone's and the TV's screens show only the library's copies`, () => {
  it("no screen, TV page or state file reaches the metadata client, except the Lyrics views' Search again button", () => {
    const files = [...walk(join(SRC, "screens")), ...walk(join(SRC, "state")), ...walk(join(SRC, "tv"))];
    log("arrange", { files: files.length });
    const sources = files.map((path) => ({ file: relative(SRC, path), source: readFileSync(path, "utf8") }));
    const hits = sources.flatMap(({ file, source }) =>
      [...source.matchAll(LOOKUP)].map((match) => ({ file, name: match[1]!, at: match.index!, source }))
    );
    log("scan", { hits: hits.map((hit) => `${hit.file}:${hit.name}`) });
    const outside = hits.filter((hit) => !ALLOWED.has(hit.file));
    const offending = outside.filter((hit) => {
      if (hit.file !== HOOK) return true;
      const start = hit.source.indexOf("const searchAgain = ");
      const end = hit.source.indexOf("\n  };", start);
      const isImport = hit.source.lastIndexOf("\n", hit.at) === hit.source.lastIndexOf("\nimport ", hit.at);
      return !isImport && !(hit.at > start && hit.at < end);
    });
    // Every view that takes `searchAgain` from the hook calls it from a button's onPress, never from an effect.
    const callers = sources.filter(({ source }) => /\{ view, searchAgain \} = useTrackLyrics\(/.test(source));
    const calls = callers.flatMap(({ file, source }) =>
      [...source.matchAll(/(?<![.\w])searchAgain\b(?! \} = useTrackLyrics)(?!:)/g)].map((match) => ({
        file,
        before: source.slice(Math.max(0, match.index! - 140), match.index!),
      }))
    );
    log("assert", { offending: offending.map((hit) => `${hit.file}:${hit.name}`), callers: callers.map((c) => c.file), calls: calls.length });
    expect(offending).toEqual([]);
    expect(callers.map((c) => c.file).sort()).toEqual(["screens/PlayerLyrics.tsx", "tv/TvLyricsPage.tsx"]);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.before).toMatch(/onPress=\{[^}]*$|onPress=\{\(\) => \{[\s\S]*$/);
  });
});
