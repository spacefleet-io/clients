import { describe, expect, it } from "vitest";
import type { AudioTrack, MediaFormat, MediaSkipMarker, SubtitleTrack } from "@/lib/libraryDb";
import {
  buildPlaybackChapters,
  buildPlaybackFormatsForFile,
  buildPlaybackSkipMarkers,
  pickSettingsFormat,
  resolveNextEpisodeFormatId,
  resolvePlaybackAudioState,
  resolvePlaybackSubtitleState,
} from "../src/renderer/src/lib/mpvPlaybackSelection";
import { buildMpvPlaybackState } from "../src/renderer/src/lib/mpvPlaybackState";

// On assertion failure, dump the resolver inputs + outputs so a CI failure is
// diagnosable offline without re-running with a debugger. Body is wrapped in
// try/catch so a dump failure can never mask the real assertion failure.
const dumpSelectionSnapshot = (label: string, payload: Record<string, unknown>) => {
  try {
    console.error(`=== [mpv-playback-selection:${label}] snapshot ===`);
    for (const [key, value] of Object.entries(payload)) {
      console.error(`${key}=${JSON.stringify(value, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// Fixture factories: the resolvers only read a handful of fields, but the DB row types
// require the full shape. Defaults fill the unread fields; each test states only what it exercises.
const makeFormat = (
  fields: Pick<MediaFormat, "id" | "fileId" | "quality" | "codec"> & Partial<MediaFormat>,
): MediaFormat => ({
  mediaId: "media-1",
  bitrateKbps: null,
  sizeMb: 0,
  initKey: null,
  initSize: null,
  durationSeconds: null,
  totalSize: null,
  chunks: [],
  ...fields,
});

const makeAudioTrack = (
  fields: Pick<AudioTrack, "id" | "label" | "language" | "isDefault" | "episodeId"> & Partial<AudioTrack>,
): AudioTrack => ({
  mediaId: "media-1",
  fileId: null,
  source: "ingest",
  codec: null,
  initKey: null,
  initSize: null,
  durationSeconds: null,
  totalSize: null,
  chunks: [],
  ...fields,
});

const makeSubtitleTrack = (
  fields: Pick<SubtitleTrack, "id" | "label" | "language" | "isDefault" | "episodeId"> & Partial<SubtitleTrack>,
): SubtitleTrack => ({
  mediaId: "media-1",
  fileId: null,
  objectKey: null,
  format: null,
  source: "ingest",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...fields,
});

const makeSkipMarker = (
  fields: Pick<MediaSkipMarker, "id" | "episodeId" | "type" | "startSeconds" | "endSeconds">,
): MediaSkipMarker => ({
  mediaId: "media-1",
  source: "ingest",
  confidence: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...fields,
});

describe("mpvPlaybackSelection", () => {
  it("@bugfix @regression-proof keeps one best playable format per quality for the active file", () => {
    console.info("[mpv-playback-selection:format-dedupe] resolving best playable format per quality for file-1");
    const formats = buildPlaybackFormatsForFile(
      [
        makeFormat({
          id: "f1-weak",
          fileId: "file-1",
          quality: "1080p",
          codec: "h264",
          initKey: null,
          chunks: [],
          bitrateKbps: 1000,
          totalSize: 100,
        }),
        makeFormat({
          id: "f1-strong",
          fileId: "file-1",
          quality: "1080p",
          codec: "h264",
          initKey: "init-1",
          chunks: [{ key: "c1", sizeBytes: 1, startSeconds: 0 }],
          bitrateKbps: 1500,
          totalSize: 120,
        }),
        makeFormat({
          id: "f1-360",
          fileId: "file-1",
          quality: "360p",
          codec: "h264",
          initKey: "init-2",
          chunks: [{ key: "c2", sizeBytes: 1, startSeconds: 0 }],
          bitrateKbps: 500,
          totalSize: 60,
        }),
        makeFormat({
          id: "other-file",
          fileId: "file-2",
          quality: "1080p",
          codec: "h264",
          initKey: "init-3",
          chunks: [{ key: "c3", sizeBytes: 1, startSeconds: 0 }],
          bitrateKbps: 1800,
          totalSize: 150,
        }),
      ],
      "file-1",
      new Set()
    );
    const resolvedIds = formats.map((format) => format.id);
    const expectedIds = ["f1-strong", "f1-360"];
    console.info(`[mpv-playback-selection:format-dedupe] resolvedIds=${JSON.stringify(resolvedIds)} expected=${JSON.stringify(expectedIds)}`);
    if (JSON.stringify(resolvedIds) !== JSON.stringify(expectedIds)) {
      dumpSelectionSnapshot("format-dedupe", { activeFileId: "file-1", resolvedIds, expectedIds, formats });
    }
    expect(resolvedIds).toEqual(expectedIds);
  });

  it("@bugfix @regression-proof a decode-blocked codec gives up its quality slot to another codec (issue #25)", () => {
    // The ladder keeps one format per quality. With HEVC and H.264 both at
    // 1080p the HEVC row wins on chunks, so the H.264 1080p row was invisible
    // and the decode-bound fallback could only reach a LOWER H.264 rung.
    const playable = (key: string, count: number) => ({
      initKey: `init-${key}`,
      chunks: Array.from({ length: count }, (_, i) => ({ key: `${key}-${i}`, sizeBytes: 1, startSeconds: i })),
    });
    const library = [
      makeFormat({ id: "hevc-1080", fileId: "file-1", quality: "1080p", codec: "hevc", bitrateKbps: 3000, ...playable("h", 3) }),
      makeFormat({ id: "h264-1080", fileId: "file-1", quality: "1080p", codec: "h264", bitrateKbps: 5000, ...playable("a", 2) }),
      makeFormat({ id: "h264-360", fileId: "file-1", quality: "360p", codec: "h264", bitrateKbps: 600, ...playable("l", 2) }),
    ];
    const open = buildPlaybackFormatsForFile(library, "file-1", new Set()).map((f) => f.id);
    const blocked = buildPlaybackFormatsForFile(library, "file-1", new Set(["hevc"])).map((f) => f.id);
    console.info(`[mpv-playback-selection:codec-block] open=${JSON.stringify(open)} blocked=${JSON.stringify(blocked)}`);
    if (open[0] !== "hevc-1080" || blocked[0] !== "h264-1080") {
      dumpSelectionSnapshot("codec-block", { open, blocked, library });
    }
    // Nothing blocked: the existing score still decides (more chunks wins).
    expect(open).toEqual(["hevc-1080", "h264-360"]);
    expect(blocked).toEqual(["h264-1080", "h264-360"]);
    // A blocked codec with no alternative at its quality keeps the slot:
    // blocking never removes a quality from the menu.
    const onlyHevc = buildPlaybackFormatsForFile(library.slice(0, 1), "file-1", new Set(["hevc"])).map((f) => f.id);
    expect(onlyHevc).toEqual(["hevc-1080"]);
  });

  it("@bugfix @regression-proof prefers episode-scoped playable audio and respects preferred language", () => {
    console.info("[mpv-playback-selection:audio-resolve] resolving audio for episode-1 preferredLang=ja");
    const resolved = resolvePlaybackAudioState({
      audioTracks: [
        makeAudioTrack({
          id: "show-en",
          label: "English",
          language: "en",
          isDefault: true,
          episodeId: null,
          initKey: "init-en",
          chunks: [{ key: "a1", sizeBytes: 1, startSeconds: 0 }],
        }),
        makeAudioTrack({
          id: "ep-ja",
          label: "Japanese",
          language: "ja",
          isDefault: false,
          episodeId: "episode-1",
          initKey: "init-ja",
          chunks: [{ key: "a2", sizeBytes: 1, startSeconds: 0 }],
        }),
      ],
      preferredAudioLanguage: "ja",
      episodeId: "episode-1",
      selectedAudioId: null,
    });

    const optionIds = resolved.options.map((option) => option.id);
    console.info(`[mpv-playback-selection:audio-resolve] optionIds=${JSON.stringify(optionIds)} selectedAudioId=${String(resolved.selectedAudioId)}`);
    if (JSON.stringify(optionIds) !== JSON.stringify(["ep-ja"]) || resolved.selectedAudioId !== "ep-ja") {
      dumpSelectionSnapshot("audio-resolve", { episodeId: "episode-1", preferredAudioLanguage: "ja", optionIds, resolved });
    }
    expect(optionIds).toEqual(["ep-ja"]);
    expect(resolved.selectedAudioId).toBe("ep-ja");
  });

  it("@bugfix @regression-proof keeps subtitle selection valid and falls back to default track or off", () => {
    console.info("[mpv-playback-selection:sub-fallback] resolving subtitle for episode-1 with stale selectedSubtitleId=missing");
    const resolved = resolvePlaybackSubtitleState({
      subtitleTracks: [
        makeSubtitleTrack({
          id: "sub-1",
          label: "English",
          language: "en",
          isDefault: true,
          episodeId: "episode-1",
          objectKey: "sub-1",
          format: "srt",
        }),
      ],
      episodeId: "episode-1",
      selectedSubtitleId: "missing",
      subtitlesOffLabel: "Off",
    });

    const optionIds = resolved.options.map((option) => option.id);
    console.info(`[mpv-playback-selection:sub-fallback] optionIds=${JSON.stringify(optionIds)} selectedSubtitleId=${String(resolved.selectedSubtitleId)}`);
    if (JSON.stringify(optionIds) !== JSON.stringify(["off", "sub-1"]) || resolved.selectedSubtitleId !== "sub-1") {
      dumpSelectionSnapshot("sub-fallback", { episodeId: "episode-1", selectedSubtitleId: "missing", optionIds, resolved });
    }
    expect(optionIds).toEqual(["off", "sub-1"]);
    expect(resolved.selectedSubtitleId).toBe("sub-1");
  });

  it("@bugfix @regression-proof keep-existing semantics: resolver preserves prior selection when it remains a valid option, EVEN IF a different track now carries isDefault", () => {
    // Behavioral contract that drives MediaDetailsDialog's MediaPlaybackController
    // key={mediaId:requestId}. When the user changes the default subtitle in the
    // modal UI, `subtitleTracks` re-renders with a new isDefault assignment.
    // Calling the resolver with a *preserved* selectedSubtitleId from a prior
    // mount returns the OLD selection — it does NOT chase the new default.
    //
    // The fix is at the React level: each Play click remounts the controller so
    // selectedSubtitleId starts at "off" and the resolver falls through to the
    // new default. See @bugfix dialog-default-track-change-ignored (the modal's
    // key prop on MediaPlaybackController).
    //
    // This test pins the resolver's contract so any future "follow new default"
    // change is intentional, not accidental — and so a future reader knows why
    // the dialog's controller key matters.
    const tracks = [
      makeSubtitleTrack({
        id: "sub-old",
        label: "Spanish",
        language: "es",
        isDefault: false, // user just toggled this OFF as default
        episodeId: null,
        objectKey: "sub-old",
        format: "srt" as const,
      }),
      makeSubtitleTrack({
        id: "sub-new",
        label: "French",
        language: "fr",
        isDefault: true, // user just toggled this ON as default
        episodeId: null,
        objectKey: "sub-new",
        format: "srt" as const,
      }),
    ];

    // Fresh mount: selectedSubtitleId starts at "off" → resolver falls through
    // and picks whichever track currently has isDefault=true. That's "sub-new".
    console.info("[mpv-playback-selection:keep-existing] fresh mount with selectedSubtitleId=off (expect fall-through to new default sub-new)");
    const fromFreshMount = resolvePlaybackSubtitleState({
      subtitleTracks: tracks,
      episodeId: null,
      selectedSubtitleId: "off",
      subtitlesOffLabel: "Off",
    });
    console.info(`[mpv-playback-selection:keep-existing] fromFreshMount.selectedSubtitleId=${String(fromFreshMount.selectedSubtitleId)}`);
    if (fromFreshMount.selectedSubtitleId !== "sub-new") {
      dumpSelectionSnapshot("keep-existing-fresh-mount", { selectedSubtitleId: "off", tracks, fromFreshMount });
    }
    expect(fromFreshMount.selectedSubtitleId).toBe("sub-new");

    // Mid-session call where the engine still remembers the OLD selection from
    // before the default toggle. The resolver KEEPS the old selection because
    // it's still a valid option. Without a remount the user's default change
    // is silently ignored at the next launch.
    console.info("[mpv-playback-selection:keep-existing] preserved-state mount with selectedSubtitleId=sub-old (expect KEEP sub-old, NOT chase new default)");
    const fromPreservedState = resolvePlaybackSubtitleState({
      subtitleTracks: tracks,
      episodeId: null,
      selectedSubtitleId: "sub-old",
      subtitlesOffLabel: "Off",
    });
    console.info(`[mpv-playback-selection:keep-existing] fromPreservedState.selectedSubtitleId=${String(fromPreservedState.selectedSubtitleId)}`);
    if (fromPreservedState.selectedSubtitleId !== "sub-old") {
      dumpSelectionSnapshot("keep-existing-preserved-state", { selectedSubtitleId: "sub-old", tracks, fromPreservedState });
    }
    expect(fromPreservedState.selectedSubtitleId).toBe("sub-old");
  });

  it("@bugfix @regression-proof filters out subtitle tracks without objectKey", () => {
    // Subtitles without objectKey are not playable — they must be excluded.
    // Only tracks with valid objectKey should appear in mpv options.
    console.info("[mpv-playback-selection:sub-filter-objectkey] resolving 3 subs (sub-2 has null objectKey, must be dropped)");
    const resolved = resolvePlaybackSubtitleState({
      subtitleTracks: [
        makeSubtitleTrack({
          id: "sub-1",
          label: "English",
          language: "en",
          isDefault: true,
          episodeId: null,
          objectKey: "subtitle-en.srt",
          format: "srt",
        }),
        makeSubtitleTrack({
          id: "sub-2",
          label: "French",
          language: "fr",
          isDefault: false,
          episodeId: null,
          objectKey: null,
          format: "srt",
        }),
        makeSubtitleTrack({
          id: "sub-3",
          label: "Japanese",
          language: "ja",
          isDefault: false,
          episodeId: null,
          objectKey: "subtitle-ja.srt",
          format: "srt",
        }),
      ],
      episodeId: null,
      selectedSubtitleId: "off",
      subtitlesOffLabel: "Off",
    });

    // sub-2 (no objectKey) should be excluded, leaving off + sub-1 + sub-3
    const optionIds = resolved.options.map((o) => o.id);
    const expectedIds = ["off", "sub-1", "sub-3"];
    console.info(`[mpv-playback-selection:sub-filter-objectkey] optionIds=${JSON.stringify(optionIds)} expected=${JSON.stringify(expectedIds)}`);
    if (JSON.stringify(optionIds) !== JSON.stringify(expectedIds)) {
      dumpSelectionSnapshot("sub-filter-objectkey", { optionIds, expectedIds, resolved });
    }
    expect(optionIds).toEqual(expectedIds);
  });

  it("@bugfix @regression-proof preserves subtitle labels and objectKeys through selection", () => {
    console.info("[mpv-playback-selection:sub-preserve-fields] resolving sub-en + sub-ja, asserting label/language/objectKey pass through");
    const resolved = resolvePlaybackSubtitleState({
      subtitleTracks: [
        makeSubtitleTrack({
          id: "sub-en",
          label: "English",
          language: "en",
          isDefault: true,
          episodeId: null,
          objectKey: "en.srt",
          format: "srt",
        }),
        makeSubtitleTrack({
          id: "sub-ja",
          label: "Japanese",
          language: "ja",
          isDefault: false,
          episodeId: null,
          objectKey: "ja.srt",
          format: "srt",
        }),
      ],
      episodeId: null,
      selectedSubtitleId: "off",
      subtitlesOffLabel: "Off",
    });

    const enOption = resolved.options.find((o) => o.id === "sub-en");
    const jaOption = resolved.options.find((o) => o.id === "sub-ja");
    console.info(`[mpv-playback-selection:sub-preserve-fields] enOption=${JSON.stringify(enOption)} jaOption=${JSON.stringify(jaOption)}`);
    try {
      expect(enOption).toMatchObject({ label: "English", language: "en", objectKey: "en.srt" });
      expect(jaOption).toMatchObject({ label: "Japanese", language: "ja", objectKey: "ja.srt" });
    } catch (err) {
      dumpSelectionSnapshot("sub-preserve-fields", { enOption, jaOption, resolved });
      throw err;
    }
  });

  describe("@bugfix @regression-proof an explicit subtitle Off stays off (#25 Orchard: one French subtitle, OSC off was undone)", () => {
    // Orchard: exactly one subtitle track (French), the default. The engine seeds
    // selectedSubtitleId = "off" and lets this resolver fall through to the
    // default track. A user's Off pick sets the SAME "off" id, and the resolver
    // used to read it as "unset" again and flipped the choice back to the default
    // track in the very next effect run: Off never held. `subtitlesOffPicked`
    // is the engine's record that "off" is the user's choice, not the unset seed.
    const frenchOnly = [
      makeSubtitleTrack({ id: "fr", label: "French", language: "fr", isDefault: true, episodeId: null, objectKey: "fr.srt", format: "srt" }),
    ];
    const twoTracks = [
      ...frenchOnly,
      makeSubtitleTrack({ id: "en", label: "English", language: "en", isDefault: false, episodeId: null, objectKey: "en.srt", format: "srt" }),
    ];
    const resolve = (params: { tracks: typeof frenchOnly; selectedSubtitleId: string; subtitlesOffPicked?: boolean }) => {
      const resolved = resolvePlaybackSubtitleState({
        subtitleTracks: params.tracks,
        episodeId: null,
        selectedSubtitleId: params.selectedSubtitleId,
        subtitlesOffPicked: params.subtitlesOffPicked,
        subtitlesOffLabel: "Off",
      });
      console.info(`[mpv-playback-selection:sub-off-picked] tracks=${params.tracks.length} selected=${params.selectedSubtitleId} offPicked=${String(params.subtitlesOffPicked)} -> ${resolved.selectedSubtitleId}`);
      if (resolved.selectedSubtitleId === undefined) dumpSelectionSnapshot("sub-off-picked", { params, resolved });
      return resolved.selectedSubtitleId;
    };

    it("single default track: the user's Off is kept", () => {
      expect(resolve({ tracks: frenchOnly, selectedSubtitleId: "off", subtitlesOffPicked: true })).toBe("off");
    });

    it("several tracks, one default: the user's Off is kept", () => {
      expect(resolve({ tracks: twoTracks, selectedSubtitleId: "off", subtitlesOffPicked: true })).toBe("off");
    });

    it("fresh mount (Off not picked) still falls through to the default track", () => {
      expect(resolve({ tracks: frenchOnly, selectedSubtitleId: "off", subtitlesOffPicked: false })).toBe("fr");
      expect(resolve({ tracks: frenchOnly, selectedSubtitleId: "off" })).toBe("fr");
    });

    it("a track picked after Off is kept", () => {
      expect(resolve({ tracks: twoTracks, selectedSubtitleId: "en", subtitlesOffPicked: false })).toBe("en");
    });

    it("no default track: subtitles are off whether or not Off was picked (subtitles off by default)", () => {
      const noDefault = frenchOnly.map((track) => ({ ...track, isDefault: false }));
      expect(resolve({ tracks: noDefault, selectedSubtitleId: "off", subtitlesOffPicked: false })).toBe("off");
      expect(resolve({ tracks: noDefault, selectedSubtitleId: "off", subtitlesOffPicked: true })).toBe("off");
    });
  });

  it("scopes chapters to the effective playback format", () => {
    console.info("[mpv-playback-selection:chapters-scope] resolving chapters for effectiveFormatId=fmt-360 (fmt-1080 chapter must be excluded + reordered by startSeconds)");
    const chapterIds = buildPlaybackChapters({
      fileId: "file-1",
      effectiveFormatId: "fmt-360",
      formats: [
        makeFormat({ id: "fmt-1080", fileId: "file-1", quality: "1080p", codec: "h264" }),
        makeFormat({ id: "fmt-360", fileId: "file-1", quality: "360p", codec: "h264" }),
      ],
      chapters: [
        { id: "c2", formatId: "fmt-360", title: "Two", startSeconds: 20 },
        { id: "c1", formatId: "fmt-360", title: "One", startSeconds: 10 },
        { id: "c3", formatId: "fmt-1080", title: "Ignore", startSeconds: 5 },
      ],
    }).map((chapter) => chapter.id);
    console.info(`[mpv-playback-selection:chapters-scope] chapterIds=${JSON.stringify(chapterIds)} expected=${JSON.stringify(["c1", "c2"])}`);
    if (JSON.stringify(chapterIds) !== JSON.stringify(["c1", "c2"])) {
      dumpSelectionSnapshot("chapters-scope", { effectiveFormatId: "fmt-360", chapterIds });
    }
    expect(chapterIds).toEqual(["c1", "c2"]);
  });

  // #25 run 8053 chapter-nav: the runtime writes chapter rows only for the
  // format produced by the source job (240p); the format job's 360p shares the
  // timeline (chapters are muxed in) but has no rows. Playing 360p left the
  // renderer with zero chapters while mpv itself listed three.
  it("@bugfix @regression-proof uses the file's chapters when the effective format has no chapter rows", () => {
    const chapterIds = buildPlaybackChapters({
      fileId: "file-1",
      effectiveFormatId: "fmt-360",
      formats: [
        makeFormat({ id: "fmt-360", fileId: "file-1", quality: "360p", codec: "h264" }),
        makeFormat({ id: "fmt-240", fileId: "file-1", quality: "240p", codec: "h264" }),
      ],
      chapters: [
        { id: "c3", formatId: "fmt-240", title: "End", startSeconds: 7 },
        { id: "c1", formatId: "fmt-240", title: "Opening", startSeconds: 0 },
        { id: "c2", formatId: "fmt-240", title: "Middle", startSeconds: 3 },
        { id: "other", formatId: "fmt-other-file", title: "Other file", startSeconds: 1 },
      ],
    }).map((chapter) => chapter.id);
    console.info(`[mpv-playback-selection:chapters-file-fallback] chapterIds=${JSON.stringify(chapterIds)}`);
    expect(chapterIds).toEqual(["c1", "c2", "c3"]);
  });

  it("scopes skip markers to the active episode and keeps them ordered", () => {
    console.info("[mpv-playback-selection:skip-markers-scope] resolving skip markers for episode-1 (episode-2 marker must be excluded + ordered by startSeconds)");
    const markerIds = buildPlaybackSkipMarkers(
      [
        makeSkipMarker({ id: "b", episodeId: "episode-1", type: "credits", startSeconds: 80, endSeconds: 90 }),
        makeSkipMarker({ id: "a", episodeId: "episode-1", type: "intro", startSeconds: 10, endSeconds: 20 }),
        makeSkipMarker({ id: "c", episodeId: "episode-2", type: "intro", startSeconds: 5, endSeconds: 15 }),
      ],
      "episode-1"
    ).map((marker) => marker.id);
    console.info(`[mpv-playback-selection:skip-markers-scope] markerIds=${JSON.stringify(markerIds)} expected=${JSON.stringify(["a", "b"])}`);
    if (JSON.stringify(markerIds) !== JSON.stringify(["a", "b"])) {
      dumpSelectionSnapshot("skip-markers-scope", { episodeId: "episode-1", markerIds });
    }
    expect(markerIds).toEqual(["a", "b"]);
  });
});

describe("resolveNextEpisodeFormatId — next-episode quality is the Settings default", () => {
  // Product rule: a new episode always aims for the user's configured
  // playbackQuality (Settings default), regardless of what the previous episode
  // played at. NEITHER an ABR transient NOR a one-off explicit pick carries.
  // The new episode's formats have fresh ids; "360p" is the bottom tier the ABR
  // emergency-downshift drains to as a stream nears EOF; "2160p" is what a user
  // might bump a single episode up to.
  const nextEpisodeFormats = [
    { id: "ep2-2160", quality: "2160p" },
    { id: "ep2-1080", quality: "1080p" },
    { id: "ep2-720", quality: "720p" },
    { id: "ep2-360", quality: "360p" },
  ];
  it("@bugfix @regression-proof aims for the playbackQuality ceiling (NOT the previous episode's ABR-downshifted 360p) when the user never made an explicit pick", () => {
    // Reproduces the reported bug: auto-play-next lands on 360p. By the end of
    // episode 1 the demuxer cache has drained and ABR emergency-downshifted to
    // "360p", so the engine's prior-effective quality is "360p" while the user
    // never touched the quality menu (userTargetQuality === null) and their
    // Settings default is "1080p". The next episode MUST target the Settings
    // default, not the transient — otherwise episode 2 starts at 360p.
    //
    // Pre-fix (carry = userTargetQuality ?? priorEffectiveQuality) returns
    // "ep2-360"; the fix targets playbackQuality → "ep2-1080". The poisoned
    // priorEffectiveQuality is passed so this fails against any resurrection of
    // the ABR-transient carry. @bugfix next-episode-360p-abr-transient-carry
    console.info("[mpv-playback-selection:next-ep] userTarget=null prior=360p(ABR-EOF) settings=1080p → expect ep2-1080");
    const resolved = resolveNextEpisodeFormatId({
      userTargetQuality: null,
      priorEffectiveQuality: "360p",
      playbackQuality: "1080p",
      formats: nextEpisodeFormats,
    });
    console.info(`[mpv-playback-selection:next-ep] resolved=${String(resolved)} expected=ep2-1080`);
    if (resolved !== "ep2-1080") {
      dumpSelectionSnapshot("next-ep-abr-transient", {
        userTargetQuality: null,
        priorEffectiveQuality: "360p",
        playbackQuality: "1080p",
        resolved,
        expected: "ep2-1080",
        nextEpisodeFormats,
      });
    }
    expect(resolved).toBe("ep2-1080");
  });

  it("@bugfix @regression-proof a one-off LOWER pick (720p) on the previous episode does NOT carry — the next episode reverts to the Settings default", () => {
    // The user bumped episode 1 down to 720p via the menu (userTargetQuality ===
    // "720p"); their Settings default is 1080p. Episode 2 must come up at the
    // Settings default 1080p, NOT the 720p one-off. A persistent low-quality
    // preference belongs in Settings, not a per-episode override.
    console.info("[mpv-playback-selection:next-ep] userTarget=720p(pick) prior=360p settings=1080p → expect ep2-1080");
    const resolved = resolveNextEpisodeFormatId({
      userTargetQuality: "720p",
      priorEffectiveQuality: "360p",
      playbackQuality: "1080p",
      formats: nextEpisodeFormats,
    });
    console.info(`[mpv-playback-selection:next-ep] resolved=${String(resolved)} expected=ep2-1080`);
    if (resolved !== "ep2-1080") {
      dumpSelectionSnapshot("next-ep-lower-pick-not-carried", {
        userTargetQuality: "720p",
        priorEffectiveQuality: "360p",
        resolved,
        expected: "ep2-1080",
        nextEpisodeFormats,
      });
    }
    expect(resolved).toBe("ep2-1080");
  });

  it("@bugfix @regression-proof a one-off HIGHER pick (4K/2160p) on the previous episode does NOT carry — the next episode reverts to the Settings default (the user's exact ask)", () => {
    // The user bumped episode 1 up to 4K (userTargetQuality === "2160p"), and
    // 2160p IS available in episode 2 — but their Settings default is 1080p, so
    // episode 2 must still come up at 1080p ("even if the previous episode was
    // 4k it should still aim for 1080p because of that setting").
    console.info("[mpv-playback-selection:next-ep] userTarget=2160p(4K pick, available) prior=360p settings=1080p → expect ep2-1080");
    const resolved = resolveNextEpisodeFormatId({
      userTargetQuality: "2160p",
      priorEffectiveQuality: "360p",
      playbackQuality: "1080p",
      formats: nextEpisodeFormats,
    });
    console.info(`[mpv-playback-selection:next-ep] resolved=${String(resolved)} expected=ep2-1080 (NOT ep2-2160)`);
    if (resolved !== "ep2-1080") {
      dumpSelectionSnapshot("next-ep-higher-pick-not-carried", {
        userTargetQuality: "2160p",
        priorEffectiveQuality: "360p",
        playbackQuality: "1080p",
        resolved,
        expected: "ep2-1080",
        nextEpisodeFormats,
      });
    }
    expect(resolved).toBe("ep2-1080");
  });

  it("@bugfix @regression-proof falls back to the best format below Settings (not 360p) when the Settings default is absent in the new episode", () => {
    // Episode 2 was only ingested up to 1080p but the Settings default is 2160p.
    // The next episode resolves to the best format at or below Settings (1080p) —
    // it must NOT slide down to the prior episode's ABR 360p.
    const ep2NoUhd = [
      { id: "ep2b-1080", quality: "1080p" },
      { id: "ep2b-720", quality: "720p" },
      { id: "ep2b-360", quality: "360p" },
    ];
    console.info("[mpv-playback-selection:next-ep] userTarget=null prior=360p settings=2160p(absent) → expect fallback ep2b-1080");
    const resolved = resolveNextEpisodeFormatId({
      userTargetQuality: null,
      priorEffectiveQuality: "360p",
      playbackQuality: "2160p",
      formats: ep2NoUhd,
    });
    console.info(`[mpv-playback-selection:next-ep] resolved=${String(resolved)} expected=ep2b-1080`);
    if (resolved !== "ep2b-1080") {
      dumpSelectionSnapshot("next-ep-settings-absent", {
        userTargetQuality: null,
        priorEffectiveQuality: "360p",
        playbackQuality: "2160p",
        resolved,
        expected: "ep2b-1080",
        ep2NoUhd,
      });
    }
    expect(resolved).toBe("ep2b-1080");
  });
});

// @req PLAY-QUAL-02[badger-desktop]
describe("@bugfix @regression-proof PLAY-QUAL-02: playback never starts above the Settings quality (#431)", () => {
  // The ladder lacks the Settings rung (1080p). Pre-fix, both the first open
  // (buildMpvPlaybackState) and the next episode (resolveNextEpisodeFormatId)
  // fell back to formats[0], the BEST rung (2160p), i.e. above Settings.
  const noSettingsRung = [
    makeFormat({ id: "f-2160", fileId: "file-1", quality: "2160p", codec: "hevc" }),
    makeFormat({ id: "f-720", fileId: "file-1", quality: "720p", codec: "h264" }),
    makeFormat({ id: "f-360", fileId: "file-1", quality: "360p", codec: "h264" }),
  ];

  const openState = (playbackQuality: "1080p" | "240p", qualityMode: "auto" | "fixed") =>
    buildMpvPlaybackState({
      formats: noSettingsRung,
      playbackQuality,
      selectedFormatId: null,
      qualityMode,
      audioOptions: [],
      selectedAudioId: null,
    });

  it("first open (Auto and Force) starts on the best rung below Settings, not the best of the ladder", () => {
    console.info("[QUAL-02:open] ladder=2160p,720p,360p settings=1080p → expect f-720 (pre-fix f-2160)");
    const auto = openState("1080p", "auto");
    const forced = openState("1080p", "fixed");
    const dump = {
      autoEffective: auto.effectiveFormatId,
      autoFallback: auto.fallbackFormatId,
      forcedEffective: forced.effectiveFormatId,
      forcedFallback: forced.fallbackFormatId,
    };
    console.info(`[QUAL-02:open] state=${JSON.stringify(dump)}`);
    if (dump.autoEffective !== "f-720" || dump.forcedEffective !== "f-720") dumpSelectionSnapshot("qual02-open", dump);
    expect(auto.autoFormat?.id).toBe("f-720");
    expect(auto.effectiveFormatId).toBe("f-720");
    expect(forced.fallbackFormatId).toBe("f-720");
    expect(forced.effectiveFormatId).toBe("f-720");
  });

  it("next episode starts on the best rung below Settings, not the best of the ladder", () => {
    console.info("[QUAL-02:next-ep] ladder=2160p,720p,360p settings=1080p prior=360p pick=2160p → expect f-720");
    const resolved = resolveNextEpisodeFormatId({
      userTargetQuality: "2160p",
      priorEffectiveQuality: "360p",
      playbackQuality: "1080p",
      formats: noSettingsRung,
    });
    console.info(`[QUAL-02:next-ep] resolved=${String(resolved)}`);
    if (resolved !== "f-720") dumpSelectionSnapshot("qual02-next-ep", { resolved, noSettingsRung });
    expect(resolved).toBe("f-720");
  });

  it("Settings below every rung starts on the lightest rung, never the best", () => {
    console.info("[QUAL-02:below-all] ladder=2160p,720p,360p settings=240p → expect f-360");
    const picked = pickSettingsFormat(noSettingsRung, "240p");
    const state = openState("240p", "auto");
    console.info(`[QUAL-02:below-all] picked=${String(picked?.id)} effective=${String(state.effectiveFormatId)}`);
    if (picked?.id !== "f-360") dumpSelectionSnapshot("qual02-below-all", { picked, noSettingsRung });
    expect(picked?.id).toBe("f-360");
    expect(state.effectiveFormatId).toBe("f-360");
  });

  it("an exact Settings rung is still the start", () => {
    const ladder = [...noSettingsRung, makeFormat({ id: "f-1080", fileId: "file-1", quality: "1080p", codec: "h264" })];
    const picked = pickSettingsFormat(ladder, "1080p");
    console.info(`[QUAL-02:exact] picked=${String(picked?.id)}`);
    expect(picked?.id).toBe("f-1080");
  });
});

describe("OCR twins never reach the desktop player (PLAY-TRACK-05)", () => {
  const picture = makeSubtitleTrack({
    id: "pgs-fr",
    label: "Français",
    language: "fr",
    isDefault: true,
    episodeId: null,
    objectKey: "subs-fr-pgs/fre.sup",
    format: "sup",
  });
  const twin = makeSubtitleTrack({
    id: "pgs-fr-ocr",
    label: "Français",
    language: "fr",
    isDefault: false,
    episodeId: null,
    objectKey: "subs-fr-pgs/fre.ocr.srt",
    format: "srt",
    source: "ocr",
    derivedFromSubtitleId: "pgs-fr",
  });

  // @req PLAY-TRACK-05
  it("lists and selects the picture track, never its twin", () => {
    const resolved = resolvePlaybackSubtitleState({
      subtitleTracks: [picture, twin],
      episodeId: null,
      selectedSubtitleId: "pgs-fr-ocr",
      subtitlesOffLabel: "Off",
    });
    const optionIds = resolved.options.map((option) => option.id);
    console.info(`[mpv-playback-selection:ocr-twin] optionIds=${JSON.stringify(optionIds)} selected=${resolved.selectedSubtitleId}`);
    expect(optionIds).toEqual(["off", "pgs-fr"]);
    expect(resolved.selectedSubtitleId).toBe("pgs-fr");
  });
});
