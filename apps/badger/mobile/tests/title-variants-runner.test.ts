/**
 * The phone and TV's background title-language pass (ACCT-PROF-03): every profile's option, the old library-wide
 * language only as the old rows' language, one pass at a time with one more after a request made while it runs, and
 * nothing more once the library closed.
 *
 * @req ACCT-PROF-03[badger-mobile,badger-tv]
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReconcileTitleVariantsDeps, ReconcileTitleVariantsResult } from "@space/metadata-client";
import type { ProfileSettings } from "@space/shared/profileSettings";
import type { ViewingScope } from "@space/shared/profileViewing";
import { LEGACY_LIBRARY_LANGUAGE_KEY, profileTitleOptions, startTitleVariants, type TitleVariantsDb } from "../src/lib/titleVariants";

/** Each pass the runner started, held open until the test finishes it. */
const passes: Array<{ deps: ReconcileTitleVariantsDeps; finish: (result: ReconcileTitleVariantsResult) => void }> = [];

vi.mock("@space/metadata-client", () => ({
  TITLE_VARIANTS_PAUSE_MS: 0,
  reconcileTitleVariants: (deps: ReconcileTitleVariantsDeps) => {
    const { promise, resolve } = Promise.withResolvers<ReconcileTitleVariantsResult>();
    passes.push({ deps, finish: resolve });
    return promise;
  },
}));

const RESULT = { rowsReplaced: 0, variantsWritten: 0 } as unknown as ReconcileTitleVariantsResult;
const ORIGINAL = { titleLanguage: "original" } as ProfileSettings;

/** Settings by profile: "main" is the main profile's scope (no key prefix), the others by profile id. */
const fakeDb = (settings: Record<string, ProfileSettings | null>, legacy: string | null): TitleVariantsDb => ({
  listMedia: async () => [],
  readSetting: async (key) => (key === LEGACY_LIBRARY_LANGUAGE_KEY ? legacy : null),
  writeSetting: async () => undefined,
  replaceTitleArt: async () => true,
  getProfileSettings: async (scope: ViewingScope) => settings[scope.prefix === "" ? "main" : scope.profileId!] ?? null,
});

beforeEach(() => {
  passes.length = 0;
});

describe("profiles' options", () => {
  it("reads each profile's answer from its own settings; never answered is the app language", async () => {
    const db = fakeDb({ main: ORIGINAL, kid: null }, null);
    const options = await profileTitleOptions(db, [{ id: "main-id", isMain: true }, { id: "kid", isMain: false }]);
    console.info("[title-variants] options", options);
    expect(options).toEqual(["original", "app"]);
    // No profile list yet: the main profile's answer.
    expect(await profileTitleOptions(db, [])).toEqual(["original"]);
  });
});

describe("background runner", () => {
  const start = (db: TitleVariantsDb) => {
    const onChanged = vi.fn();
    const runner = startTitleVariants({
      db,
      profiles: () => [],
      accountLanguage: () => "en",
      details: vi.fn(),
      canSpend: async () => true,
      uploadArtwork: vi.fn(),
      onRowArtChanged: vi.fn(),
      onChanged,
      log: (event, detail) => console.info("[title-variants]", event, JSON.stringify(detail)),
    });
    return { runner, onChanged };
  };

  it("passes the account language, the options and the old library language; re-reads when something changed", async () => {
    const { runner, onChanged } = start(fakeDb({ main: ORIGINAL }, "fr"));
    runner.request("open");
    await vi.waitFor(() => expect(passes).toHaveLength(1));
    const { deps } = passes[0]!;
    expect(deps.accountLanguage).toBe("en");
    expect(deps.profileOptions).toEqual(["original"]);
    expect(deps.legacyLibraryLanguage).toBe("fr");
    passes[0]!.finish({ ...RESULT, variantsWritten: 2 } as ReconcileTitleVariantsResult);
    await runner.idle();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("runs one more pass, once, for requests made while one runs", async () => {
    const { runner, onChanged } = start(fakeDb({}, null));
    runner.request("open");
    await vi.waitFor(() => expect(passes).toHaveLength(1));
    runner.request("choice");
    runner.request("sync");
    passes[0]!.finish(RESULT);
    await vi.waitFor(() => expect(passes).toHaveLength(2));
    passes[1]!.finish(RESULT);
    await runner.idle();
    expect(passes).toHaveLength(2);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("stops at the next title once the library closed and runs nothing more", async () => {
    const { runner } = start(fakeDb({}, null));
    runner.request("open");
    await vi.waitFor(() => expect(passes).toHaveLength(1));
    expect(passes[0]!.deps.shouldYield?.()).toBe(false);
    runner.request("sync");
    runner.stop();
    expect(passes[0]!.deps.shouldYield?.()).toBe(true);
    passes[0]!.finish(RESULT);
    await runner.idle();
    runner.request("choice");
    await runner.idle();
    expect(passes).toHaveLength(1);
  });
});
