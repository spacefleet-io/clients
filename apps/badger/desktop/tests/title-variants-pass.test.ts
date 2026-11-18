/**
 * @req ACCT-PROF-03[badger-desktop]
 * @test-id DESKTOP-TITLE-VARIANTS-PASS-001..004
 * @level unit
 *
 * Why: the desktop runs the shared title-variants pass (`reconcileTitleVariants`) in the background after the library
 * opens and whenever a profile's option or the account language changes. It must hand the pass the open library
 * (settings rows, the compare-and-set title write), the ticket floor and the artwork copy, never start before its
 * delay, stop between titles when a newer pass replaces it, and re-read the library only after a pass changed it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const LOG = "[title-variants-pass]";

const { reconcileMock } = vi.hoisted(() => ({ reconcileMock: vi.fn() }));
vi.mock("@space/metadata-client", () => ({
  reconcileTitleVariants: reconcileMock,
  TITLE_VARIANTS_PAUSE_MS: 1500,
}));

import { startTitleVariantsReconcile, TITLE_VARIANTS_START_DELAY_MS, type TitleVariantsPassInputs } from "@/lib/titleVariantsPass";

const art = { title: "Hate", posterPath: "/p", backdropPath: null };

const fakeInputs = (overrides: Partial<TitleVariantsPassInputs> = {}) => {
  const settings = new Map<string, string>([["title_variants_v1:m1", "{}"]]);
  const sleeps: number[] = [];
  const db = {
    listMedia: vi.fn(async () => [{ id: "m1" }] as never),
    getSetting: vi.fn(async (key: string) => (settings.has(key) ? { value: settings.get(key)! } : null)),
    setSetting: vi.fn(async (key: string, value: string) => void settings.set(key, value)),
    replaceMediaTitleArt: vi.fn(async () => true),
  };
  const inputs: TitleVariantsPassInputs = {
    db,
    details: vi.fn(),
    accountLanguage: "en",
    profileOptions: ["app", "original"],
    legacyLibraryLanguage: "auto",
    ticketsLeft: vi.fn(async () => 50),
    ticketFloor: 20,
    onRowArtChanged: vi.fn(),
    uploadArtwork: vi.fn(async () => ({ status: "ok" as const, key: "asset:k" })),
    onChanged: vi.fn(async () => undefined),
    sleep: async (ms: number) => void sleeps.push(ms),
    ...overrides,
  };
  return { inputs, db, settings, sleeps };
};

const result = (rowsReplaced: number, variantsWritten: number) => ({ checked: 1, lookups: 1, rowsReplaced, variantsWritten, failed: 0, stopped: false });

beforeEach(() => {
  reconcileMock.mockReset();
});

describe("the desktop's title-variants pass (ACCT-PROF-03)", () => {
  it("DESKTOP-TITLE-VARIANTS-PASS-001: waits its start delay, then hands the pass the open library and the app's options", async () => {
    reconcileMock.mockResolvedValue(result(0, 0));
    const { inputs, db, settings, sleeps } = fakeInputs();
    const outcome = await startTitleVariantsReconcile(inputs).done;
    const deps = reconcileMock.mock.calls[0]?.[0];
    console.info(`${LOG}:001 sleeps=${JSON.stringify(sleeps)} deps=${JSON.stringify(Object.keys(deps ?? {}))} outcome=${JSON.stringify(outcome)}`);
    expect(sleeps[0]).toBe(TITLE_VARIANTS_START_DELAY_MS);
    expect(deps.accountLanguage).toBe("en");
    expect(deps.profileOptions).toEqual(["app", "original"]);
    expect(deps.legacyLibraryLanguage).toBe("auto");
    expect(deps.pauseMs).toBe(1500);

    // The library side reads and writes the synced settings rows and the compare-and-set title write.
    expect(await deps.library.read("title_variants_v1:m1")).toBe("{}");
    expect(await deps.library.read("missing")).toBeNull();
    await deps.library.write("title_variants_v1:m2", "{\"v\":1}");
    expect(settings.get("title_variants_v1:m2")).toBe("{\"v\":1}");
    expect(await deps.library.replaceTitleArt("m1", art, { ...art, title: "La Haine" })).toBe(true);
    expect(db.replaceMediaTitleArt).toHaveBeenCalledWith("m1", art, { ...art, title: "La Haine" });
    expect(await deps.library.listMedia()).toEqual([{ id: "m1" }]);

    // Tickets: the pass spends only above the app's floor.
    expect(await deps.canSpend()).toBe(true);
    vi.mocked(inputs.ticketsLeft).mockResolvedValue(20);
    expect(await deps.canSpend()).toBe(false);
    expect(deps.onRowArtChanged).toBe(inputs.onRowArtChanged);
    expect(deps.uploadArtwork).toBe(inputs.uploadArtwork);
    expect(deps.shouldYield()).toBe(false);
    expect(inputs.onChanged, "nothing changed: no re-read").not.toHaveBeenCalled();
  });

  it("DESKTOP-TITLE-VARIANTS-PASS-002: re-reads the library once after a pass that changed it", async () => {
    reconcileMock.mockResolvedValue(result(2, 3));
    const { inputs } = fakeInputs();
    await startTitleVariantsReconcile(inputs).done;
    console.info(`${LOG}:002 onChanged calls=${vi.mocked(inputs.onChanged).mock.calls.length}`);
    expect(inputs.onChanged).toHaveBeenCalledTimes(1);
  });

  it("DESKTOP-TITLE-VARIANTS-PASS-003: stopped before its delay ends, it never starts; stopped during, it yields", async () => {
    reconcileMock.mockResolvedValue(result(0, 0));
    const early = fakeInputs();
    const gate = Promise.withResolvers<void>();
    const pass = startTitleVariantsReconcile({ ...early.inputs, sleep: () => gate.promise });
    pass.stop();
    gate.resolve();
    expect(await pass.done).toBeNull();
    expect(reconcileMock).not.toHaveBeenCalled();

    let yielded: boolean | null = null;
    const later = fakeInputs();
    const running = startTitleVariantsReconcile(later.inputs);
    reconcileMock.mockImplementation(async (deps: { shouldYield: () => boolean }) => {
      running.stop();
      yielded = deps.shouldYield();
      return result(0, 0);
    });
    await running.done;
    console.info(`${LOG}:003 yielded=${yielded}`);
    expect(yielded).toBe(true);
  });

  it("DESKTOP-TITLE-VARIANTS-PASS-004: a failing pass is logged and resolves to null (the titles shown stay)", async () => {
    reconcileMock.mockRejectedValue(new Error("offline"));
    const { inputs } = fakeInputs();
    const outcome = await startTitleVariantsReconcile(inputs).done;
    console.info(`${LOG}:004 outcome=${outcome}`);
    expect(outcome).toBeNull();
    expect(inputs.onChanged).not.toHaveBeenCalled();
  });
});
