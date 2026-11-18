/**
 * Track-list fixture corpus for parity / regression tests.
 *
 * These fixtures are synthetic-but-thorough: every branch of both the JS
 * match rule (useMpvPlaybackEngine.ts:1513–1518) and the Lua match rule
 * (packages/mpv/resources/osc/sf.lua:13–32) is exercised.
 *
 * JS rule:
 *   t.type === "sub" &&
 *   (t["external-filename"] === url ||
 *     (t.lang === expectedLang && t.title === expectedTitle))
 *
 * Lua rule (subtitle_exists):
 *   if url and external_name == url then return true
 *   if title and track.title == title then
 *     if not lang or track.lang == lang then return true
 *
 * Key divergence pivot:
 *   A track with title === expectedTitle but lang !== expectedLang:
 *     - JS: NO match (requires both lang AND title)
 *     - Lua without lang param: MATCH  (title alone is sufficient when lang is nil)
 *     - Lua with lang param:    NO match (lang guard fails)
 */

export type MpvTrack = {
  id: number;
  type: string;
  "external-filename"?: string;
  lang?: string;
  title?: string;
  external?: boolean;
  selected?: boolean;
};

export type TrackListFixture = {
  /** Human-readable name for test output */
  name: string;
  tracks: MpvTrack[];
  query: {
    url?: string;
    expectedLang: string;
    expectedTitle: string;
  };
  /** id of the matching track, or null when nothing should match */
  jsExpected: number | null;
  /** Lua called with url + title + full lang — should subtitle_exists return true? */
  luaWithLang: boolean;
  /** Lua called with url + title + null lang — should subtitle_exists return true? */
  luaWithoutLang: boolean;
};

export const TRACK_LIST_CORPUS: TrackListFixture[] = [
  // 1. External sub — external-filename === url, full lang+title present.
  //    JS: match (external-filename branch). Lua: match (url branch).
  {
    name: "fixture-1: external-filename URL match, full lang+title present",
    tracks: [
      {
        id: 3,
        type: "sub",
        "external-filename": "/cache/french.srt",
        lang: "fr",
        title: "French",
        external: true,
      },
    ],
    query: {
      url: "/cache/french.srt",
      expectedLang: "fr",
      expectedTitle: "French",
    },
    jsExpected: 3,
    luaWithLang: true,
    luaWithoutLang: true,
  },

  // 2. External sub — no external-filename field, but lang === expectedLang && title === expectedTitle.
  //    JS: match (lang+title branch). Lua: match (title branch with lang).
  {
    name: "fixture-2: no external-filename, lang+title both match",
    tracks: [
      {
        id: 5,
        type: "sub",
        lang: "fr",
        title: "French",
        external: true,
      },
    ],
    query: {
      url: "/cache/french.srt",
      expectedLang: "fr",
      expectedTitle: "French",
    },
    jsExpected: 5,
    luaWithLang: true,
    luaWithoutLang: true,
  },

  // 3. External sub — title === expectedTitle but lang !== expectedLang.
  //    DIVERGENCE PIVOT:
  //      JS: NO match (requires BOTH lang and title)
  //      Lua without lang: MATCH (title alone suffices when lang param is nil)
  //      Lua with lang:    NO match (lang guard fails)
  {
    name: "fixture-3: title matches but lang differs — JS NO match, Lua(no-lang) MATCH",
    tracks: [
      {
        id: 7,
        type: "sub",
        lang: "de",       // German — does not match expectedLang "fr"
        title: "French",  // title matches
        external: true,
      },
    ],
    query: {
      url: "/cache/other.srt",
      expectedLang: "fr",
      expectedTitle: "French",
    },
    jsExpected: null,     // JS: no match (lang mismatch blocks the disjunction)
    luaWithLang: false,   // Lua with lang="fr": track.lang="de" fails guard
    luaWithoutLang: true, // Lua with lang=nil: title alone matches
  },

  // 4. External sub — lang === expectedLang but title !== expectedTitle.
  //    JS: no match (needs both). Lua: no match (needs title).
  {
    name: "fixture-4: lang matches but title differs — both NO match",
    tracks: [
      {
        id: 9,
        type: "sub",
        lang: "fr",
        title: "Subtitle (SDH)",  // different title
        external: true,
      },
    ],
    query: {
      url: "/cache/other.srt",
      expectedLang: "fr",
      expectedTitle: "French",
    },
    jsExpected: null,
    luaWithLang: false,
    luaWithoutLang: false,
  },

  // 5. External sub — lang === "und", title === expectedTitle, expectedLang "und".
  //    JS: match (lang "und" === "und" AND title matches). Lua: match.
  {
    name: "fixture-5: lang=und, title matches, expectedLang=und — both match",
    tracks: [
      {
        id: 11,
        type: "sub",
        lang: "und",
        title: "Custom Subtitle",
        external: true,
      },
    ],
    query: {
      url: "/cache/custom.srt",
      expectedLang: "und",
      expectedTitle: "Custom Subtitle",
    },
    jsExpected: 11,
    luaWithLang: true,
    luaWithoutLang: true,
  },

  // 6. Embedded sub — external: false, all fields present.
  //    JS: no match (external-filename check won't match, and even if lang+title
  //        match, the type=sub filter still admits it — the JS rule does NOT filter
  //        on external. So we record what actually happens: JS DOES match on lang+title
  //        even for embedded subs. Lua: match (same reason — subtitle_exists checks
  //        type=sub but not external flag).
  //    NOTE: This fixture documents that BOTH JS and Lua would match an embedded sub
  //          if its lang+title match — the caller (applyExternalSubtitle) is expected
  //          to filter externals separately. The fixture records current behavior.
  {
    name: "fixture-6: embedded sub, lang+title match — JS matches (no external guard in find), Lua matches",
    tracks: [
      {
        id: 13,
        type: "sub",
        lang: "en",
        title: "English",
        external: false,
      },
    ],
    query: {
      url: "/cache/english.srt",  // url won't match external-filename (field absent)
      expectedLang: "en",
      expectedTitle: "English",
    },
    jsExpected: 13,     // JS find() has no external guard — it matches on lang+title
    luaWithLang: true,  // Lua also has no external guard
    luaWithoutLang: true,
  },

  // 7. "off" branch — no url provided, blank expectedTitle/expectedLang.
  //    JS rule: t["external-filename"] === url compares undefined === undefined
  //    which is TRUE — JS matches on the external-filename branch even though
  //    neither side has a real value. The track IS returned by find().
  //    Lua rule: `if url and ...` — url param is null/falsy, so the url branch
  //    is skipped. Title param is empty/null so the title branch is also skipped.
  //    Result: JS matches (external-filename undefined === undefined), Lua does not.
  //    This is a known JS/Lua divergence for the "off" scenario — the engine
  //    guards this case upstream (selectedSubtitleId === "off" branch at line 1453).
  {
    name: "fixture-7: off branch — undefined url matches undefined external-filename in JS, Lua skips",
    tracks: [
      {
        id: 15,
        type: "sub",
        lang: "fr",
        title: "French",
        external: true,
        // no "external-filename" field → value is undefined
      },
    ],
    query: {
      url: undefined,   // undefined === undefined is true in JS
      expectedLang: "",
      expectedTitle: "",
    },
    jsExpected: 15,     // JS: external-filename (undefined) === url (undefined) → match
    luaWithLang: false, // Lua: url param is null → url branch skipped; title is "" → title branch skipped
    luaWithoutLang: false,
  },

  // 8. Multiple subs, only one matches (lang+title).
  //    Ensures the find() returns the first match and not all candidates.
  {
    name: "fixture-8: multiple subs, only one matches lang+title",
    tracks: [
      {
        id: 20,
        type: "sub",
        lang: "de",
        title: "German",
        external: true,
      },
      {
        id: 21,
        type: "sub",
        lang: "fr",
        title: "French",
        external: true,
      },
      {
        id: 22,
        type: "sub",
        lang: "zh",
        title: "Chinese",
        external: true,
      },
    ],
    query: {
      url: "/cache/none.srt",
      expectedLang: "fr",
      expectedTitle: "French",
    },
    jsExpected: 21,
    luaWithLang: true,
    luaWithoutLang: true,
  },
];
