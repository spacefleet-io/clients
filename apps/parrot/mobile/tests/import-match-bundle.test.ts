/**
 * @test-id PARROT-MOBILE-IMPORT-MATCH-BUNDLE-001
 * @level unit
 * @why The phone bundles `@space/parrot-core`'s import matching through its own babel config, which rewrites Unicode
 *   property regexes (`\p{M}`, `\p{L}`) into plain character classes. Two copies of `regenerate` in the install (1.4.2
 *   under `regenerate-unicode-properties`, 1.5.0 under `regexpu-core`) made that rewrite crash with
 *   "symbol.charCodeAt is not a function", so Metro could not bundle Parrot at all.
 * @bugfix @regression-proof The root `overrides` pins one `regenerate`; this test transforms the real file with the
 *   phone's babel config and checks the rewritten code pairs titles exactly like the source does.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
// @babel/core ships no types and the install has no @types/babel__core: name the one call this test makes.
// @ts-expect-error TS7016, @babel/core has no declaration file.
import { transformSync as untypedTransformSync } from "@babel/core";
import { describe, expect, it } from "vitest";
import type { MusicAlbum } from "@space/shared/api";
import * as source from "../../../../packages/parrot-core/src/importMatch";

const appRoot = join(__dirname, "..");
const file = join(appRoot, "../../../packages/parrot-core/src/importMatch.ts");
const transformSync = untypedTransformSync as (code: string, options: Record<string, unknown>) => { code?: string | null } | null;

const bundled = (): typeof source => {
  const out = transformSync(readFileSync(file, "utf8"), { filename: file, cwd: appRoot, babelrc: false, configFile: join(appRoot, "babel.config.js") });
  const code = out?.code ?? "";
  console.info("[import-match-bundle] transformed", { bytes: code.length, keepsPropertyEscapes: /\\p\{/.test(code) });
  const module = { exports: {} as typeof source };
  new Function("module", "exports", "require", code)(module, module.exports, createRequire(join(appRoot, "package.json")));
  return module.exports;
};

const album = {
  tracks: [
    { title: "Été", number: 1, disc: 1 },
    { title: "Don't Look Back", number: 2, disc: 1 },
    { title: "Ça roule pour moi", number: 3, disc: 1 },
    { title: "東京 (Tokyo)", number: 4, disc: 1 },
    { title: "Мечта", number: 5, disc: 1 },
    { title: "Seven Lantern Army", number: 6, disc: 1 },
  ],
} as unknown as MusicAlbum;

const songs = [
  { file: "/m/a.flac", title: "ete", disc: 1, number: 9 },
  { file: "/m/b.flac", title: "dont look back!", disc: 1, number: 9 },
  { file: "/m/c.flac", title: "CA ROULE POUR MOI", disc: 1, number: 9 },
  { file: "/m/d.flac", title: "東京 tokyo", disc: 1, number: 9 },
  { file: "/m/e.flac", title: "мечта", disc: 1, number: 9 },
  { file: "/m/f.flac", title: "Seven-Lantern Army", disc: 1, number: 9 },
  { file: "/m/g.flac", title: "Bonus", disc: 1, number: 9 },
];

describe("parrot import matching in the phone bundle", () => {
  // @req REL-ENV-25[parrot]
  it("transforms with the phone's babel config and pairs titles exactly like the source", () => {
    const phone = bundled();
    const pairs = (m: typeof source) =>
      Object.fromEntries([...m.matchParrotImportTracks(songs, album)].map(([songFile, track]) => [songFile, track?.number ?? null]));
    const fromSource = pairs(source);
    const fromPhone = pairs(phone);
    console.info("[import-match-bundle] pairs", { fromSource, fromPhone });
    expect(fromSource).toEqual({ "/m/a.flac": 1, "/m/b.flac": 2, "/m/c.flac": 3, "/m/d.flac": 4, "/m/e.flac": 5, "/m/f.flac": 6, "/m/g.flac": null });
    expect(fromPhone).toEqual(fromSource);
  });
});
