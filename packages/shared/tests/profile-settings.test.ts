/**
 * @test-id SHARED-PROFILE-SETTINGS-001
 * @level unit
 *
 * ACCT-SQUAD-03: a profile's playback settings and app language live in the encrypted library as one
 * `[p:<pid>:]profile_settings_v1` value, read and written the same way by desktop, phone and TV. A field absent
 * from the value means "this profile never had it" (the app seeds it from the device); junk fields read as absent.
 */
import { describe, expect, it } from "vitest";
import type { LibraryOp } from "../src/libraryOps";
import type { ProfileSettingsPatch } from "../src/profileSettings";
import { MAIN_VIEWING_SCOPE, planMainPromotion, viewingScopeFor } from "../src/profileViewing";
import {
  PROFILE_SETTINGS_KEY,
  PROFILE_SETTINGS_SEED_AT,
  isProfileSettingsKey,
  mergeProfileSettings,
  mergeProfileSettingsOps,
  resetProfileSettingsValue,
  missingProfileSettings,
  parseProfileSettings,
  profileSettingsSeedAt,
  profileSubtitleLanguage,
  subtitleLanguageTexts,
  withSubtitleLanguageTexts,
  scopedProfileSettingsKey,
  serializeProfileSettings,
} from "../src/profileSettings";

const TAG = "[profile-settings]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

describe("profile settings value (ACCT-SQUAD-03)", () => {
  it("@req ACCT-SQUAD-03 the main profile uses the library's own key, another profile its p:<id>: key", () => {
    expect(PROFILE_SETTINGS_KEY).toBe("profile_settings_v1");
    expect(scopedProfileSettingsKey(MAIN_VIEWING_SCOPE)).toBe("profile_settings_v1");
    expect(scopedProfileSettingsKey(viewingScopeFor({ id: "kids", isMain: false }))).toBe("p:kids:profile_settings_v1");
  });

  it("@req ACCT-SQUAD-03 every field round-trips; junk fields read as absent; unknown fields are kept", () => {
    const merged = mergeProfileSettings(
      null,
      {
        autoplayNextEpisode: false,
        autoSkipIntro: false,
        autoSkipCredits: true,
        quality: "720p",
        forceQuality: true,
        audioLanguage: "fra",
        skipMode: "manual",
      },
      "2026-10-30T10:00:00.000Z"
    );
    const parsed = parseProfileSettings(serializeProfileSettings(merged));
    log("round-trip", parsed);
    expect(parsed).toEqual({
      autoplayNextEpisode: false,
      autoSkipIntro: false,
      autoSkipCredits: true,
      quality: "720p",
      forceQuality: true,
      audioLanguage: "fr",
      skipMode: "manual",
      fieldUpdatedAt: Object.fromEntries(
        ["autoplayNextEpisode", "autoSkipIntro", "autoSkipCredits", "forceQuality", "quality", "audioLanguage", "skipMode"].map(
          (key) => [key, "2026-10-30T10:00:00.000Z"]
        )
      ),
      updatedAt: "2026-10-30T10:00:00.000Z",
    });

    const junk = parseProfileSettings(
      JSON.stringify({ autoplayNextEpisode: "yes", quality: "8k", audioLanguage: 3, uiLanguage: "", future: { a: 1 }, updatedAt: "t" })
    );
    log("junk", junk);
    expect(junk).toEqual({ future: { a: 1 }, fieldUpdatedAt: { future: "t" }, updatedAt: "t" });
    // @req UX-I18N-07 the app language is the account's: a profile's old stored `uiLanguage` is dropped, not kept.
    const legacy = parseProfileSettings(
      JSON.stringify({ quality: "720p", uiLanguage: "fr", fieldUpdatedAt: { uiLanguage: "t" }, updatedAt: "t" })
    );
    log("legacy uiLanguage", legacy);
    expect(legacy).toEqual({ quality: "720p", fieldUpdatedAt: { quality: "t" }, updatedAt: "t" });
    expect(parseProfileSettings("not json")).toBeNull();
    expect(parseProfileSettings("")).toBeNull();
    expect(parseProfileSettings(null)).toBeNull();
  });

  it("@req ACCT-SQUAD-03 a patch changes only its fields; null audio language means Original", () => {
    const first = mergeProfileSettings(null, { quality: "1080p", audioLanguage: "en" }, "t1");
    const second = mergeProfileSettings(first, { audioLanguage: null }, "t2");
    log("merge", second);
    expect(second).toEqual({ quality: "1080p", audioLanguage: null, fieldUpdatedAt: { quality: "t1", audioLanguage: "t2" }, updatedAt: "t2" });
  });

  it("@req ACCT-SQUAD-03 the subtitle language parses, normalizes, clears to no preference and is never seeded", () => {
    const set = mergeProfileSettings(null, { subtitleLanguage: "fra" }, "t1");
    const parsed = parseProfileSettings(serializeProfileSettings(set));
    const cleared = mergeProfileSettings(parsed, { subtitleLanguage: null }, "t2");
    const junk = parseProfileSettings(JSON.stringify({ subtitleLanguage: 7, updatedAt: "t" }));
    log("subtitle-language", { parsed, cleared, junk });
    expect(parsed?.subtitleLanguage).toBe("fr");
    expect(cleared.subtitleLanguage).toBeNull();
    expect(junk?.subtitleLanguage).toBeUndefined();
    expect(missingProfileSettings(null)).not.toContain("subtitleLanguage");
  });

  it("@req ACCT-SQUAD-03 the fields a profile never had are listed for seeding", () => {
    expect(missingProfileSettings(null)).toEqual([
      "autoplayNextEpisode",
      "autoSkipIntro",
      "autoSkipCredits",
      "quality",
      "forceQuality",
      "audioLanguage",
    ]);
    expect(missingProfileSettings({ quality: "720p", audioLanguage: null, updatedAt: "t" })).toEqual([
      "autoplayNextEpisode",
      "autoSkipIntro",
      "autoSkipCredits",
      "forceQuality",
    ]);
  });

  it("@req ACCT-SQUAD-03 @req ACCT-PROF-02 deleting the main profile moves the new main's settings into the library's own key", () => {
    const plan = planMainPromotion({
      newMainId: "kids",
      settingRows: [
        { key: "profile_settings_v1", value: '{"quality":"2160p","updatedAt":"t0"}' },
        { key: "p:kids:profile_settings_v1", value: '{"quality":"480p","updatedAt":"t1"}' },
      ],
      mainProgress: [],
      mainPlaylists: [],
    });
    log("promotion", plan.settings);
    expect(plan.settings).toEqual([{ key: "profile_settings_v1", value: '{"quality":"480p","updatedAt":"t1"}' }]);
    expect(plan.finish).toContainEqual({ key: "p:kids:profile_settings_v1", value: "" });

    const none = planMainPromotion({
      newMainId: "kids",
      settingRows: [{ key: "profile_settings_v1", value: '{"quality":"2160p","updatedAt":"t0"}' }],
      mainProgress: [],
      mainPlaylists: [],
    });
    log("promotion without settings", none.settings);
    expect(none.settings, "the deleted main's settings are cleared so the new main seeds its own").toEqual([
      { key: "profile_settings_v1", value: "" },
    ]);
  });
});

const T1 = "2026-10-30T10:00:00.000Z";
const T2 = "2026-10-30T11:00:00.000Z";
const T3 = "2026-10-30T12:00:00.000Z";
const setOp = (id: string, key: string, value: string, updatedAt: string): LibraryOp => ({
  id,
  type: "setting.set",
  createdAt: updatedAt,
  payload: { key, value, updatedAt },
});
/** What a receiver ends up with: the local row plus the incoming ops, folded per field. */
const receive = (local: { value: string; updatedAt: string } | null, ops: LibraryOp[], key = PROFILE_SETTINGS_KEY) => {
  const folded = mergeProfileSettingsOps(ops, new Map([[key, local]]));
  const op = folded.find((candidate) => candidate.type === "setting.set" && candidate.payload.key === key);
  if (op?.type !== "setting.set") throw new Error("no folded op");
  return { folded, value: op.payload.value, updatedAt: op.payload.updatedAt, parsed: parseProfileSettings(op.payload.value) };
};

describe("the Subtitle language setting shared by desktop, phone and TV (ACCT-SQUAD-03, REL-FAM-02)", () => {
  // @req ACCT-SQUAD-03[badger-desktop,badger-mobile,badger-tv]
  it("the stored `subtitleLanguage` reads as a known choice, and anything else as No preference", () => {
    const read = {
      fr: profileSubtitleLanguage({ subtitleLanguage: "fr" }),
      fre: profileSubtitleLanguage({ subtitleLanguage: "fre" }),
      none: profileSubtitleLanguage({ subtitleLanguage: null }),
      unknown: profileSubtitleLanguage({ subtitleLanguage: "xx" }),
      noRecord: profileSubtitleLanguage(null),
    };
    log("profileSubtitleLanguage", read);
    expect(read).toEqual({ fr: "fr", fre: "fr", none: null, unknown: null, noRecord: null });
  });

  // @req ACCT-SQUAD-03[badger-desktop,badger-mobile,badger-tv]
  it("every app reads one wording, in en/fr/de/nl, under the `subtitleLanguage` key", () => {
    const fr = withSubtitleLanguageTexts({ other: 1 } as Record<string, unknown>, "fr");
    log("subtitleLanguage texts", { languages: Object.keys(subtitleLanguageTexts), fr: fr.subtitleLanguage });
    expect(Object.keys(subtitleLanguageTexts).sort()).toEqual(["de", "en", "es", "fr", "nl"]);
    expect(fr).toMatchObject({ other: 1, subtitleLanguage: { title: "Langue des sous-titres", none: "Aucune préférence" } });
    expect(subtitleLanguageTexts.en.title).toBe("Subtitle language");
    for (const texts of Object.values(subtitleLanguageTexts)) {
      expect(texts.title && texts.description && texts.none).toBeTruthy();
    }
  });
});

describe("profile settings merging between devices (ACCT-SQUAD-03)", () => {
  it("@req ACCT-SQUAD-03 two devices editing different fields both keep their edit", () => {
    const base = serializeProfileSettings(mergeProfileSettings(null, { autoplayNextEpisode: true, quality: "1080p" }, T1));
    const phone = serializeProfileSettings(mergeProfileSettings(parseProfileSettings(base), { autoplayNextEpisode: false }, T2));
    const tv = serializeProfileSettings(mergeProfileSettings(parseProfileSettings(base), { quality: "720p" }, T3));
    log("phase=edits", { phone, tv });

    const onPhone = receive({ value: phone, updatedAt: T2 }, [setOp("tv", PROFILE_SETTINGS_KEY, tv, T3)]);
    const onTv = receive({ value: tv, updatedAt: T3 }, [setOp("phone", PROFILE_SETTINGS_KEY, phone, T2)]);
    const onThird = receive({ value: base, updatedAt: T1 }, [
      setOp("tv", PROFILE_SETTINGS_KEY, tv, T3),
      setOp("phone", PROFILE_SETTINGS_KEY, phone, T2),
    ]);
    log("phase=received", { onPhone: onPhone.parsed, onTv: onTv.parsed, onThird: onThird.parsed });
    for (const result of [onPhone, onTv, onThird]) {
      expect(result.parsed).toMatchObject({ autoplayNextEpisode: false, quality: "720p" });
      expect(result.updatedAt, "the folded op is never older than the row, so the SQL guard keeps it").toBe(T3);
    }
    expect(onThird.folded, "one op per key after folding").toHaveLength(1);
  });

  it("@req ACCT-SQUAD-03 the same field: the newer edit wins whatever the arrival order", () => {
    const older = serializeProfileSettings(mergeProfileSettings(null, { quality: "480p" }, T1));
    const newer = serializeProfileSettings(mergeProfileSettings(null, { quality: "2160p" }, T2));
    expect(receive({ value: newer, updatedAt: T2 }, [setOp("a", PROFILE_SETTINGS_KEY, older, T1)]).parsed?.quality).toBe("2160p");
    expect(receive({ value: older, updatedAt: T1 }, [setOp("b", PROFILE_SETTINGS_KEY, newer, T2)]).parsed?.quality).toBe("2160p");
  });

  it("@req ACCT-SQUAD-03 a seed is stamped with the epoch, so any real record beats it on every device", () => {
    const seed = serializeProfileSettings(
      mergeProfileSettings(null, { autoplayNextEpisode: true, quality: "1080p", audioLanguage: "en" }, PROFILE_SETTINGS_SEED_AT)
    );
    const real = JSON.stringify({ autoplayNextEpisode: false, quality: "720p", updatedAt: "2026-10-15T00:00:00.000Z" });
    log("phase=seed", { seed, real });
    expect(parseProfileSettings(seed)?.updatedAt).toBe(PROFILE_SETTINGS_SEED_AT);
    const here = receive({ value: seed, updatedAt: PROFILE_SETTINGS_SEED_AT }, [setOp("real", PROFILE_SETTINGS_KEY, real, "2026-10-15T00:00:00.000Z")]);
    const elsewhere = receive({ value: real, updatedAt: "2026-10-15T00:00:00.000Z" }, [setOp("seed", PROFILE_SETTINGS_KEY, seed, PROFILE_SETTINGS_SEED_AT)]);
    log("phase=received", { here: here.parsed, elsewhere: elsewhere.parsed });
    for (const result of [here, elsewhere]) {
      expect(result.parsed).toMatchObject({ autoplayNextEpisode: false, quality: "720p", audioLanguage: "en" });
    }

    log("phase=partial-record");
    const partial = parseProfileSettings(JSON.stringify({ quality: "720p", updatedAt: T1 }));
    const seeded = mergeProfileSettings(partial, { autoSkipIntro: true }, PROFILE_SETTINGS_SEED_AT);
    expect(seeded.updatedAt, "a partial record keeps its own updatedAt").toBe(T1);
  });

  it("@req ACCT-SQUAD-03 the old flat value is still read: each field takes the record's updatedAt", () => {
    const flat = JSON.stringify({ quality: "720p", autoSkipIntro: false, updatedAt: T1 });
    const edit = serializeProfileSettings(mergeProfileSettings(null, { autoSkipIntro: true }, T2));
    const result = receive({ value: flat, updatedAt: T1 }, [setOp("e", PROFILE_SETTINGS_KEY, edit, T2)]);
    log("phase=flat", result.parsed);
    expect(result.parsed).toMatchObject({ quality: "720p", autoSkipIntro: true });
  });

  it("@req ACCT-SQUAD-03 @req ACCT-PROF-02 a wipe or a promotion replaces the whole value; older fields do not come back", () => {
    const old = serializeProfileSettings(mergeProfileSettings(null, { quality: "2160p", skipMode: "manual" }, T1));
    const wiped = receive({ value: old, updatedAt: T1 }, [setOp("wipe", "p:kids:profile_settings_v1", "", T2)], "p:kids:profile_settings_v1");
    log("phase=wipe", wiped);
    expect(wiped.value).toBe("");
    const late = receive({ value: "", updatedAt: T2 }, [setOp("late", PROFILE_SETTINGS_KEY, old, T1)]);
    expect(late.value, "an edit older than the wipe stays wiped").toBe("");

    const moved = resetProfileSettingsValue(serializeProfileSettings(mergeProfileSettings(null, { quality: "480p" }, T1)), T3);
    const oldMain = serializeProfileSettings(mergeProfileSettings(null, { quality: "2160p", skipMode: "manual" }, T2));
    const promoted = receive({ value: oldMain, updatedAt: T2 }, [setOp("move", PROFILE_SETTINGS_KEY, moved, T3)]);
    log("phase=promotion", promoted.parsed);
    expect(promoted.parsed?.quality).toBe("480p");
    expect(promoted.parsed?.skipMode, "the deleted main's field is gone").toBeUndefined();
  });

  it("@req ACCT-SQUAD-03 only profile settings keys are folded", () => {
    expect(isProfileSettingsKey("profile_settings_v1")).toBe(true);
    expect(isProfileSettingsKey("p:kids:profile_settings_v1")).toBe(true);
    expect(isProfileSettingsKey("p:kids:track_prefs_v1:m1")).toBe(false);
    expect(isProfileSettingsKey("client_config_v1")).toBe(false);
    const other = setOp("x", "track_prefs_v1:m1", "{}", T1);
    expect(mergeProfileSettingsOps([other], new Map())).toEqual([other]);
  });
});

/** One device of the profile: its stored row, and what it uploads when it writes or receives. */
type Device = { name: string; row: { value: string; updatedAt: string } | null };
const device = (name: string, row: Device["row"] = null): Device => ({ name, row });
/** The device writes a patch locally (an edit or a seed) and returns the op it uploads. */
const write = (on: Device, patch: Parameters<typeof mergeProfileSettings>[1], at: string, id: string): LibraryOp => {
  const merged = mergeProfileSettings(parseProfileSettings(on.row?.value), patch, at);
  on.row = { value: serializeProfileSettings(merged), updatedAt: merged.updatedAt };
  return setOp(id, PROFILE_SETTINGS_KEY, on.row.value, merged.updatedAt);
};
/** The device receives ops through the library sync (fold, then the newer-or-equal SQL guard). */
const apply = (on: Device, ops: LibraryOp[]) => {
  const folded = receive(on.row, ops);
  if (!on.row || folded.updatedAt >= on.row.updatedAt) on.row = { value: folded.value, updatedAt: folded.updatedAt };
};
const shown = (on: Device) => parseProfileSettings(on.row?.value);

describe("profile settings converge on every device (ACCT-SQUAD-03, review of PR 836)", () => {
  it("@req ACCT-SQUAD-03 @req ACCT-PROF-02 @bugfix after a promotion, an edit from the other device keeps the promoted values on both, with no re-seed", () => {
    const oldMain = serializeProfileSettings(
      mergeProfileSettings(null, { quality: "2160p", skipMode: "manual", autoSkipIntro: false, audioLanguage: "en" }, T1)
    );
    const a = device("a", { value: oldMain, updatedAt: T1 });
    const b = device("b", { value: oldMain, updatedAt: T1 });
    // The kids profile never had an audio language, so a device seeds it after the move.
    const kids = mergeProfileSettings(
      null,
      { autoplayNextEpisode: false, autoSkipIntro: true, autoSkipCredits: true, quality: "480p", forceQuality: true },
      T1
    );
    const moved = resetProfileSettingsValue(serializeProfileSettings(kids), T2);
    a.row = { value: moved, updatedAt: T2 };
    const promotion = setOp("move", PROFILE_SETTINGS_KEY, moved, T2);
    log("phase=promotion", { moved: parseProfileSettings(moved) });

    apply(b, [promotion]);
    log("phase=b-received", shown(b));
    expect(missingProfileSettings(shown(b)), "b holds the promoted profile's fields").toEqual(["audioLanguage"]);
    const seedAt = profileSettingsSeedAt(shown(b));
    expect(seedAt, "a seed after a reset is stamped at the reset, so it survives it").toBe(T2);
    const seed = write(b, { audioLanguage: "fr" }, seedAt, "b-seed");
    const edit = write(b, { quality: "720p" }, T3, "b-edit");
    apply(a, [seed, edit]);
    apply(b, [promotion]);
    log("phase=converged", { a: shown(a), b: shown(b) });

    for (const on of [a, b]) {
      expect(shown(on), on.name).toMatchObject({
        autoplayNextEpisode: false,
        autoSkipIntro: true,
        autoSkipCredits: true,
        quality: "720p",
        forceQuality: true,
        audioLanguage: "fr",
      });
      expect(shown(on)?.skipMode, `${on.name}: the deleted main's field stays gone`).toBeUndefined();
      expect(missingProfileSettings(shown(on)), `${on.name}: nothing left to seed, so no re-seed loop`).toEqual([]);
    }
    expect(a.row?.value, "both devices store the same value").toBe(b.row?.value);
  });

  it("@req ACCT-SQUAD-03 @bugfix two devices seeding different values end with the same one, whatever the order", () => {
    const a = device("a");
    const b = device("b");
    const seedA = write(a, { quality: "720p" }, PROFILE_SETTINGS_SEED_AT, "seed-a");
    const seedB = write(b, { quality: "2160p" }, PROFILE_SETTINGS_SEED_AT, "seed-b");
    apply(a, [seedB]);
    apply(b, [seedA]);
    const third = device("third");
    apply(third, [seedB, seedA]);
    const fourth = device("fourth");
    apply(fourth, [seedA, seedB]);
    log("phase=ties", { a: shown(a)?.quality, b: shown(b)?.quality, third: shown(third)?.quality, fourth: shown(fourth)?.quality });
    for (const on of [b, third, fourth]) expect(on.row?.value, on.name).toBe(a.row?.value);

    log("phase=unknown-field-tie");
    const x = device("x", { value: JSON.stringify({ futureField: "x", updatedAt: T1 }), updatedAt: T1 });
    const y = device("y", { value: JSON.stringify({ futureField: "y", updatedAt: T1 }), updatedAt: T1 });
    const fromX = setOp("x", PROFILE_SETTINGS_KEY, x.row!.value, T1);
    const fromY = setOp("y", PROFILE_SETTINGS_KEY, y.row!.value, T1);
    apply(x, [fromY]);
    apply(y, [fromX]);
    log("phase=unknown-field", { x: x.row?.value, y: y.row?.value });
    expect(x.row?.value).toBe(y.row?.value);
  });

  it("@req ACCT-SQUAD-03 any set of ops, in any order, gives the same value; applying an op twice changes nothing", () => {
    let seed = 836;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const times = [PROFILE_SETTINGS_SEED_AT, T1, T2, T3];
    const randomOp = (id: string): LibraryOp => {
      const at = pick(times);
      const roll = random();
      if (roll < 0.1) return setOp(id, PROFILE_SETTINGS_KEY, "", at);
      let value = mergeProfileSettings(null, {}, at);
      const patches: Array<() => ProfileSettingsPatch> = [
        () => ({ quality: pick(["480p", "720p", "2160p"] as const) }),
        () => ({ autoSkipIntro: pick([true, false]) }),
        () => ({ subtitleLanguage: pick([null, "fr", "nl"]) }),
        () => ({ audioLanguage: pick([null, "de"]) }),
      ];
      for (const patch of patches) {
        if (random() < 0.6) value = mergeProfileSettings(value, patch(), pick(times));
      }
      if (random() < 0.3) value = { ...value, futureField: pick(["p", "q"]) };
      const raw = roll < 0.25 ? resetProfileSettingsValue(serializeProfileSettings(value), pick(times)) : serializeProfileSettings(value);
      // Every writer sends the value's own updatedAt as the op's time (a blank carries its wipe time).
      return setOp(id, PROFILE_SETTINGS_KEY, raw, parseProfileSettings(raw)!.updatedAt);
    };
    const shuffled = <T,>(items: readonly T[]): T[] => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    };
    /** Ops arriving one batch at a time on a device that stores every result. */
    const deliver = (ops: LibraryOp[]) => {
      const on = device("d");
      for (const op of ops) apply(on, [op]);
      return on.row?.value ?? null;
    };

    for (let round = 0; round < 200; round += 1) {
      const ops = Array.from({ length: 2 + Math.floor(random() * 5) }, (_, i) => randomOp(`r${round}-${i}`));
      const reference = deliver(ops);
      for (let order = 0; order < 4; order += 1) {
        const permuted = shuffled(ops);
        const oneByOne = deliver(permuted);
        const batched = receive(null, permuted).value;
        if (oneByOne !== reference || batched !== reference) log("phase=diverged", { round, ops: ops.map((op) => op.type === "setting.set" ? op.payload : null), reference, oneByOne, batched });
        expect(oneByOne, `round ${round}: one by one`).toBe(reference);
        expect(batched, `round ${round}: in one batch`).toBe(reference);
      }
      const twice = deliver([...ops, pick(ops)]);
      expect(twice, `round ${round}: an op applied twice`).toBe(reference);
    }
  });
});
