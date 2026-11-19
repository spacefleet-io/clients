/**
 * @req PLAY-SUBGET-07[badger-desktop,badger-mobile,badger-tv,badger-web-player]
 *
 * "Try another version" (issue #2502, Chris 2026-11-15: a fetched subtitle was out of sync and there was no way to get
 * another one of the same language). The shared steps every client's player runs: look the subtitles up again, take
 * the file after the one the track holds in its entry's ranked list, and put it in place of the track (same name,
 * same language, one track), or say none is left.
 *
 * @req META-SRC-09[badger-desktop,badger-mobile,badger-tv,badger-web-player] A fetched track's source names no metadata
 * source; tracks stored by older apps under the legacy name still read as fetched.
 */
import { describe, expect, it } from "vitest";
import { LEGACY_FETCHED_SUBTITLE_SOURCE } from "../src/legacyFormat";
import {
  buildSubtitleEntries,
  fetchedSubtitleFileId,
  fetchedSubtitleSource,
  isFetchedSubtitleSource,
  nextSubtitleVersion,
  replaceFetchedSubtitle,
  subtitleFetchCopy,
  subtitleFetchLabels,
  type FetchedSubtitleTrack,
  type SubtitleFetchCandidate,
} from "../src/subtitleFetch";
import { subtitleVersionLine, tryAnotherSubtitleVersion, type SubtitleVersionStep } from "../src/subtitleFetchFlow";

const labels = subtitleFetchLabels(subtitleFetchCopy("en"));

const candidate = (fileId: number, over: Partial<SubtitleFetchCandidate> = {}): SubtitleFetchCandidate => ({
  fileId,
  language: "es",
  hearingImpaired: false,
  foreignPartsOnly: false,
  release: "Sandglass (2021) 1080p WEB-DL",
  fileName: "Sandglass.2021.srt",
  downloadCount: 1000 - fileId,
  ready: true,
  ...over,
});

// Ranked by download count: 11, 12, 13 (Spanish); 21 (Spanish, hearing impaired); 31 (French).
const CANDIDATES = [candidate(12), candidate(13), candidate(11), candidate(21, { hearingImpaired: true }), candidate(31, { language: "fr" })];
const entries = () => buildSubtitleEntries({ candidates: CANDIDATES, uiLanguage: "en", labels });
const spanish = (source: string, label = "Spanish"): FetchedSubtitleTrack => ({ id: "track-1", language: "es", label, source });

describe("the source of a fetched track names its file", () => {
  it("writes and reads the file ID", () => {
    expect(fetchedSubtitleSource(42)).toBe("fetched:42");
    expect(fetchedSubtitleFileId("fetched:42")).toBe(42);
    expect(fetchedSubtitleFileId("fetched")).toBeNull();
    expect(fetchedSubtitleFileId("srt")).toBeNull();
    expect(fetchedSubtitleFileId("srt:42")).toBeNull();
    expect(isFetchedSubtitleSource("fetched:42")).toBe(true);
    expect(isFetchedSubtitleSource("fetched")).toBe(true);
    expect(isFetchedSubtitleSource("srt")).toBe(false);
    expect(isFetchedSubtitleSource(null)).toBe(false);
  });

  it("reads a track stored by an older app under the legacy source name, with or without its file ID", () => {
    expect(fetchedSubtitleFileId(`${LEGACY_FETCHED_SUBTITLE_SOURCE}:42`)).toBe(42);
    expect(fetchedSubtitleFileId(LEGACY_FETCHED_SUBTITLE_SOURCE)).toBeNull();
    expect(isFetchedSubtitleSource(`${LEGACY_FETCHED_SUBTITLE_SOURCE}:42`)).toBe(true);
    expect(isFetchedSubtitleSource(LEGACY_FETCHED_SUBTITLE_SOURCE)).toBe(true);
    expect(nextSubtitleVersion(entries(), spanish(`${LEGACY_FETCHED_SUBTITLE_SOURCE}:11`), labels)?.file.fileId).toBe(12);
  });
});

describe("nextSubtitleVersion walks down the track's entry", () => {
  it("takes the file after the one the track holds, then the next, then none", () => {
    const list = entries();
    expect(nextSubtitleVersion(list, spanish("fetched:11"), labels)?.file.fileId).toBe(12);
    expect(nextSubtitleVersion(list, spanish("fetched:12"), labels)?.file.fileId).toBe(13);
    expect(nextSubtitleVersion(list, spanish("fetched:13"), labels)).toBeNull();
  });

  it("stays inside the track's kind: the hearing-impaired entry has no second file", () => {
    expect(nextSubtitleVersion(entries(), spanish("fetched:21", "Spanish (Hearing impaired)"), labels)).toBeNull();
  });

  it("a track fetched before its file was recorded held the best file: the next is the second", () => {
    const next = nextSubtitleVersion(entries(), spanish("fetched", "Spanish 2"), labels);
    expect(next?.entry.name).toBe("Spanish");
    expect(next?.file.fileId).toBe(12);
  });

  it("a file no longer listed starts again from the best one", () => {
    expect(nextSubtitleVersion(entries(), spanish("fetched:99"), labels)?.file.fileId).toBe(11);
  });

  it("no entry for the track's language: nothing to try", () => {
    expect(nextSubtitleVersion(entries(), { id: "t", language: "de", label: "German", source: "fetched:5" }, labels)).toBeNull();
  });
});

describe("replaceFetchedSubtitle", () => {
  // A recording library: `inUse` lists the stored files some other row still names once the old track is gone.
  const recording = (over: { inUse?: string[]; failAdd?: boolean; failRemove?: boolean; failDelete?: boolean } = {}) => {
    const calls: unknown[] = [];
    const deleteFailures: string[] = [];
    const deps = {
      download: async (fileId: number) => (calls.push(["download", fileId]), { format: "srt" as const, content: "1\n" }),
      upload: async (content: string, format: string) => (calls.push(["upload", content, format]), "obj/new"),
      addTrack: async (track: unknown) => {
        calls.push(["addTrack", track]);
        if (over.failAdd) throw new Error("add failed");
      },
      removeTrack: async (id: string) => {
        calls.push(["removeTrack", id]);
        if (over.failRemove) throw new Error("remove failed");
      },
      objectInUse: async (key: string) => (calls.push(["inUse", key]), (over.inUse ?? []).includes(key)),
      deleteObject: async (key: string) => {
        calls.push(["delete", key]);
        if (over.failDelete) throw new Error("vault down");
      },
      onDeleteFailed: (key: string) => void deleteFailures.push(key),
      rememberChoice: async (choice: unknown) => void calls.push(["remember", choice]),
    };
    return { calls, deleteFailures, deps };
  };
  const stored = (label = "Spanish"): FetchedSubtitleTrack => ({ ...spanish("fetched:11", label), objectKey: "obj/old" });

  it("adds the new file under the same name and language, drops the old track, deletes its unused file, remembers it", async () => {
    const { calls, deps } = recording();
    const stages: string[] = [];
    await replaceFetchedSubtitle(stored("Spanish 2"), candidate(12), (stage) => stages.push(stage), deps);
    console.info("[subtitle-version] replace", JSON.stringify(calls));
    expect(stages).toEqual(["downloading", "saving"]);
    expect(calls).toEqual([
      ["download", 12],
      ["upload", "1\n", "srt"],
      ["addTrack", { language: "es", label: "Spanish 2", objectKey: "obj/new", format: "srt", source: "fetched:12" }],
      ["removeTrack", "track-1"],
      ["inUse", "obj/old"],
      ["delete", "obj/old"],
      ["remember", { language: "es", format: "srt" }],
    ]);
  });

  it("keeps the old file while another row still names it", async () => {
    const { calls, deps } = recording({ inUse: ["obj/old"] });
    await replaceFetchedSubtitle(stored(), candidate(12), () => {}, deps);
    expect(calls).toContainEqual(["inUse", "obj/old"]);
    expect(calls.filter((call) => (call as unknown[])[0] === "delete")).toEqual([]);
  });

  it("a track with no recorded file deletes nothing", async () => {
    const { calls, deps } = recording();
    await replaceFetchedSubtitle(spanish("fetched:11"), candidate(12), () => {}, deps);
    expect(calls.filter((call) => ["inUse", "delete"].includes((call as unknown[])[0] as string))).toEqual([]);
  });

  it("a failed add keeps the old track and its file, and deletes the new file it stored", async () => {
    const { calls, deps } = recording({ failAdd: true });
    await expect(replaceFetchedSubtitle(stored(), candidate(12), () => {}, deps)).rejects.toThrow("add failed");
    console.info("[subtitle-version] failed add", JSON.stringify(calls));
    expect(calls).not.toContainEqual(["removeTrack", "track-1"]);
    expect(calls).not.toContainEqual(["delete", "obj/old"]);
    expect(calls).toContainEqual(["delete", "obj/new"]);
  });

  it("a failed removal of the old track keeps its file", async () => {
    const { calls, deps } = recording({ failRemove: true });
    await expect(replaceFetchedSubtitle(stored(), candidate(12), () => {}, deps)).rejects.toThrow("remove failed");
    expect(calls.filter((call) => (call as unknown[])[0] === "delete")).toEqual([]);
  });

  it("a delete that fails is reported, not thrown: the subtitle is already replaced", async () => {
    const { calls, deleteFailures, deps } = recording({ failDelete: true });
    await replaceFetchedSubtitle(stored(), candidate(12), () => {}, deps);
    expect(deleteFailures).toEqual(["obj/old"]);
    expect(calls).toContainEqual(["remember", { language: "es", format: "srt" }]);
  });

  it("aborted mid-download leaves the old track alone", async () => {
    const controller = new AbortController();
    const { calls, deps } = recording();
    const run = replaceFetchedSubtitle(stored(), candidate(12), () => {}, { ...deps, download: async () => (controller.abort(), calls.push("download"), { format: "srt", content: "1\n" }) }, controller.signal);
    await expect(run).rejects.toThrow();
    expect(calls).toEqual(["download"]);
  });
});

describe("tryAnotherSubtitleVersion", () => {
  const run = async (over: Partial<Parameters<typeof tryAnotherSubtitleVersion>[0]> = {}, signal = new AbortController().signal) => {
    const steps: SubtitleVersionStep[] = [];
    const replaced: number[] = [];
    const outcome = await tryAnotherSubtitleVersion(
      {
        uiLanguage: "en",
        track: spanish("fetched:11"),
        search: async () => ({ reachable: true, subtitles: CANDIDATES }),
        replace: async (file, report) => {
          report("downloading");
          report("saving");
          replaced.push(file.fileId);
        },
        ...over,
      },
      (step) => steps.push(step),
      signal
    );
    console.info("[subtitle-version]", JSON.stringify({ outcome, steps, replaced }));
    return { outcome, steps, replaced };
  };

  it("looks, then replaces the track with the next file of its entry", async () => {
    expect(await run()).toEqual({ outcome: "replaced", steps: ["looking", "downloading", "saving", "replaced"], replaced: [12] });
  });

  it("says none is left at the end of the list", async () => {
    expect(await run({ track: spanish("fetched:13") })).toEqual({ outcome: "none-left", steps: ["looking", "none-left"], replaced: [] });
  });

  it("an unreachable site with nothing cached reads as unavailable, not as none left", async () => {
    expect((await run({ search: async () => ({ reachable: false, subtitles: [] }) })).outcome).toBe("unavailable");
    expect((await run({ search: async () => Promise.reject(new Error("down")) })).outcome).toBe("unavailable");
  });

  it("a failed download reads as failed", async () => {
    expect((await run({ replace: async () => Promise.reject(new Error("boom")) })).outcome).toBe("failed");
  });

  it("aborted (Back) ends with null and reports no outcome", async () => {
    const controller = new AbortController();
    const result = await run({ search: async () => (controller.abort(), { reachable: true, subtitles: CANDIDATES }) }, controller.signal);
    expect(result).toEqual({ outcome: null, steps: ["looking"], replaced: [] });
  });

  it("each step has a line naming the subtitle, in the UI language", () => {
    const en = subtitleFetchCopy("en");
    expect(subtitleVersionLine(en, "looking", "Spanish")).toBe("Looking for another version…");
    expect(subtitleVersionLine(en, "replaced", "Spanish")).toBe("Spanish replaced with another version");
    expect(subtitleVersionLine(en, "none-left", "Spanish")).toBe("No other version of Spanish left");
    expect(subtitleVersionLine(subtitleFetchCopy("fr"), "none-left", "Espagnol")).toBe("Plus d'autre version pour Espagnol");
  });
});
