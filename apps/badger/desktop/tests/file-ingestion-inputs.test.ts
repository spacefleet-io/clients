// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  buildFileIngestionActiveInputGroups,
  buildFileIngestionTrackOverrideMaps,
  buildFileIngestionUndefinedTrackRows,
} from "../src/renderer/src/components/fileIngestionInputs";

// On assertion failure, dump the helper inputs + computed output so a CI
// failure is diagnosable offline. Body wrapped in try/catch so a dump failure
// can never mask the real assertion failure.
const dumpIngestionSnapshot = (label: string, payload: Record<string, unknown>) => {
  try {
    console.error(`=== [file-ingestion-inputs:${label}] snapshot ===`);
    for (const [key, value] of Object.entries(payload)) {
      console.error(`${key}=${JSON.stringify(value, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("fileIngestionInputs", () => {
  it("builds undefined-track rows for subtitle files and embedded tracks that still need language input", () => {
    console.info("[file-ingestion-inputs:undefined-rows] building undefined-track rows for 1 subtitle file + 1 video (2 audio, 1 subtitle embedded)");
    const rows = buildFileIngestionUndefinedTrackRows(
      [
        {
          id: "subtitle-1",
          name: "episode.srt",
          kind: "subtitle" as const,
          subtitleDraft: { language: "und", label: "Unknown" },
        },
        {
          id: "video-1",
          name: "episode.mkv",
          kind: "video" as const,
          probe: {
            audioTracks: [
              { index: 0, language: null, label: "Track 1" },
              { index: 1, language: "en", label: "English" },
            ],
            subtitleTracks: [{ index: 2, language: null, label: "Subtitle 2" }],
          },
        },
      ],
      {
        normalizeLanguageCode: (raw) => (raw && raw !== "Unknown" ? raw : "und"),
        normalizeTrackLabelForUi: (label, language) => (label && label !== "Unknown" ? label : language ?? "und"),
        trackNeedsLanguageReview: (track) => !track.label || /unknown|track|subtitle/i.test(track.label),
      }
    );

    const rowIds = rows.map((row) => row.id);
    const expectedIds = ["subtitle-1:subtitle:0", "video-1:audio:0", "video-1:subtitle:2"];
    console.info(`[file-ingestion-inputs:undefined-rows] rowIds=${JSON.stringify(rowIds)} expected=${JSON.stringify(expectedIds)}`);
    if (JSON.stringify(rowIds) !== JSON.stringify(expectedIds)) {
      dumpIngestionSnapshot("undefined-rows", { rowIds, expectedIds, rows });
    }
    expect(rowIds).toEqual(expectedIds);
  });

  it("groups active input rows by candidate and derives episode/movie labels", () => {
    console.info("[file-ingestion-inputs:active-groups] grouping 2 active rows (ep1 audio, movie1 subtitle) into candidate groups");
    const groups = buildFileIngestionActiveInputGroups(
      [
        {
          id: "ep1:audio:0",
          candidateId: "ep1",
          candidateName: "Better.Call.Saul.S01E01.mkv",
          kind: "audio" as const,
          index: 0,
          language: "und",
          label: "Unknown",
          keepUndefined: true,
        },
        {
          id: "movie1:subtitle:0",
          candidateId: "movie1",
          candidateName: "Blade.Runner.srt",
          kind: "subtitle" as const,
          index: 0,
          language: "und",
          label: "Unknown",
          keepUndefined: true,
        },
      ],
      [
        {
          id: "ep1",
          name: "Better.Call.Saul.S01E01.mkv",
          kind: "video" as const,
          match: { title: "Better Call Saul", type: "tv" as const },
          parsed: { season: 1, episode: 1 },
        },
        {
          id: "movie1",
          name: "Blade.Runner.mkv",
          kind: "video" as const,
          match: { title: "Blade Runner", type: "movie" as const },
          parsed: {},
        },
      ],
      {
        unknownMediaLabel: "Unknown media",
        movieLabel: "Movie",
      }
    );

    console.info(`[file-ingestion-inputs:active-groups] groups=${JSON.stringify(groups.map((g) => ({ candidateId: g.candidateId, primaryLabel: g.primaryLabel })))}`);
    try {
      expect(groups).toEqual([
        expect.objectContaining({ candidateId: "ep1", primaryLabel: "S1E01 - Better Call Saul" }),
        expect.objectContaining({ candidateId: "movie1", primaryLabel: "Movie - Blade Runner" }),
      ]);
    } catch (err) {
      dumpIngestionSnapshot("active-groups", { groups });
      throw err;
    }
  });
});

describe("[@bugfix][@regression-proof] buildFileIngestionTrackOverrideMaps — Bug #4 audio language override", () => {
  // The map-builder upstream of fileIngestionV2Translate. The user picks a
  // language for an undefined audio (or subtitle) track in the dialog; this
  // helper turns those decisions into per-candidate override arrays that land
  // on LabQueueFileInput.audioTrackOverrides / subtitleTrackOverrides. The V2
  // translator then forwards them as audioOverrides / subtitleOverrides on the
  // submit_sources payload. Bug #4 was that the translator dropped the field;
  // this test locks in that the upstream seam still produces the expected
  // shape so the wire format stays correct end-to-end.

  const normalizeLanguageCode = (raw?: string | null) => {
    const trimmed = (raw ?? "").trim().toLowerCase();
    if (!trimmed || trimmed === "und" || trimmed === "undefined" || trimmed === "unknown") return "und";
    return trimmed;
  };
  const languageLabel = (code: string) => code.toUpperCase();

  const audioRow = (overrides: Partial<{
    id: string;
    candidateId: string;
    candidateName: string;
    index: number;
  }> = {}) => ({
    id: overrides.id ?? "cand-1:audio:0",
    candidateId: overrides.candidateId ?? "cand-1",
    candidateName: overrides.candidateName ?? "Orchard.mkv",
    kind: "audio" as const,
    index: overrides.index ?? 0,
    language: "und",
    label: "Undefined",
    keepUndefined: true,
  });

  const subtitleRow = (overrides: Partial<{
    id: string;
    candidateId: string;
    index: number;
  }> = {}) => ({
    id: overrides.id ?? "cand-1:subtitle:0",
    candidateId: overrides.candidateId ?? "cand-1",
    candidateName: "Orchard.mkv",
    kind: "subtitle" as const,
    index: overrides.index ?? 0,
    language: "und",
    label: "Undefined",
    keepUndefined: true,
  });

  it("collects an audio language pick into audioOverrideByCandidate keyed by candidateId", () => {
    console.info("[file-ingestion-inputs:override-audio] decision: cand-1:audio:0 -> en/English, keepUndefined=false");
    const rows = [audioRow()];
    const decisions = {
      "cand-1:audio:0": { language: "en", label: "English", keepUndefined: false },
    };
    const { audioOverrideByCandidate, subtitleOverrideByCandidate } =
      buildFileIngestionTrackOverrideMaps({
        decisions,
        rows,
        normalizeLanguageCode,
        languageLabel,
      });
    console.info(`[file-ingestion-inputs:override-audio] audioOverride[cand-1]=${JSON.stringify(audioOverrideByCandidate.get("cand-1"))} subtitleOverride.size=${subtitleOverrideByCandidate.size}`);
    try {
      expect(audioOverrideByCandidate.get("cand-1")).toEqual([
        { index: 0, language: "en", label: "English" },
      ]);
      expect(subtitleOverrideByCandidate.size).toBe(0);
    } catch (err) {
      dumpIngestionSnapshot("override-audio", { decisions, rows, audioOverride: [...audioOverrideByCandidate], subtitleOverride: [...subtitleOverrideByCandidate] });
      throw err;
    }
  });

  it("collects a subtitle language pick into subtitleOverrideByCandidate", () => {
    console.info("[file-ingestion-inputs:override-subtitle] decision: cand-1:subtitle:0 -> fr/Français, keepUndefined=false");
    const rows = [subtitleRow()];
    const decisions = {
      "cand-1:subtitle:0": { language: "fr", label: "Français", keepUndefined: false },
    };
    const { audioOverrideByCandidate, subtitleOverrideByCandidate } =
      buildFileIngestionTrackOverrideMaps({
        decisions,
        rows,
        normalizeLanguageCode,
        languageLabel,
      });
    console.info(`[file-ingestion-inputs:override-subtitle] subtitleOverride[cand-1]=${JSON.stringify(subtitleOverrideByCandidate.get("cand-1"))} audioOverride.size=${audioOverrideByCandidate.size}`);
    try {
      expect(subtitleOverrideByCandidate.get("cand-1")).toEqual([
        { index: 0, language: "fr", label: "Français" },
      ]);
      expect(audioOverrideByCandidate.size).toBe(0);
    } catch (err) {
      dumpIngestionSnapshot("override-subtitle", { decisions, rows, audioOverride: [...audioOverrideByCandidate], subtitleOverride: [...subtitleOverrideByCandidate] });
      throw err;
    }
  });

  it("ignores rows where the user kept the und tag (keepUndefined=true)", () => {
    console.info("[file-ingestion-inputs:override-keep-und] decision: cand-1:audio:0 keepUndefined=true (expect 0 overrides)");
    const rows = [audioRow()];
    const decisions = {
      "cand-1:audio:0": { language: "en", label: "English", keepUndefined: true },
    };
    const { audioOverrideByCandidate } = buildFileIngestionTrackOverrideMaps({
      decisions,
      rows,
      normalizeLanguageCode,
      languageLabel,
    });
    console.info(`[file-ingestion-inputs:override-keep-und] audioOverride.size=${audioOverrideByCandidate.size} (expected 0)`);
    if (audioOverrideByCandidate.size !== 0) {
      dumpIngestionSnapshot("override-keep-und", { decisions, rows, audioOverride: [...audioOverrideByCandidate] });
    }
    expect(audioOverrideByCandidate.size).toBe(0);
  });

  it("ignores decisions that normalise back to 'und' (e.g. user typed 'Unknown')", () => {
    console.info("[file-ingestion-inputs:override-normalise-und] decision: cand-1:audio:0 language='Unknown' (normalises to und; expect 0 overrides)");
    const rows = [audioRow()];
    const decisions = {
      "cand-1:audio:0": { language: "Unknown", label: "Unknown", keepUndefined: false },
    };
    const { audioOverrideByCandidate } = buildFileIngestionTrackOverrideMaps({
      decisions,
      rows,
      normalizeLanguageCode,
      languageLabel,
    });
    console.info(`[file-ingestion-inputs:override-normalise-und] audioOverride.size=${audioOverrideByCandidate.size} (expected 0)`);
    if (audioOverrideByCandidate.size !== 0) {
      dumpIngestionSnapshot("override-normalise-und", { decisions, rows, audioOverride: [...audioOverrideByCandidate] });
    }
    expect(audioOverrideByCandidate.size).toBe(0);
  });

  it("falls back to languageLabel(code) when the user-typed label is whitespace-only", () => {
    console.info("[file-ingestion-inputs:override-label-fallback] decision: cand-1:audio:0 language='ja' label='   ' (expect label falls back to JA)");
    const rows = [audioRow()];
    const decisions = {
      "cand-1:audio:0": { language: "ja", label: "   ", keepUndefined: false },
    };
    const { audioOverrideByCandidate } = buildFileIngestionTrackOverrideMaps({
      decisions,
      rows,
      normalizeLanguageCode,
      languageLabel,
    });
    console.info(`[file-ingestion-inputs:override-label-fallback] audioOverride[cand-1]=${JSON.stringify(audioOverrideByCandidate.get("cand-1"))}`);
    try {
      expect(audioOverrideByCandidate.get("cand-1")).toEqual([
        { index: 0, language: "ja", label: "JA" },
      ]);
    } catch (err) {
      dumpIngestionSnapshot("override-label-fallback", { decisions, rows, audioOverride: [...audioOverrideByCandidate] });
      throw err;
    }
  });

  it("groups multiple track overrides for the same candidate into one array", () => {
    console.info("[file-ingestion-inputs:override-grouping] 2 audio decisions on cand-1 (en@0, fr@1) -> expect single grouped array");
    const rows = [
      audioRow({ id: "cand-1:audio:0", index: 0 }),
      audioRow({ id: "cand-1:audio:1", index: 1 }),
    ];
    const decisions = {
      "cand-1:audio:0": { language: "en", label: "English", keepUndefined: false },
      "cand-1:audio:1": { language: "fr", label: "Français", keepUndefined: false },
    };
    const { audioOverrideByCandidate } = buildFileIngestionTrackOverrideMaps({
      decisions,
      rows,
      normalizeLanguageCode,
      languageLabel,
    });
    console.info(`[file-ingestion-inputs:override-grouping] audioOverride[cand-1]=${JSON.stringify(audioOverrideByCandidate.get("cand-1"))}`);
    try {
      expect(audioOverrideByCandidate.get("cand-1")).toEqual([
        { index: 0, language: "en", label: "English" },
        { index: 1, language: "fr", label: "Français" },
      ]);
    } catch (err) {
      dumpIngestionSnapshot("override-grouping", { decisions, rows, audioOverride: [...audioOverrideByCandidate] });
      throw err;
    }
  });

  it("keeps audio + subtitle decisions separate even when both pick a language for the same candidate", () => {
    console.info("[file-ingestion-inputs:override-audio-sub-separate] cand-1 audio:0 en + subtitle:2 'English SDH' -> expect distinct maps");
    const rows = [
      audioRow({ id: "cand-1:audio:0", index: 0 }),
      subtitleRow({ id: "cand-1:subtitle:2", index: 2 }),
    ];
    const decisions = {
      "cand-1:audio:0": { language: "en", label: "English", keepUndefined: false },
      "cand-1:subtitle:2": { language: "en", label: "English SDH", keepUndefined: false },
    };
    const { audioOverrideByCandidate, subtitleOverrideByCandidate } =
      buildFileIngestionTrackOverrideMaps({
        decisions,
        rows,
        normalizeLanguageCode,
        languageLabel,
      });
    console.info(`[file-ingestion-inputs:override-audio-sub-separate] audioOverride[cand-1]=${JSON.stringify(audioOverrideByCandidate.get("cand-1"))} subtitleOverride[cand-1]=${JSON.stringify(subtitleOverrideByCandidate.get("cand-1"))}`);
    try {
      expect(audioOverrideByCandidate.get("cand-1")).toEqual([
        { index: 0, language: "en", label: "English" },
      ]);
      expect(subtitleOverrideByCandidate.get("cand-1")).toEqual([
        { index: 2, language: "en", label: "English SDH" },
      ]);
    } catch (err) {
      dumpIngestionSnapshot("override-audio-sub-separate", { decisions, rows, audioOverride: [...audioOverrideByCandidate], subtitleOverride: [...subtitleOverrideByCandidate] });
      throw err;
    }
  });
});
