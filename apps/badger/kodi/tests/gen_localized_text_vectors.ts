// Generates tests/localized_text_vectors.json from the TypeScript reference (`@space/shared/localizedTexts`, LIB-LANG-02):
// the Kodi add-on (tests/test_localized_texts.py) and the Jellyfin service (sidecar tests/localized-texts.test.ts) check
// their kept-text rows against these, so every app reads and writes the same row.
// Run from the repo root: bun apps/badger/kodi/tests/gen_localized_text_vectors.ts
import { writeFileSync } from "node:fs";
import {
  localizedTextKey,
  parseLocalizedText,
  serializeLocalizedText,
  type LocalizedTextRecord,
} from "../../../../packages/shared/src/localizedTexts";

const records: LocalizedTextRecord[] = [
  {
    overview: "Un été à Paris — « quotes », \"double\", tab\tand\nnewline 🎬",
    episodes: [
      { seasonNumber: 1, episodeNumber: 1, name: "L'hiver vient", overview: "Première partie." },
      { seasonNumber: 1, episodeNumber: 2, name: null, overview: null },
      { seasonNumber: 0, episodeNumber: 3, name: "Spécial", overview: null },
    ],
    absent: ["2:1", "2:2"],
    fetchedAt: "2026-11-16T10:00:00.000Z",
  },
  { overview: null, episodes: [], absent: [], fetchedAt: "2026-11-16T10:00:00.000Z" },
  { overview: "Control \u0001 char and \u2028 separator", episodes: [], absent: [], fetchedAt: "" },
];

const parseInputs = [
  "",
  "{",
  "null",
  "5",
  "[]",
  '"text"',
  '{"v":2,"overview":"x","episodes":[],"absent":[],"fetchedAt":"t"}',
  '{"v":1,"overview":"x","episodes":{},"absent":[],"fetchedAt":"t"}',
  '{"v":1,"overview":"x"}',
  '{"v":1,"overview":"  ","episodes":[[1,1,"  ","ok"],["1",2,"a","b"],[true,3,"c","d"],[1,4],"x",[2,5,7,null]],"absent":["1:9",3,null],"fetchedAt":5}',
  '{"v":1,"overview":"Résumé","episodes":[[1,1,"Nom","Synopsis"]]}',
  serializeLocalizedText(records[0]),
];

writeFileSync(
  new URL("./localized_text_vectors.json", import.meta.url),
  JSON.stringify(
    {
      keys: [
        { type: "tv", tmdbId: 1399, language: "fr", key: localizedTextKey("tv", 1399, "fr") },
        { type: "movie", tmdbId: 27205, language: "en", key: localizedTextKey("movie", 27205, "en") },
      ],
      serialize: records.map((record) => ({ record, value: serializeLocalizedText(record) })),
      parse: parseInputs.map((value) => ({ value, record: parseLocalizedText(value) })),
    },
    null,
    2
  ) + "\n"
);
