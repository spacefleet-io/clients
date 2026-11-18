/**
 * @bugfix effervescent-teapot Symptom A — "4 jobs per movie"
 * @regression-proof
 *
 * The legacy `queue_files` action contains TWO file entries when transcoding:
 * the actual source video (jobType="source") + a synthetic transcode
 * placeholder (jobType="transcode"). The V2 branch in FileIngestionDialog
 * previously flatMapped every file entry into a `submit_sources` source, so
 * one drag became 2 sources × (1 source job + 1 format job) = 4 jobs.
 *
 * The translator must keep only `jobType === "source"` (or undefined) entries
 * so V2 sees exactly one source per dragged movie. Format jobs are derived
 * from `desiredFormats` inside the runtime handler — not from extra entries.
 */
import { describe, it, expect } from "vitest";
import {
  translateActionsToV2Sources,
  isV2SourceEntry,
  type V2Quality,
} from "../src/renderer/src/components/fileIngestionV2Translate";
import type { LabQueueAction } from "../src/renderer/src/lib/labJobs";
import type { LabQueueFileInput } from "../src/shared/labQueueShared";

// ---------------------------------------------------------------------------
// Diagnostic-logging helpers (per the tests-log-generously convention).
// Suite id: v2-translate. Phase markers: `[v2-translate:<phase>]`.
// dumpV2TranslateSnapshot prints the actions input + translator output so a
// failed assertion shows the exact translation context.
// ---------------------------------------------------------------------------

const dumpV2TranslateSnapshot = (
  label: string,
  ctx: { actions?: LabQueueAction[]; sources?: unknown[]; desired?: V2Quality[] } = {},
) => {
  try {
     
    console.log(
      `[v2-translate:dump] ${label}`,
      JSON.stringify(
        {
          desired: ctx.desired,
          actionCount: ctx.actions?.length,
          actions: ctx.actions,
          sourceCount: ctx.sources?.length,
          sources: ctx.sources,
        },
        null,
        2,
      ),
    );
  } catch (dumpError) {
     
    console.log(`[v2-translate:dump-error] ${label}`, dumpError);
  }
};

const baseFile = (
  overrides: Partial<LabQueueFileInput> & { filename: string }
): LabQueueFileInput =>
  ({
    id: `f-${overrides.filename}`,
    sizeMb: 4096,
    groupId: "g1",
    includeSource: true,
    includeFallback: false,
    includeAudio: true,
    includeSubtitles: false,
    includeChapters: false,
    selectedFormats: [],
    ...overrides,
  }) as LabQueueFileInput;

const desired: V2Quality[] = ["360p"];

describe("translateActionsToV2Sources (V2 ingest translator) — bugfix effervescent-teapot", () => {
  it("emits exactly 1 source when queue_files contains 1 source + 1 transcode placeholder", () => {
    const action: Extract<LabQueueAction, { type: "queue_files" }> = {
      type: "queue_files",
      files: [
        baseFile({ filename: "/movies/orchard.mkv", jobType: "source" }),
        baseFile({
          filename: "/movies/orchard.mkv",
          jobType: "transcode",
          includeSource: false,
          includeFallback: true,
          selectedFormats: [{ quality: "360p", codec: "h264" }],
        }),
      ],
      preset: { media: { id: "media-orchard" } } as never,
    };

    let sources: ReturnType<typeof translateActionsToV2Sources> | undefined;
    try {
       
      console.log("[v2-translate:dedupe-source-transcode] translating 1 source + 1 transcode");
      sources = translateActionsToV2Sources([action], desired);
       
      console.log(
        `[v2-translate:dedupe-source-transcode:asserting] sourceCount=${sources.length}`,
      );

      expect(sources).toHaveLength(1);
      expect(sources[0]).toMatchObject({
        filename: "/movies/orchard.mkv",
        desiredFormats: ["360p"],
        hints: { mediaId: "media-orchard" },
      });
    } catch (assertionError) {
      dumpV2TranslateSnapshot("dedupe-source-transcode:fail", {
        actions: [action],
        sources,
        desired,
      });
      throw assertionError;
    }
  });

  it("treats undefined jobType as a source (legacy back-compat)", () => {
    try {
       
      console.log("[v2-translate:legacy-jobtype] checking isV2SourceEntry on undefined/source/transcode");
      expect(isV2SourceEntry(baseFile({ filename: "x.mkv" }))).toBe(true);
      expect(
        isV2SourceEntry(baseFile({ filename: "x.mkv", jobType: "source" }))
      ).toBe(true);
      expect(
        isV2SourceEntry(baseFile({ filename: "x.mkv", jobType: "transcode" }))
      ).toBe(false);
    } catch (assertionError) {
      dumpV2TranslateSnapshot("legacy-jobtype:fail");
      throw assertionError;
    }
  });

  it("skips non-queue_files actions", () => {
    const actions: LabQueueAction[] = [
      { type: "manual_match" } as unknown as LabQueueAction,
      {
        type: "queue_files",
        files: [baseFile({ filename: "ok.mkv", jobType: "source" })],
        preset: null,
      },
    ];
    let sources: ReturnType<typeof translateActionsToV2Sources> | undefined;
    try {
       
      console.log("[v2-translate:skip-non-queue] mixing manual_match + queue_files");
      sources = translateActionsToV2Sources(actions, desired);
      expect(sources).toHaveLength(1);
      expect(sources[0].filename).toBe("ok.mkv");
    } catch (assertionError) {
      dumpV2TranslateSnapshot("skip-non-queue:fail", { actions, sources, desired });
      throw assertionError;
    }
  });

  it("falls back to pendingMedia.catalogId for the mediaId hint", () => {
    const action: Extract<LabQueueAction, { type: "queue_files" }> = {
      type: "queue_files",
      files: [baseFile({ filename: "a.mkv", jobType: "source" })],
      preset: { pendingMedia: { catalogId: 12345 } } as never,
    };
    let sources: ReturnType<typeof translateActionsToV2Sources> | undefined;
    try {
       
      console.log("[v2-translate:pending-catalog-fallback] catalogId=12345 → mediaId='12345'");
      sources = translateActionsToV2Sources([action], desired);
      expect(sources[0].hints).toEqual({ mediaId: "12345" });
    } catch (assertionError) {
      dumpV2TranslateSnapshot("pending-catalog-fallback:fail", {
        actions: [action],
        sources,
        desired,
      });
      throw assertionError;
    }
  });

  it("emits 2 sources for a multi-file queue_files (e.g. multi-episode batch)", () => {
    const action: Extract<LabQueueAction, { type: "queue_files" }> = {
      type: "queue_files",
      files: [
        baseFile({ filename: "ep01.mkv", jobType: "source" }),
        baseFile({ filename: "ep02.mkv", jobType: "source" }),
        baseFile({ filename: "ep01.mkv", jobType: "transcode" }),
        baseFile({ filename: "ep02.mkv", jobType: "transcode" }),
      ],
      preset: null,
    };
    let sources: ReturnType<typeof translateActionsToV2Sources> | undefined;
    try {
       
      console.log("[v2-translate:multi-episode-batch] 2 sources + 2 transcodes");
      sources = translateActionsToV2Sources([action], desired);
       
      console.log(
        `[v2-translate:multi-episode-batch:asserting] sourceCount=${sources.length}`,
      );
      expect(sources).toHaveLength(2);
      expect(sources.map((s) => s.filename)).toEqual(["ep01.mkv", "ep02.mkv"]);
    } catch (assertionError) {
      dumpV2TranslateSnapshot("multi-episode-batch:fail", {
        actions: [action],
        sources,
        desired,
      });
      throw assertionError;
    }
  });
});

describe("[@bugfix][@regression-proof] translateActionsToV2Sources — Bug #4 audio language override forwarded", () => {
  // Bug #4: user types "English" for an undefined-language audio track in
  // FileIngestionDialog. The override was captured into the dialog state and
  // populated onto LabQueueFileInput.audioTrackOverrides, but the V2 translator
  // never read the field, so the runtime never saw the override and the encoded
  // media_audio_tracks shipped with `language='und', label='Undefined'`. The
  // fix forwards `audioTrackOverrides` / `subtitleTrackOverrides` from the file
  // input straight to the V2 contract's `audioOverrides` / `subtitleOverrides`.

  it("forwards audioTrackOverrides into audioOverrides on the submitted source", () => {
    const action: Extract<LabQueueAction, { type: "queue_files" }> = {
      type: "queue_files",
      files: [
        baseFile({
          filename: "/movies/orchard.mkv",
          jobType: "source",
          audioTrackOverrides: [
            { index: 0, language: "en", label: "English" },
            { index: 1, language: "fr", label: "Français" },
          ],
        }),
      ],
      preset: { media: { id: "media-orchard" } } as never,
    };
    let sources: ReturnType<typeof translateActionsToV2Sources> | undefined;
    try {
       
      console.log("[v2-translate:audio-forward] forwarding en+fr overrides");
      sources = translateActionsToV2Sources([action], desired);
      expect(sources).toHaveLength(1);
      expect(sources[0].audioOverrides).toEqual([
        { index: 0, language: "en", label: "English" },
        { index: 1, language: "fr", label: "Français" },
      ]);
    } catch (assertionError) {
      dumpV2TranslateSnapshot("audio-forward:fail", {
        actions: [action],
        sources,
        desired,
      });
      throw assertionError;
    }
  });

  it("forwards subtitleTrackOverrides into subtitleOverrides on the submitted source", () => {
    const action: Extract<LabQueueAction, { type: "queue_files" }> = {
      type: "queue_files",
      files: [
        baseFile({
          filename: "/movies/orchard.mkv",
          jobType: "source",
          subtitleTrackOverrides: [
            { index: 0, language: "en", label: "English SDH" },
          ],
        }),
      ],
      preset: null,
    };
    let sources: ReturnType<typeof translateActionsToV2Sources> | undefined;
    try {
       
      console.log("[v2-translate:subtitle-forward] forwarding English SDH override");
      sources = translateActionsToV2Sources([action], desired);
      expect(sources[0].subtitleOverrides).toEqual([
        { index: 0, language: "en", label: "English SDH" },
      ]);
    } catch (assertionError) {
      dumpV2TranslateSnapshot("subtitle-forward:fail", {
        actions: [action],
        sources,
        desired,
      });
      throw assertionError;
    }
  });

  it("omits audioOverrides / subtitleOverrides when the file has no overrides (clean wire payload)", () => {
    const action: Extract<LabQueueAction, { type: "queue_files" }> = {
      type: "queue_files",
      files: [baseFile({ filename: "noop.mkv", jobType: "source" })],
      preset: null,
    };
    let sources: ReturnType<typeof translateActionsToV2Sources> | undefined;
    try {
       
      console.log("[v2-translate:no-override-no-field] verifying clean wire");
      sources = translateActionsToV2Sources([action], desired);
      expect(sources[0].audioOverrides).toBeUndefined();
      expect(sources[0].subtitleOverrides).toBeUndefined();
    } catch (assertionError) {
      dumpV2TranslateSnapshot("no-override-no-field:fail", {
        actions: [action],
        sources,
        desired,
      });
      throw assertionError;
    }
  });

  it("omits empty override arrays (sanitize) so the contract field is never sent as `[]`", () => {
    const action: Extract<LabQueueAction, { type: "queue_files" }> = {
      type: "queue_files",
      files: [
        baseFile({
          filename: "empty.mkv",
          jobType: "source",
          audioTrackOverrides: [],
          subtitleTrackOverrides: [],
        }),
      ],
      preset: null,
    };
    let sources: ReturnType<typeof translateActionsToV2Sources> | undefined;
    try {
       
      console.log("[v2-translate:sanitize-empty-arrays] [] overrides → undefined");
      sources = translateActionsToV2Sources([action], desired);
      expect(sources[0].audioOverrides).toBeUndefined();
      expect(sources[0].subtitleOverrides).toBeUndefined();
    } catch (assertionError) {
      dumpV2TranslateSnapshot("sanitize-empty-arrays:fail", {
        actions: [action],
        sources,
        desired,
      });
      throw assertionError;
    }
  });

  it("drops overrides on the synthetic transcode placeholder (only the source entry survives)", () => {
    const action: Extract<LabQueueAction, { type: "queue_files" }> = {
      type: "queue_files",
      files: [
        baseFile({
          filename: "/movies/orchard.mkv",
          jobType: "source",
          audioTrackOverrides: [
            { index: 0, language: "en", label: "English" },
          ],
        }),
        // The transcode placeholder is filtered out; even if it carried
        // overrides, the V2 translator must not surface them as a second source.
        baseFile({
          filename: "/movies/orchard.mkv",
          jobType: "transcode",
          audioTrackOverrides: [
            { index: 0, language: "de", label: "Deutsch" },
          ],
        }),
      ],
      preset: null,
    };
    let sources: ReturnType<typeof translateActionsToV2Sources> | undefined;
    try {
       
      console.log("[v2-translate:transcode-overrides-dropped] only source's en override survives");
      sources = translateActionsToV2Sources([action], desired);
      expect(sources).toHaveLength(1);
      expect(sources[0].audioOverrides).toEqual([
        { index: 0, language: "en", label: "English" },
      ]);
    } catch (assertionError) {
      dumpV2TranslateSnapshot("transcode-overrides-dropped:fail", {
        actions: [action],
        sources,
        desired,
      });
      throw assertionError;
    }
  });

  it("preserves audio-only index semantics — index 1 stays index 1 end-to-end (no remap)", () => {
    const action: Extract<LabQueueAction, { type: "queue_files" }> = {
      type: "queue_files",
      files: [
        baseFile({
          filename: "multi.mkv",
          jobType: "source",
          audioTrackOverrides: [
            // Track at audio-only index 1 — second audio stream.
            { index: 1, language: "ja", label: "Japanese commentary" },
          ],
        }),
      ],
      preset: null,
    };
    let sources: ReturnType<typeof translateActionsToV2Sources> | undefined;
    try {
       
      console.log("[v2-translate:index-preserved] verifying index 1 stays as index 1");
      sources = translateActionsToV2Sources([action], desired);
      expect(sources[0].audioOverrides).toEqual([
        { index: 1, language: "ja", label: "Japanese commentary" },
      ]);
    } catch (assertionError) {
      dumpV2TranslateSnapshot("index-preserved:fail", {
        actions: [action],
        sources,
        desired,
      });
      throw assertionError;
    }
  });
});

describe("@bugfix @regression-proof TV preset — translateActionsToV2Sources forwards season/episode hints", () => {
  // Without these hints, the runtime commit step writes media_files /
  // media_audio_tracks with (season=null, episode=null). That makes
  // addAudioTrackWithChunks resolve `episodeId = null` and
  // getPlayableEpisodeKeySet returns an empty set, leaving
  // `defaultPlayableEpisodeId = null` and the play button disabled forever
  // after a successful TV ingest (playback.e2e.test.ts:1043,
  // playback-subtitle-switch.e2e.test.ts:1029).
  it("forwards preset.season and preset.episode onto the source hints for TV", () => {
    const action: Extract<LabQueueAction, { type: "queue_files" }> = {
      type: "queue_files",
      files: [baseFile({ filename: "ep01.mkv", jobType: "source" })],
      preset: {
        media: { id: "media-saltmarsh" },
        season: 1,
        episode: 1,
      } as never,
    };
    let sources: ReturnType<typeof translateActionsToV2Sources> | undefined;
    try {
       
      console.log("[v2-translate:tv-hints-forward] season=1 episode=1");
      sources = translateActionsToV2Sources([action], desired);
      expect(sources[0].hints).toEqual({
        mediaId: "media-saltmarsh",
        season: 1,
        episode: 1,
      });
    } catch (assertionError) {
      dumpV2TranslateSnapshot("tv-hints-forward:fail", {
        actions: [action],
        sources,
        desired,
      });
      throw assertionError;
    }
  });

  it("omits season/episode when preset has no values (movies still go through with mediaId-only hints)", () => {
    const action: Extract<LabQueueAction, { type: "queue_files" }> = {
      type: "queue_files",
      files: [baseFile({ filename: "movie.mkv", jobType: "source" })],
      preset: { media: { id: "media-movie" } } as never,
    };
    let sources: ReturnType<typeof translateActionsToV2Sources> | undefined;
    try {
       
      console.log("[v2-translate:movie-mediaid-only] no season/episode on movie");
      sources = translateActionsToV2Sources([action], desired);
      expect(sources[0].hints).toEqual({ mediaId: "media-movie" });
    } catch (assertionError) {
      dumpV2TranslateSnapshot("movie-mediaid-only:fail", {
        actions: [action],
        sources,
        desired,
      });
      throw assertionError;
    }
  });

  it("omits non-positive season/episode (defensive against undefined/0/negative)", () => {
    const action: Extract<LabQueueAction, { type: "queue_files" }> = {
      type: "queue_files",
      files: [baseFile({ filename: "x.mkv", jobType: "source" })],
      preset: {
        media: { id: "m" },
        season: 0,
        episode: -1,
      } as never,
    };
    let sources: ReturnType<typeof translateActionsToV2Sources> | undefined;
    try {
       
      console.log("[v2-translate:non-positive-season-episode] season=0 episode=-1 omitted");
      sources = translateActionsToV2Sources([action], desired);
      expect(sources[0].hints).toEqual({ mediaId: "m" });
    } catch (assertionError) {
      dumpV2TranslateSnapshot("non-positive-season-episode:fail", {
        actions: [action],
        sources,
        desired,
      });
      throw assertionError;
    }
  });

  it("falls back to pendingMedia.catalogId + season/episode when no real mediaId yet", () => {
    const action: Extract<LabQueueAction, { type: "queue_files" }> = {
      type: "queue_files",
      files: [baseFile({ filename: "pending.mkv", jobType: "source" })],
      preset: {
        pendingMedia: { catalogId: 907633 },
        season: 1,
        episode: 2,
      } as never,
    };
    let sources: ReturnType<typeof translateActionsToV2Sources> | undefined;
    try {
       
      console.log("[v2-translate:pending-catalog-tv-hints] catalogId=907633 + s1e2");
      sources = translateActionsToV2Sources([action], desired);
      expect(sources[0].hints).toEqual({
        mediaId: "907633",
        season: 1,
        episode: 2,
      });
    } catch (assertionError) {
      dumpV2TranslateSnapshot("pending-catalog-tv-hints:fail", {
        actions: [action],
        sources,
        desired,
      });
      throw assertionError;
    }
  });
});

