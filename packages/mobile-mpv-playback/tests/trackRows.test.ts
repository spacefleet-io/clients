/**
 * @test-id MPV-TRACKROWS-001
 * @level unit
 * @why PLAY-TRACK-02 on the phone: whenever a file has subtitle tracks the subtitle menu lists an "Off" row FIRST, in the
 *   app's language, and choosing it selects index -1 (which `applySubtitlePick` turns into "remove every subtitle", see
 *   subtitlePick.test.ts). The audio menu never has an "Off" row. The spec note once said the word was hardcoded English:
 *   the label is `player.controls.subtitlesOff` in the translation files (`PlayerScreen.tsx` passes it to the controls).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildAudioRows,
  buildQualityRows,
  buildSubtitleRows,
  chapterRowTitle,
  pickerRowAccessibilityLabel,
} from "../src/trackRows";
import type { AudioTrack, SubtitleTrack, VideoFormat } from "../src/types";

const subs = [
  { id: "s1", label: "fr", language: "fr" },
  { id: "s2", label: "English SDH", language: "en" },
] as unknown as SubtitleTrack[];
const audios = [
  { id: "a1", label: "English 5.1", language: "en" },
  { id: "a2", label: "fr", language: "fr" },
] as unknown as AudioTrack[];

const fallback = (n: number) => `Track ${n}`;
const dump = (label: string, value: unknown) => console.info(`MPV-TRACKROWS ${label}: ${JSON.stringify(value)}`);

const translation = (lang: "en" | "fr"): string => {
  const file = resolve(__dirname, "../../mobile-shell/src/i18n", `${lang}.json`);
  const json = JSON.parse(readFileSync(file, "utf8")) as { player: { controls: { subtitlesOff?: string } } };
  return json.player.controls.subtitlesOff ?? "";
};

describe("subtitle menu rows", () => {
  /** @req PLAY-TRACK-02[badger-mobile,badger-tv] */
  it("lists Off first, then every track, with the label it is given", () => {
    const rows = buildSubtitleRows(subs, 1, "Aucun", fallback, () => {}, () => false);
    dump("subtitle rows", rows.map((r) => ({ key: r.key, title: r.title, selected: r.selected })));
    expect(rows.map((r) => r.key)).toEqual(["__off__", "s1", "s2"]);
    expect(rows[0]!.title).toBe("Aucun");
    expect(rows[0]!.testID).toBe("player-subtitle-option-off");
    expect(rows.map((r) => r.selected)).toEqual([false, false, true]);
  });

  /** @req PLAY-TRACK-02[badger-mobile,badger-tv] */
  it("Off is the selected row when no subtitle is showing", () => {
    const rows = buildSubtitleRows(subs, -1, "Off", fallback, () => {}, () => false);
    dump("off selected", rows.map((r) => ({ key: r.key, selected: r.selected })));
    expect(rows.filter((r) => r.selected).map((r) => r.key)).toEqual(["__off__"]);
  });

  /** @req PLAY-TRACK-02[badger-mobile,badger-tv] */
  it("choosing Off selects index -1, choosing a track selects its index", () => {
    const select = vi.fn();
    const rows = buildSubtitleRows(subs, 0, "Off", fallback, select, () => false);
    rows[0]!.onPress();
    rows[2]!.onPress();
    dump("select calls", select.mock.calls);
    expect(select.mock.calls).toEqual([[-1], [1]]);
  });

  /** @req PLAY-TRACK-02[badger-mobile,badger-tv] */
  it("the Off label comes from the translation files, translated in French", () => {
    const en = translation("en");
    const fr = translation("fr");
    dump("labels", { en, fr });
    expect(en).toBe("Off");
    expect(fr).not.toBe("");
    expect(fr).not.toBe(en);
  });
});

describe("the subtitle menu's \"Get more subtitles…\" row (PLAY-SUBGET-02, -12)", () => {
  /** @req PLAY-SUBGET-02[badger-mobile] */
  it("is the last row, and picking it opens the search without selecting a track", () => {
    const select = vi.fn();
    const open = vi.fn();
    const rows = buildSubtitleRows(subs, 0, "Off", fallback, select, () => false, {
      title: "Get more subtitles…",
      unavailableReason: null,
      onPress: open,
    });
    dump("get more rows", rows.map((r) => ({ key: r.key, title: r.title, disabled: r.disabled })));
    const last = rows[rows.length - 1]!;
    expect(rows.map((r) => r.key)).toEqual(["__off__", "s1", "s2", "__get_more__"]);
    expect(last.testID).toBe("player-subtitle-option-get-more");
    expect(last.selected).toBe(false);
    expect(last.disabled).toBeFalsy();
    last.onPress();
    expect(open).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
  });

  /** @req PLAY-SUBGET-12[badger-mobile] */
  it("is greyed out with the reason while offline", () => {
    const rows = buildSubtitleRows(subs, 0, "Off", fallback, () => {}, () => false, {
      title: "Get more subtitles…",
      unavailableReason: "Needs an internet connection",
      onPress: () => {},
    });
    const last = rows[rows.length - 1]!;
    expect(last.disabled).toBe(true);
    expect(last.subtitle).toBe("Needs an internet connection");
  });

  it("is absent without the option", () => {
    expect(buildSubtitleRows(subs, 0, "Off", fallback, () => {}, () => false).map((r) => r.key)).not.toContain("__get_more__");
  });
});

describe("the subtitle menu with no subtitle track (PLAY-SUBGET-23, -24)", () => {
  const getMore = { title: "Get more subtitles…", unavailableReason: null, onPress: () => {} };

  /** @req PLAY-SUBGET-24[badger-mobile] @req PLAY-SUBGET-23[badger-mobile] */
  it("phone: Off, Get more subtitles…, then Add a subtitle file…, which opens the picker without selecting a track", () => {
    const select = vi.fn();
    const addFile = vi.fn();
    const rows = buildSubtitleRows([], -1, "Off", fallback, select, () => false, getMore, null, {
      title: "Add a subtitle file…",
      unavailableReason: null,
      onPress: addFile,
    });
    dump("phone 0 tracks rows", rows.map((r) => ({ key: r.key, title: r.title, disabled: r.disabled })));
    expect(rows.map((r) => r.title)).toEqual(["Off", "Get more subtitles…", "Add a subtitle file…"]);
    const last = rows[rows.length - 1]!;
    expect(last.testID).toBe("player-subtitle-option-add-file");
    expect(last.selected).toBe(false);
    expect(last.disabled).toBeFalsy();
    last.onPress();
    expect(addFile).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
  });

  /** @req PLAY-SUBGET-24[badger-tv] */
  it("TV: Off and Get more subtitles…, no file row", () => {
    const rows = buildSubtitleRows([], -1, "Off", fallback, () => {}, () => false, getMore, null, null);
    dump("tv 0 tracks rows", rows.map((r) => r.key));
    expect(rows.map((r) => r.key)).toEqual(["__off__", "__get_more__"]);
  });

  /** @req PLAY-SUBGET-23[badger-mobile] @req PLAY-SUBGET-12[badger-mobile] */
  it("phone offline: Add a subtitle file… is greyed out with the reason", () => {
    const rows = buildSubtitleRows([], -1, "Off", fallback, () => {}, () => false, getMore, null, {
      title: "Add a subtitle file…",
      unavailableReason: "Needs an internet connection",
      onPress: () => {},
    });
    const last = rows[rows.length - 1]!;
    expect(last.key).toBe("__add_file__");
    expect(last.disabled).toBe(true);
    expect(last.subtitle).toBe("Needs an internet connection");
  });

  /** @req PLAY-SUBGET-23[badger-mobile] @req PLAY-SUBGET-07[badger-mobile] */
  it("with tracks: Add a subtitle file… right after Get more, before Try another version", () => {
    const fetched = [{ id: "s1", label: "French", language: "fr", source: "fetched:9" }] as unknown as SubtitleTrack[];
    const rows = buildSubtitleRows(
      fetched,
      0,
      "Off",
      fallback,
      () => {},
      () => false,
      getMore,
      { title: "Try another version", isFetched: () => true, unavailableReason: null, onPress: () => {} },
      { title: "Add a subtitle file…", unavailableReason: null, onPress: () => {} },
    );
    expect(rows.map((r) => r.key)).toEqual(["__off__", "s1", "__get_more__", "__add_file__", "__try_another__"]);
  });
});

describe("the subtitle menu's \"Try another version\" row (PLAY-SUBGET-07)", () => {
  const fetchedSubs = [
    { id: "s1", label: "French", language: "fr", source: "fetched:9" },
    { id: "s2", label: "English", language: "en", source: "srt" },
  ] as unknown as SubtitleTrack[];
  const getMore = { title: "Get more subtitles…", unavailableReason: null, onPress: () => {} };
  const tryAnother = (onPress: (track: SubtitleTrack) => void, unavailableReason: string | null = null) => ({
    title: "Try another version",
    isFetched: (track: SubtitleTrack) => (track.source ?? "").startsWith("fetched"),
    unavailableReason,
    onPress,
  });

  /** @req PLAY-SUBGET-07[badger-mobile,badger-tv] */
  it("follows Get more while the subtitle on is a fetched one, and hands that track to the owner", () => {
    const select = vi.fn();
    const picked = vi.fn();
    const rows = buildSubtitleRows(fetchedSubs, 0, "Off", fallback, select, () => false, getMore, tryAnother(picked));
    dump("try another rows", rows.map((r) => ({ key: r.key, title: r.title, disabled: r.disabled })));
    expect(rows.map((r) => r.key)).toEqual(["__off__", "s1", "s2", "__get_more__", "__try_another__"]);
    const last = rows[rows.length - 1]!;
    expect(last.testID).toBe("player-subtitle-option-try-another");
    expect(last.title).toBe("Try another version");
    expect(last.selected).toBe(false);
    expect(last.disabled).toBeFalsy();
    last.onPress();
    expect(picked).toHaveBeenCalledWith(fetchedSubs[0]);
    expect(select).not.toHaveBeenCalled();
  });

  /** @req PLAY-SUBGET-07[badger-mobile,badger-tv] */
  it("is absent while the subtitle on came with the file, or subtitles are off", () => {
    for (const activeIdx of [1, -1]) {
      const keys = buildSubtitleRows(fetchedSubs, activeIdx, "Off", fallback, () => {}, () => false, getMore, tryAnother(() => {})).map(
        (r) => r.key,
      );
      dump(`try another absent (active ${activeIdx})`, keys);
      expect(keys).not.toContain("__try_another__");
    }
  });

  /** @req PLAY-SUBGET-07[badger-mobile,badger-tv] @req PLAY-SUBGET-12[badger-mobile,badger-tv] */
  it("is greyed out with the reason while offline", () => {
    const picked = vi.fn();
    const rows = buildSubtitleRows(fetchedSubs, 0, "Off", fallback, () => {}, () => false, getMore, tryAnother(picked, "Needs an internet connection"));
    const last = rows[rows.length - 1]!;
    expect(last.key).toBe("__try_another__");
    expect(last.disabled).toBe(true);
    expect(last.subtitle).toBe("Needs an internet connection");
  });
});

describe("the subtitle menu of a video with no subtitle (PLAY-SUBGET-24)", () => {
  /** @req PLAY-SUBGET-24[badger-mobile,badger-tv] */
  it("is Off then Get more subtitles…, which searches only when picked", () => {
    const onPress = vi.fn();
    const rows = buildSubtitleRows([], -1, "Off", fallback, () => {}, () => false, { title: "Get more subtitles…", unavailableReason: null, onPress });
    dump("no tracks", rows.map((row) => row.title));
    expect(rows.map((row) => row.testID)).toEqual(["player-subtitle-option-off", "player-subtitle-option-get-more"]);
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe("subtitle rows the TV can't show (PLAY-TRACK-05)", () => {
  // @req PLAY-TRACK-05
  it("keeps an unplayable track listed but disabled, and every other row enabled", () => {
    const rows = buildSubtitleRows(subs, -1, "Off", fallback, () => {}, (track) => track.id === "s2");
    dump("disabled rows", rows.map((r) => ({ key: r.key, disabled: r.disabled })));
    expect(rows.map((r) => r.key)).toEqual(["__off__", "s1", "s2"]);
    expect(rows.map((r) => r.disabled === true)).toEqual([false, false, true]);
  });
});

describe("audio menu rows", () => {
  /** @req PLAY-TRACK-02[badger-mobile,badger-tv] */
  it("has one row per audio track and no Off row", () => {
    const rows = buildAudioRows(audios, 0, fallback, () => {});
    dump("audio rows", rows.map((r) => ({ key: r.key, title: r.title, testID: r.testID })));
    expect(rows.map((r) => r.key)).toEqual(["a1", "a2"]);
    expect(rows.some((r) => r.key === "__off__" || /off/.test(r.testID ?? ""))).toBe(false);
    expect(rows.map((r) => r.selected)).toEqual([true, false]);
  });
});

describe("screen reader labels of the player sheets (UX-A11Y-04)", () => {
  it("a track row is announced by its visible text, never by its testID", () => {
    const rows = [...buildSubtitleRows(subs, 1, "Off", fallback, vi.fn(), () => false), ...buildAudioRows(audios, 0, fallback, vi.fn())];
    const spoken = rows.map((row) => ({ testID: row.testID, label: pickerRowAccessibilityLabel(row) }));
    dump("a11y.rows", spoken);
    for (const { testID, label } of spoken) {
      expect(label).not.toBe(testID);
      expect(label).not.toMatch(/^player-|-\d+$/u);
      expect(label.length).toBeGreaterThan(0);
    }
    expect(spoken.map((s) => s.label)).toContain("Off");
    expect(spoken.map((s) => s.label)).toContain("English 5.1, EN");
  });

  it("a chapter row is announced by its number, name and start time", () => {
    expect(chapterRowTitle(0, "Opening")).toBe("#1: Opening");
    expect(chapterRowTitle(3, "  ")).toBe("#4");
    expect(pickerRowAccessibilityLabel({ title: chapterRowTitle(1, "Act II"), subtitle: "12:03" })).toBe("#2: Act II, 12:03");
  });

  it("PlayerControls passes the human label to every row and button (no testID fallback left)", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../src/components/PlayerControls.tsx"), "utf8");
    const offenders = source.split("\n").filter((line) => /accessibilityLabel=\{[^}]*testID/u.test(line));
    dump("a11y.offenders", offenders);
    expect(offenders).toEqual([]);
    expect(source).toMatch(/accessibilityLabel=\{pickerRowAccessibilityLabel\(row\)\}/u);
    expect(source).toMatch(/accessibilityLabel=\{pickerRowAccessibilityLabel\(\{ title: heading/u);
  });
});

describe("quality menu order", () => {
  const v = (id: string, quality: string, codec = "h264") => ({ id, quality, codec }) as unknown as VideoFormat;
  // Upload order of the seeded LOTR film on the 2026-11-08 Google TV run: the menu showed 720p, 420p, 360p, 2160p, 144p.
  const videos = [v("v720", "720p"), v("v420", "420p"), v("v360", "360p"), v("v2160", "2160p", "hevc"), v("v144", "144p"), v("v1080", "1080p")];

  /** @req UX-TV-07[badger-tv] */
  it("lists Auto then every quality highest first, whatever the library order", () => {
    const rows = buildQualityRows(videos, "v1080", "auto", "Auto", () => {});
    dump("quality order", rows.map((r) => r.title));
    expect(rows.map((r) => r.title)).toEqual(["Auto", "2160p", "1080p", "720p", "420p", "360p", "144p"]);
    expect(rows[0]).toMatchObject({ subtitle: "1080p", selected: true });
  });

  it("puts the HEVC copy before the H.264 one at one height (the shared ladder order), suffixes the second testID, and picks by id", () => {
    const select = vi.fn();
    const rows = buildQualityRows([v("a", "1080p"), v("odd", "source"), v("b", "1080p", "hevc")], "b", "manual", "Auto", select);
    expect(rows.map((r) => r.testID)).toEqual(["player-quality-option-auto", "player-quality-option-1080p", "player-quality-option-1080p-h264", "player-quality-option-source"]);
    expect(rows.find((r) => r.selected)?.key).toBe("b");
    rows[3].onPress();
    expect(select).toHaveBeenCalledWith("odd");
  });
});
