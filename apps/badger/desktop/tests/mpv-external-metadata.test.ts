/**
 * NOTE — Bug B (chapters-disappear-after-reload) test-layer analysis
 * =======================================================================
 *
 * @bugfix mpv-chapters-disappear-after-reload
 *
 * STATUS: FIXED. sf.lua now caches the last-sent chapters
 * (playback_state.cached_chapters) and re-applies them on `file-loaded` when
 * chapter-list is empty (mirroring cached_envelope_payload), and the renderer
 * sends CHAPTERS_JSON unconditionally (mpvExternalMetadata.ts) so that cache
 * stays coherent with the current file. Live reload-survival is covered by
 * "Test 8" (chapters survive a loadfile-replace reload) in
 * `apps/badger/desktop/e2e/playback-chapter-navigation.e2e.test.ts` — though
 * that raw-loadfile variant SKIPS under headless Xvfb (mpv `path` unusable), so
 * the hardening plan's Phase 0a (a selectFormat-driven reload) supersedes it as
 * the durable guard. The always-send behavior is unit-pinned in this file. The
 * analysis below is retained as the rationale for why live behavior needs an
 * E2E, not a unit test.
 *
 * Root cause (sf.lua): the `start-file` event handler unconditionally nils
 * `pending_chapters` (packages/mpv/resources/osc/sf.lua line ~756). The
 * renderer sends `sf-chapters-json` exactly ONCE at launch. On a SECOND
 * `start-file` (caused by a `loadfile replace` — e.g. the backdrop→HLS swap
 * or a quality reload), `pending_chapters` is nil so `ensure_chapters_applied`
 * is a no-op, and mpv's `chapter-list` becomes empty for the duration of that
 * playback session.  Skip-markers survive the same race via the
 * `cached_envelope_payload` re-apply on `file-loaded`; chapters have no
 * equivalent cache path.
 *
 * Why there is NO Vitest-layer reproduction for Bug B
 * -------------------------------------------------------
 * Expressing the reload sequence requires:
 *   1. A REAL mpv process launched with sf.lua loaded
 *      (`--script=packages/mpv/resources/osc/sf.lua` or loaded from the
 *      mpv config dir).
 *   2. Sending `sf-chapters-json` over the mpv IPC socket.
 *   3. Issuing `loadfile <url> replace` via IPC to trigger a second
 *      `start-file` event inside sf.lua.
 *   4. Reading back `chapter-list` via IPC and asserting it is non-empty
 *      and matches the originally sent chapters.
 *
 * Neither existing Vitest harness can do this:
 *
 * - `mpv-socket-ipc.test.ts` creates a MOCK Unix socket server that
 *   echoes commands back — it is not a real mpv process and cannot fire
 *   Lua `start-file` or `file-loaded` events. A `loadfile replace` sent
 *   to this mock has no effect on Lua state.
 *
 * - `mpv-external-metadata.test.ts` (this file) is pure unit-level:
 *   it only tests the JS-side payload builder
 *   (`buildExternalPlaybackMetadataPayload`), with no mpv process
 *   involved at all.
 *
 * - The integration tests in this `tests/` directory that DO spin a real
 *   mpv process (`playback-mpv.integration.test.ts`,
 *   `playback-e2e.integration.test.ts`) use `@playwright/test` (Electron
 *   E2E harness) and are excluded from the standard Vitest run by
 *   `vitest.config.ts` (`exclude: ["tests/\*\*\/\*.integration.test.ts"]`).
 *   They are not the right layer to add a new Vitest test.
 *
 * What the E2E test for Bug B must do
 * -------------------------------------------------------
 * The correct test layer is the Playwright E2E suite under
 * `apps/badger/desktop/e2e/`. This landed as "Test 8" in
 * `playback-chapter-navigation.e2e.test.ts` (Phase 0a adds a selectFormat-driven
 * variant that avoids the headless mpv-`path` limitation); the recipe is:
 *
 *   1. Ingest the `test-multi-chapter.mkv` fixture (with synthesized audio,
 *      same approach as `playback-chapter-navigation.e2e.test.ts:115-141`).
 *   2. Launch playback. Wait for `chapter-list` to be non-empty (≥ 1 entry)
 *      via `getMpvProperty(page, "chapter-list")` — confirms sf.lua applied
 *      chapters on first load.
 *   3. Issue a `loadfile replace` on the SAME URL to simulate the
 *      backdrop→HLS swap or quality-reload path:
 *        await page.evaluate(async (url) => {
 *          await window.sf?.sendExternalMpvCommand?.({
 *            command: ["loadfile", url, "replace"]
 *          });
 *        }, currentUrl);
 *      (The current URL is readable via getMpvProperty(page, "path").)
 *   4. Wait for a second `time-pos > 0` (playback resumed after reload).
 *   5. ASSERTION — `chapter-list` must still be non-empty after the reload:
 *        await expect.poll(
 *          async () => {
 *            const cl = await getMpvProperty(page, "chapter-list");
 *            return Array.isArray(cl) ? cl.length : 0;
 *          },
 *          { timeout: 5_000, intervals: [200] },
 *        ).toBeGreaterThan(0);
 *      Pre-fix: this assertion FAILS because `start-file` nils
 *      `pending_chapters` and the renderer never re-sends `sf-chapters-json`.
 *      Post-fix: chapters must survive the reload.
 *
 * The implemented fix mirrors the skip-markers approach:
 *   - sf.lua caches the parsed chapters in `playback_state.cached_chapters`
 *     (analogous to `cached_envelope_payload`), updated on every send.
 *   - In `file-loaded`, when `chapter-list` is empty and the cache has
 *     chapters, it re-applies them via `ensure_chapters_applied`.
 *   - The renderer sends CHAPTERS_JSON on every load (even empty) so the cache
 *     never goes stale across a same-process next-episode reload.
 *
 * @see packages/mpv/resources/osc/sf.lua lines 694-929 (chapter state),
 *      lines 746-770 (start-file handler, the wipe site),
 *      lines 796-825 (file-loaded, the fix site for skip-markers — model
 *      the chapters fix here).
 * @see apps/badger/desktop/e2e/playback-chapter-navigation.e2e.test.ts
 *      (existing chapter E2E harness to extend).
 */

import { describe, expect, it } from "vitest";

import {
  buildExternalMetadataCommands,
  buildExternalPlaybackMetadataPayload,
  oscMenuPrompts,
} from "../src/renderer/src/lib/mpvExternalMetadata";
import de from "../src/renderer/src/i18n/de.json";
import en from "../src/renderer/src/i18n/en.json";
import es from "../src/renderer/src/i18n/es.json";
import fr from "../src/renderer/src/i18n/fr.json";
import nl from "../src/renderer/src/i18n/nl.json";

// Dump-on-failure helper. The builder maps domain track/chapter/subtitle
// inputs into the mpv script-message payload; when an assertion about a
// title/label/flag is wrong, the single most useful artifact is the full
// computed payload (and, where relevant, the serialized command sequence).
// Wrapped in try/catch so a dump failure can never mask the real assertion.
const dumpMetadataSnapshot = (
  label: string,
  data: { payload?: unknown; commands?: unknown },
) => {
  try {
    console.error(`=== [mpv-external-metadata:${label}] payload snapshot ===`);
    if (data.payload !== undefined)
      console.error(`payload:\n${JSON.stringify(data.payload, null, 2)}`);
    if (data.commands !== undefined)
      console.error(`commands:\n${JSON.stringify(data.commands, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("mpv external metadata helpers", () => {
  it("@bugfix @regression-proof preserves distinct audio track labels in the mpv payload", () => {
    // Regression: audio tracks showed as "Audio" and "Audio" in mpv.
    // Verify that distinct labels survive through to the sf-audio-json payload sent to mpv.
    // Under the track display rule, a language-tagged track with a distinct
    // descriptor formats as "Language - descriptor". A redundant leading
    // language token in the label is stripped, so a track with
    // language="en" + label="English Dub" renders as "English - Dub", not
    // "English English Dub". Track A has label="Japanese" (== the language
    // name), so it renders as just "Japanese".
    const payload = buildExternalPlaybackMetadataPayload({
      subtitlesOffLabel: "Off",
      subtitles: [],
      chapters: [],
      audioOptions: [
        { id: "a1", label: "Japanese", language: "ja", isDefault: true, codec: "aac" },
        { id: "a2", label: "English Dub", language: "en", isDefault: false, codec: "aac" },
      ],
      skipMarkers: [],
      title: "",
      meta: "",
      previousEpisode: null,
      nextEpisode: null,
      autoplayNextEpisode: false,
      autoSkipIntro: false,
      autoSkipCredits: false,
    });

    console.info("[mpv-external-metadata:distinct-audio-labels] computed audio:", JSON.stringify(payload.audio));
    try {
      expect(payload.audio).toEqual([
        { title: "Japanese", label: "Japanese", lang: "ja" },
        { title: "English - Dub", label: "English - Dub", lang: "en" },
      ]);
      // Core regression assertion: neither track should fall back to generic "Audio".
      expect(payload.audio[0].title).not.toBe("Audio");
      expect(payload.audio[1].title).not.toBe("Audio");
    } catch (err) {
      dumpMetadataSnapshot("distinct-audio-labels", { payload });
      throw err;
    }
  });

  it("@bugfix @regression-proof falls back to language name when label is empty, not generic Audio or bare code", () => {
    // If the ingest pipeline produces tracks with empty labels but valid languages,
    // the metadata builder should use the localized language name as fallback —
    // not "Audio" (the original bug) and not just the bare 2-letter code.
    const payload = buildExternalPlaybackMetadataPayload({
      subtitlesOffLabel: "Off",
      subtitles: [],
      chapters: [],
      audioOptions: [
        { id: "a1", label: "", language: "ja", isDefault: true, codec: "aac" },
        { id: "a2", label: "", language: "en", isDefault: false, codec: "aac" },
      ],
      skipMarkers: [],
      title: "",
      meta: "",
      previousEpisode: null,
      nextEpisode: null,
      autoplayNextEpisode: false,
      autoSkipIntro: false,
      autoSkipCredits: false,
    });

    console.info("[mpv-external-metadata:empty-label-fallback] computed audio:", JSON.stringify(payload.audio));
    try {
      // Should use language NAME, not "Audio" and not just the code
      expect(payload.audio[0].title).toBe("Japanese");
      expect(payload.audio[0].label).toBe("Japanese");
      expect(payload.audio[1].title).toBe("English");
      expect(payload.audio[1].label).toBe("English");
      expect(payload.audio[0].title).not.toBe("Audio");
      expect(payload.audio[1].title).not.toBe("Audio");
    } catch (err) {
      dumpMetadataSnapshot("empty-label-fallback", { payload });
      throw err;
    }
  });

  it("@bugfix @regression-proof only falls back to Audio when both label and language are empty", () => {
    const payload = buildExternalPlaybackMetadataPayload({
      subtitlesOffLabel: "Off",
      subtitles: [],
      chapters: [],
      audioOptions: [
        { id: "a1", label: "", language: "", isDefault: true, codec: "aac" },
      ],
      skipMarkers: [],
      title: "",
      meta: "",
      previousEpisode: null,
      nextEpisode: null,
      autoplayNextEpisode: false,
      autoSkipIntro: false,
      autoSkipCredits: false,
    });

    console.info("[mpv-external-metadata:audio-only-when-empty] computed audio:", JSON.stringify(payload.audio));
    try {
      // Only acceptable to show "Audio" when there's truly no metadata
      expect(payload.audio[0].title).toBe("Audio");
      expect(payload.audio[0].label).toBe("Audio");
    } catch (err) {
      dumpMetadataSnapshot("audio-only-when-empty", { payload });
      throw err;
    }
  });

  it("builds playback metadata payloads from subtitles, chapters, audio, and skip markers", () => {
    const payload = buildExternalPlaybackMetadataPayload({
      subtitlesOffLabel: "Off",
      subtitles: [{ url: "https://example.com/sub.vtt", title: "English", lang: "en", format: "vtt" }],
      chapters: [{ title: "Cold Open", startSeconds: 12 }],
      audioOptions: [{ id: "en", label: "English", language: "en" }],
      skipMarkers: [{ type: "intro", startSeconds: 10, endSeconds: 45 }],
      title: "",
      meta: "",
      previousEpisode: null,
      nextEpisode: { id: "ep-2", label: "S01E02" },
      autoplayNextEpisode: true,
      autoSkipIntro: false,
      autoSkipCredits: false,
    });

    try {
      expect(payload).toMatchObject({
        subtitles: [{ url: "https://example.com/sub.vtt", title: "English", lang: "en", format: "vtt" }],
        chapters: [{ title: "Cold Open", startSeconds: 12, endSeconds: null, orderIndex: 0 }],
        audio: [{ title: "English", label: "English", lang: "en" }],
        playback: {
          markers: [{ type: "intro", startSeconds: 10, endSeconds: 45 }],
          nextEpisode: { id: "ep-2", label: "S01E02" },
          autoplayNextEpisode: true,
          fallbackCountdownSeconds: 15,
        },
      });
    } catch (err) {
      dumpMetadataSnapshot("full-payload-shape", { payload });
      throw err;
    }
  });

  // @req PLAY-OVL-01[badger-desktop]
  // @req PLAY-OVL-03[badger-desktop]
  it("carries the what's-playing title and the previous playable episode to sf.lua (sf-playback-json)", () => {
    const payload = buildExternalPlaybackMetadataPayload({
      subtitlesOffLabel: "Off",
      subtitles: [],
      chapters: [],
      audioOptions: [],
      skipMarkers: [],
      title: "Lodgers",
      meta: "S1 · E2 “The Lodger with the Sealed Letter” · 1994",
      previousEpisode: { id: "ep-1", label: "S01E01" },
      nextEpisode: { id: "ep-3", label: "S01E03" },
      autoplayNextEpisode: true,
      autoSkipIntro: false,
      autoSkipCredits: false,
    });
    const playbackCommand = buildExternalMetadataCommands(payload).find((entry) => entry.command[1] === "sf-playback-json");
    const sent = JSON.parse(String(playbackCommand?.command[2] ?? "null"));
    console.info(`[mpv-external-metadata:title-prev] sf-playback-json=${JSON.stringify(sent)}`);
    try {
      expect(sent).toMatchObject({
        title: "Lodgers",
        meta: "S1 · E2 “The Lodger with the Sealed Letter” · 1994",
        previousEpisode: { id: "ep-1", label: "S01E01" },
        nextEpisode: { id: "ep-3", label: "S01E03" },
      });
    } catch (err) {
      dumpMetadataSnapshot("title-prev", { payload });
      throw err;
    }
  });

  it("serializes external metadata into the expected mpv script-message command sequence", () => {
    const commands = buildExternalMetadataCommands(
      buildExternalPlaybackMetadataPayload({
        subtitlesOffLabel: "Off",
        subtitles: [{ url: "https://example.com/sub.vtt", title: "English", lang: "en" }],
        chapters: [{ title: "Chapter 1", startSeconds: 0 }],
        audioOptions: [{ id: "en", label: "English", language: "en" }],
        skipMarkers: [],
        title: "",
        meta: "",
        previousEpisode: null,
        nextEpisode: null,
        autoplayNextEpisode: false,
        autoSkipIntro: false,
        autoSkipCredits: false,
      })
    );

    const channels = commands.map((entry) => entry.command[1]);
    console.info("[mpv-external-metadata:command-sequence] emitted channels:", JSON.stringify(channels));
    try {
      expect(channels).toEqual([
        "sf-subtitles-json",
        "sf-chapters-json",
        "sf-audio-json",
        "sf-labels-json",
        "sf-playback-json",
      ]);
    } catch (err) {
      dumpMetadataSnapshot("command-sequence", { commands });
      throw err;
    }
  });

  it("@bugfix @regression-proof sends the UI-language subtitle Off label to the OSC menu (#25 subs-off)", () => {
    // The OSC subtitle menu gets an "Off" row (sf-select.lua). Its label is the
    // app's i18n `player.subtitlesOff` ("Off" / "Aucun"), pushed on sf-labels-json
    // with EVERY metadata send, audio-less media included.
    const commands = buildExternalMetadataCommands(
      buildExternalPlaybackMetadataPayload({
        subtitlesOffLabel: "Aucun",
        subtitles: [],
        chapters: [],
        audioOptions: [],
        skipMarkers: [],
        title: "",
        meta: "",
        previousEpisode: null,
        nextEpisode: null,
        autoplayNextEpisode: false,
        autoSkipIntro: false,
        autoSkipCredits: false,
      })
    );
    const labels = commands.find((entry) => entry.command[1] === "sf-labels-json");
    console.info("[mpv-external-metadata:labels] labels command:", JSON.stringify(labels ?? null));
    try {
      expect(labels).toBeDefined();
      expect(JSON.parse(labels!.command[2] as string)).toEqual({ subtitlesOff: "Aucun", getMoreSubtitles: "", tryAnotherVersion: "", addSubtitleFile: "" });
    } catch (err) {
      dumpMetadataSnapshot("labels-subtitles-off", { commands });
      throw err;
    }
  });

  // @req PLAY-SUBGET-02[badger-desktop]
  it("sends the subtitle menu's Get more subtitles… label when the media can be searched (PLAY-SUBGET-02)", () => {
    const commands = buildExternalMetadataCommands(
      buildExternalPlaybackMetadataPayload({
        subtitlesOffLabel: "Off",
        getMoreSubtitlesLabel: "Get more subtitles…",
        subtitles: [],
        chapters: [],
        audioOptions: [],
        skipMarkers: [],
        title: "",
        meta: "",
        previousEpisode: null,
        nextEpisode: null,
        autoplayNextEpisode: false,
        autoSkipIntro: false,
        autoSkipCredits: false,
      })
    );
    const labels = commands.find((entry) => entry.command[1] === "sf-labels-json");
    expect(JSON.parse(labels!.command[2] as string)).toEqual({
      subtitlesOff: "Off",
      getMoreSubtitles: "Get more subtitles…",
      tryAnotherVersion: "",
      addSubtitleFile: "",
    });
  });

  // @req PLAY-SUBGET-07[badger-desktop]
  it("sends the Try another version label while a fetched subtitle is on (PLAY-SUBGET-07)", () => {
    const commands = buildExternalMetadataCommands(
      buildExternalPlaybackMetadataPayload({
        subtitlesOffLabel: "Off",
        getMoreSubtitlesLabel: "Get more subtitles…",
        tryAnotherVersionLabel: "Try another version",
        subtitles: [],
        chapters: [],
        audioOptions: [],
        skipMarkers: [],
        title: "",
        meta: "",
        previousEpisode: null,
        nextEpisode: null,
        autoplayNextEpisode: false,
        autoSkipIntro: false,
        autoSkipCredits: false,
      })
    );
    const labels = commands.find((entry) => entry.command[1] === "sf-labels-json");
    console.info("[mpv-external-metadata:version-label]", labels?.command[2]);
    expect(JSON.parse(labels!.command[2] as string)).toEqual({
      subtitlesOff: "Off",
      getMoreSubtitles: "Get more subtitles…",
      tryAnotherVersion: "Try another version",
      addSubtitleFile: "",
    });
  });

  // @req PLAY-SUBGET-23[badger-desktop]
  it("sends the Add a subtitle file… label, the subtitle menu's last row (PLAY-SUBGET-23)", () => {
    const commands = buildExternalMetadataCommands(
      buildExternalPlaybackMetadataPayload({
        subtitlesOffLabel: "Off",
        getMoreSubtitlesLabel: "Get more subtitles…",
        addSubtitleFileLabel: "Add a subtitle file…",
        subtitles: [],
        chapters: [],
        audioOptions: [],
        skipMarkers: [],
        title: "",
        meta: "",
        previousEpisode: null,
        nextEpisode: null,
        autoplayNextEpisode: false,
        autoSkipIntro: false,
        autoSkipCredits: false,
      })
    );
    const labels = commands.find((entry) => entry.command[1] === "sf-labels-json");
    expect(JSON.parse(labels!.command[2] as string)).toEqual({
      subtitlesOff: "Off",
      getMoreSubtitles: "Get more subtitles…",
      tryAnotherVersion: "",
      addSubtitleFile: "Add a subtitle file…",
    });
  });

  // @bugfix badger-menu-headers-english @regression-proof
  it("sends the audio and subtitle menu prompts in the UI language, for all 5 languages (French UI showed \"Select an audio track:\")", () => {
    const locales = { en, fr, nl, de, es } as const;
    const prompts = Object.fromEntries(
      Object.entries(locales).map(([lang, json]) => {
        const player: Record<string, unknown> = json.player;
        return [lang, oscMenuPrompts((key) => String(player[key.replace(/^player\./, "")] ?? `MISSING ${key}`))];
      })
    );
    console.info("[mpv-external-metadata:menu-prompts]", JSON.stringify(prompts));
    for (const [lang, set] of Object.entries(prompts)) {
      for (const [key, text] of Object.entries(set)) {
        expect(text, `${lang} ${key}`).not.toMatch(/^MISSING|^$/);
        if (lang !== "en") expect(text, `${lang} ${key} is translated`).not.toBe(prompts.en[key as keyof typeof set]);
      }
    }
    const commands = buildExternalMetadataCommands(
      buildExternalPlaybackMetadataPayload({
        subtitlesOffLabel: "Aucun",
        menuPrompts: prompts.fr,
        subtitles: [],
        chapters: [],
        audioOptions: [],
        skipMarkers: [],
        title: "",
        meta: "",
        previousEpisode: null,
        nextEpisode: null,
        autoplayNextEpisode: false,
        autoSkipIntro: false,
        autoSkipCredits: false,
      })
    );
    const labels = JSON.parse(commands.find((entry) => entry.command[1] === "sf-labels-json")!.command[2] as string);
    expect(labels.selectAudioTrack).toBe("Choisir une piste audio\u202f:");
    expect(labels.selectSubtitle).toBe("Choisir des sous-titres\u202f:");
    expect(labels.subtitlesOff).toBe("Aucun");
  });

  // @req MPV-AUDIO-02[badger-desktop] @bugfix pc-no-sound-output-silently-dropped
  it("sends the audio notice's text in the UI language, for all 5 languages (the notice was English-only)", () => {
    const locales = { en, fr, nl, de, es } as const;
    const keys = ["audioRetry", "audioRetrying", "audioStallExplanation", "audioNoOutputExplanation", "audioOutputLabel"] as const;
    const texts = Object.fromEntries(
      Object.entries(locales).map(([lang, json]) => {
        const player: Record<string, unknown> = json.player;
        const prompts = oscMenuPrompts((key) => String(player[key.replace(/^player\./, "")] ?? `MISSING ${key}`));
        return [lang, Object.fromEntries(keys.map((key) => [key, (prompts as Record<string, string>)[key]]))];
      })
    );
    console.info("[mpv-external-metadata:audio-notice]", JSON.stringify(texts));
    for (const [lang, set] of Object.entries(texts)) {
      for (const key of keys) {
        expect(set[key], `${lang} ${key}`).toMatch(/\S/);
        expect(set[key], `${lang} ${key}`).not.toMatch(/^MISSING|^undefined$/);
        if (lang !== "en") expect(set[key], `${lang} ${key} is translated`).not.toBe(texts.en![key]);
      }
    }
    expect(texts.fr!.audioRetry).toBe("Réessayer avec le son");
  });

  it("@bugfix @regression-proof always emits sf-chapters-json even when chapters is empty (cache coherence for reload re-apply)", () => {
    // The chapters-disappear-after-reload fix relies on the renderer sending
    // CHAPTERS_JSON on EVERY load — including an empty list — so sf.lua's
    // cached_chapters stays coherent with the current file: a chapterless
    // episode following a chaptered one must send [] to CLEAR the cache rather
    // than leave the previous episode's chapters cached (which file-loaded
    // would otherwise re-apply). Pre-this-fix the builder only emitted
    // CHAPTERS_JSON when chapters.length > 0; this pins the unconditional send.
    // @bugfix mpv-chapters-disappear-after-reload
    const commands = buildExternalMetadataCommands(
      buildExternalPlaybackMetadataPayload({
        subtitlesOffLabel: "Off",
        subtitles: [],
        chapters: [],
        audioOptions: [],
        skipMarkers: [],
        title: "",
        meta: "",
        previousEpisode: null,
        nextEpisode: null,
        autoplayNextEpisode: false,
        autoSkipIntro: false,
        autoSkipCredits: false,
      })
    );
    const channels = commands.map((entry) => entry.command[1]);
    console.info("[chapters-always-send] emitted channels:", channels);
    try {
      expect(channels).toContain("sf-chapters-json");
      const chapterCmd = commands.find((entry) => entry.command[1] === "sf-chapters-json");
      expect(chapterCmd).toBeDefined();
      // Payload is the JSON-serialized (empty) chapter array.
      expect(JSON.parse(chapterCmd!.command[2])).toEqual([]);
    } catch (err) {
      dumpMetadataSnapshot("chapters-always-send", { commands });
      throw err;
    }
  });

  it("@bugfix @regression-proof always emits sf-subtitles-json even when subtitles is empty (cache coherence for reload re-apply)", () => {
    // sf.lua caches the last subtitle list and re-applies it on file-loaded
    // so subtitles survive a reload (#25 NEW-subs-lost-after-reload). A
    // subtitle-less next episode must therefore send [] to clear that cache,
    // or the previous episode's subtitles would be re-added to it. Pre-fix the
    // builder only emitted SUBTITLES_JSON when subtitles.length > 0.
    // @bugfix mpv-subtitles-lost-after-reload
    const commands = buildExternalMetadataCommands(
      buildExternalPlaybackMetadataPayload({
        subtitlesOffLabel: "Off",
        subtitles: [],
        chapters: [],
        audioOptions: [],
        skipMarkers: [],
        title: "",
        meta: "",
        previousEpisode: null,
        nextEpisode: null,
        autoplayNextEpisode: false,
        autoSkipIntro: false,
        autoSkipCredits: false,
      })
    );
    const channels = commands.map((entry) => entry.command[1]);
    console.info("[subtitles-always-send] emitted channels:", channels);
    try {
      const subCmd = commands.find((entry) => entry.command[1] === "sf-subtitles-json");
      expect(subCmd).toBeDefined();
      expect(JSON.parse(subCmd!.command[2])).toEqual([]);
      expect(channels).toEqual(["sf-subtitles-json", "sf-chapters-json", "sf-labels-json", "sf-playback-json"]);
    } catch (err) {
      dumpMetadataSnapshot("subtitles-always-send", { commands });
      throw err;
    }
  });

  it("@bugfix @regression-proof carries the `selected` flag through the subtitle payload and sf-subtitles-json command", () => {
    // Regression history: mpv refresh-seeks 1–4s backward the first time the
    // renderer issues `set_property sid` post-launch (because sf.lua's
    // sub-add used "auto", leaving sid="no"). The fix is to let the
    // renderer mark one entry `selected: true`; sf.lua then sub-add's with
    // mpv's "select" flag and sid is fixed BEFORE the first decoded frame.
    // This test pins the payload contract — the `selected: true` flag must
    // survive into the JSON shipped to sf.lua, and at most one entry should
    // carry it.
    const payload = buildExternalPlaybackMetadataPayload({
      subtitlesOffLabel: "Off",
      subtitles: [
        { url: "/cache/a.sup", title: "Chinese - chi", lang: "zh", format: "sup", selected: false },
        { url: "/cache/b.sup", title: "French - fre", lang: "fr", format: "sup", selected: true },
        { url: "/cache/c.sup", title: "English", lang: "en", format: "sup" },
      ],
      chapters: [],
      audioOptions: [],
      skipMarkers: [],
      title: "",
      meta: "",
      previousEpisode: null,
      nextEpisode: null,
      autoplayNextEpisode: false,
      autoSkipIntro: false,
      autoSkipCredits: false,
    });
    try {
      expect(payload.subtitles).toEqual([
        expect.objectContaining({ url: "/cache/a.sup", selected: false }),
        expect.objectContaining({ url: "/cache/b.sup", selected: true }),
        expect.objectContaining({ url: "/cache/c.sup" }),
      ]);
      expect(payload.subtitles.filter((sub) => sub.selected === true)).toHaveLength(1);
    } catch (err) {
      dumpMetadataSnapshot("subtitle-selected-flag:payload", { payload });
      throw err;
    }

    const commands = buildExternalMetadataCommands(payload);
    const subCmd = commands.find((c) => c.command[1] === "sf-subtitles-json");
    try {
      expect(subCmd).toBeDefined();
      const json = subCmd!.command[2];
      const parsed = JSON.parse(json) as Array<{ url: string; selected?: boolean }>;
      console.info("[mpv-external-metadata:subtitle-selected-flag] serialized subtitles:", json);
      const selectedEntry = parsed.find((entry) => entry.selected === true);
      expect(selectedEntry?.url).toBe("/cache/b.sup");
    } catch (err) {
      dumpMetadataSnapshot("subtitle-selected-flag:command", { payload, commands });
      throw err;
    }
  });
});
