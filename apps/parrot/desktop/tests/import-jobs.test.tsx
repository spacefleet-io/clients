// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-JOBS-001
 * @level integration (real ImportJobs panel on the shared desktop-shell Jobs sheet and job cards, real translator;
 *   `window.parrot` mocked)
 * @why Chris 2026-11-12 (chat): the teal "Import done: 4 added, 0 already there, 0 failed" strip goes; Parrot gets
 *   Badger's flask Jobs item in the top bar with the same side panel listing running, finished and failed imports,
 *   with what each added, found already there and could not import, and why. Chris 2026-11-16 (chat, via Main): the
 *   cards inside are Badger's too (UX-JOBS-02): same pills and words, the X stops a running import, the bin removes
 *   an ended one with the same animation, the loading cards, one quiet line for the lookups running on their own.
 *   Chris 2026-11-24 (chat): "the import jobs on parrot's jobs bar don't look like the ones on badger … this is
 *   terrible": each import is Badger's group card (cover, album, counts, pill, X or bin, chevron), and the files it
 *   could not take read as one plain line per reason, never a raw error or a path.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translator } from "../src/renderer/src/i18n";
import { ImportJobs, importFailureReason, type ImportFailureReason, type ImportJobAlbum } from "../src/renderer/src/ImportJobs";
import { setStorageUnitBase } from "@space/shared/format";
import { exportBridgeStub } from "./exportBridge";
import {
  IMPORT_INTERRUPTED,
  type ParrotBackgroundWork,
  type ParrotImportJob,
  type ParrotImportRetry,
  type ParrotImportStatus,
  type ParrotLanguage,
} from "../src/shared/ipc";

const SUITE = "[parrot-import-jobs]";

const status = (patch: Partial<ParrotImportStatus>): ParrotImportStatus => ({
  running: false,
  phase: "done",
  total: 0,
  done: 0,
  imported: 0,
  skipped: 0,
  failed: 0,
  bytesDone: 0,
  bytesTotal: 0,
  published: 0,
  currentFile: null,
  error: null,
  ...patch,
});

const job = (id: string, patch: Partial<ParrotImportJob>, statusPatch: Partial<ParrotImportStatus>): ParrotImportJob => ({
  id,
  sources: [`/home/me/Music/${id}`],
  startedAt: Date.UTC(2026, 10, 12, 10),
  finishedAt: null,
  failures: [],
  ...patch,
  status: status(statusPatch),
});

const running = job("Running Album", { albumIds: ["alb-1"] }, { running: true, phase: "uploading", done: 2, total: 5, bytesDone: 2_000_000, bytesTotal: 5_000_000 });
const finished = job("Finished Album", { finishedAt: 2 }, { phase: "done", done: 4, total: 4, imported: 3, skipped: 1, failed: 0 });
const partly = job(
  "Broken Album",
  { finishedAt: 3, failures: [{ file: "/home/me/Music/Broken Album/03 broken.mp3", error: "not an audio file" }] },
  { phase: "done", done: 2, total: 2, imported: 2, skipped: 0, failed: 1 }
);
const interrupted = job("Cut Album", { finishedAt: 4 }, { phase: "failed", imported: 1, total: 6, done: 1, error: IMPORT_INTERRUPTED });
const stopped = job("Stopped Album", { finishedAt: 5 }, { phase: "cancelled", done: 2, total: 9, imported: 2 });
const review = job("Review Album", {}, { phase: "review", total: 7, bytesTotal: 7_000_000 });
const names = [running, finished, partly, interrupted, stopped, review].map((entry) => entry.id);

describe("Parrot desktop Jobs panel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let push: (jobs: ParrotImportJob[]) => void = () => undefined;
  let pushWork: (work: ParrotBackgroundWork[]) => void = () => undefined;
  let current: ParrotImportJob[] = [];
  const onReview = vi.fn();
  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 0);
        await promise;
      }
    });
  };
  // The bin waits for the removal animation (UX-JOBS-02) before it asks the app to drop the job.
  const settle = async () => {
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 400);
      await promise;
    });
    await flush();
  };
  const all = (id: string) => [...document.querySelectorAll(`[data-testid="${id}"]`)];
  const cards = () => all("import-job") as HTMLElement[];
  const card = (name: string) => cards().find((el) => el.textContent?.includes(name));
  const pill = (name: string) => card(name)?.querySelector('[data-testid="import-job-status"]')?.textContent;
  // The group card's header: cover, title, the counts line, pill, X or bin, chevron.
  const header = (el: Element | undefined) => el?.querySelector('[data-testid="import-job-card"]') as HTMLElement | null | undefined;
  const dump = () => console.info(SUITE, "panel", document.querySelector('[data-testid="import-jobs"]')?.textContent);

  const mount = async (jobs: Promise<ParrotImportJob[]>, language: ParrotLanguage = "en", albumFor: (albumId: string) => ImportJobAlbum | undefined = () => undefined) => {
    Object.defineProperty(window, "parrot", {
      configurable: true,
      value: {
        ...exportBridgeStub(),
        getImportJobs: vi.fn(() => jobs),
        onImportJobs: vi.fn((listener: (jobs: ParrotImportJob[]) => void) => {
          push = (next) => {
            current = next;
            listener(next);
          };
          return () => undefined;
        }),
        dismissImportJob: vi.fn(async (id: string) => {
          push(current.filter((entry) => entry.id !== id));
          return current;
        }),
        cancelImport: vi.fn(async () => running.status),
        retryImportJob: vi.fn(async (_id: string): Promise<ParrotImportRetry> => ({ started: true })),
        findImportJobFolder: vi.fn(async (_id: string): Promise<ParrotImportRetry | { cancelled: true }> => ({ started: true })),
        getBackgroundWork: vi.fn(async () => [{ kind: "lyrics", done: 3, total: 12 }]),
        onBackgroundWork: vi.fn((listener: (work: ParrotBackgroundWork[]) => void) => {
          pushWork = listener;
          return () => undefined;
        }),
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<ImportJobs t={translator(language)} language={language} onReview={onReview} albumFor={albumFor} />));
    await flush();
  };

  beforeEach(async () => {
    current = [running, finished, partly, interrupted, stopped, review];
    onReview.mockReset();
    await mount(Promise.resolve(current));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const openPanel = async () => {
    await act(async () => (container.querySelector('[data-testid="nav-jobs"]') as HTMLButtonElement).click());
    await flush();
    dump();
  };

  // @req UX-JOBS-01[parrot]
  // @req PAR-UP-04
  it("the flask spins with the running count; the panel lists running, finished and failed imports with counts and reasons", async () => {
    const trigger = container.querySelector('[data-testid="nav-jobs"]');
    console.info(SUITE, "trigger", trigger?.outerHTML.slice(0, 300));
    expect(trigger?.getAttribute("aria-label")).toBe("Jobs");
    expect(container.querySelector('[data-testid="nav-jobs-running"]')).not.toBeNull();
    expect(trigger?.textContent).toBe("1");
    await openPanel();
    expect(cards()).toHaveLength(6);
    expect(card("Running Album")?.querySelector('[data-testid="import-job-progress"]')?.textContent).toContain("Uploading 2 of 5");
    expect(header(card("Finished Album"))?.textContent).toContain("3 added · 1 already there · 0 failed");
    const broken = card("Broken Album");
    expect(header(broken)?.textContent).toContain("2 added · 0 already there · 1 failed");
    expect(broken?.querySelector('[data-testid="import-job-failures"]')?.textContent).toContain("1 file is not a song Parrot can import.");
    expect(broken?.querySelector('[data-testid="import-job-failures"]')?.textContent).toContain("03 broken.mp3");
    const cut = card("Cut Album");
    expect(pill("Cut Album")).toBe("Failed");
    expect(cut?.querySelector('[data-testid="import-job-error"]')?.textContent).toContain("Parrot closed before this import finished");
  });

  // @req UX-JOBS-02[parrot]
  it("the cards read like Badger's: the same pills and words, a progress bar, no visible panel title", async () => {
    await openPanel();
    const pills = Object.fromEntries(names.map((name) => [name, pill(name)]));
    console.info(SUITE, "pills", pills);
    expect(pills).toEqual({
      "Running Album": "Uploading",
      "Finished Album": "Done",
      "Broken Album": "Done",
      "Cut Album": "Failed",
      "Stopped Album": "Cancelled",
      "Review Album": "Ready to review",
    });
    expect(card("Running Album")?.querySelector('[data-testid="import-job-bar"]')?.textContent).toContain("40%");
    // The sheet's own header is for screen readers only; the panel draws no title of its own.
    expect(document.querySelector('[data-testid="import-jobs"] h2')).toBeNull();
  });

  // @req STOR-UNIT-02[parrot]
  it("the running import's sizes are written in the interface language: 2 Mo sur 5 Mo in French", async () => {
    setStorageUnitBase(1000);
    await openPanel();
    const english = card("Running Album")?.querySelector('[data-testid="import-job-progress"]')?.textContent;
    act(() => root.unmount());
    container.remove();
    await mount(Promise.resolve(current), "fr");
    await openPanel();
    const french = card("Running Album")?.querySelector('[data-testid="import-job-progress"]')?.textContent;
    console.info(SUITE, "progress", { english, french });
    expect(english).toContain("Uploading 2 of 5 · 2 MB of 5 MB");
    expect(french).toContain("Envoi 2 sur 5 · 2 Mo sur 5 Mo");
  });

  // @req UX-JOBS-02[parrot]
  it("the X stops a running import; an import ready to review opens the review on a click and has the X too", async () => {
    await openPanel();
    const stop = card("Running Album")?.querySelector('[data-testid="import-job-cancel"]') as HTMLButtonElement;
    expect(stop.getAttribute("aria-label")).toBe("Cancel");
    expect(card("Running Album")?.querySelector('[data-testid="import-job-remove"]')).toBeNull();
    await act(async () => stop.click());
    expect(window.parrot.cancelImport).toHaveBeenCalledTimes(1);
    await act(async () => (card("Review Album")?.querySelector('[data-testid="import-job-review"]') as HTMLButtonElement).click());
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(card("Review Album")?.querySelector('[data-testid="import-job-cancel"]')).not.toBeNull();
  });

  // @req UX-JOBS-01[parrot]
  // @req UX-JOBS-02[parrot]
  it("the filter chips split active, queued, completed and failed imports; an ended one is removed with the bin after its animation", async () => {
    await openPanel();
    const filter = async (level: string) => {
      await act(async () => (document.querySelector(`[data-testid="jobs-filter-${level}"]`) as HTMLButtonElement).click());
      const shown = cards().map((el) => names.find((name) => el.textContent?.includes(name)));
      console.info(SUITE, "filter", level, shown);
      return shown;
    };
    expect(await filter("active")).toEqual(["Running Album"]);
    expect(await filter("queued")).toEqual(["Review Album"]);
    expect(await filter("completed")).toEqual(["Finished Album", "Broken Album", "Stopped Album"]);
    expect(await filter("failed")).toEqual(["Broken Album", "Cut Album"]);
    await filter("all");
    const bin = card("Finished Album")?.querySelector('[data-testid="import-job-remove"]') as HTMLButtonElement;
    expect(bin.getAttribute("aria-label")).toBe("Remove from history");
    await act(async () => bin.click());
    // The row collapses first; the app is asked once the animation ends.
    expect(window.parrot.dismissImportJob).not.toHaveBeenCalled();
    await settle();
    expect(window.parrot.dismissImportJob).toHaveBeenCalledWith("Finished Album");
    expect(card("Finished Album")).toBeUndefined();
  });

  // @req UX-JOBS-02[parrot]
  it("one quiet line says which lookups run on their own, and goes when they end", async () => {
    await openPanel();
    const line = () => document.querySelector('[data-testid="import-background-lyrics"]')?.textContent;
    expect(line()).toBe("Looking up lyrics for your songs (3 of 12)");
    await act(async () => pushWork([{ kind: "artistPhotos", done: 1, total: 4 }]));
    expect(line()).toBeUndefined();
    expect(document.querySelector('[data-testid="import-background-artistPhotos"]')?.textContent).toBe("Finding photos for your artists (1 of 4)");
    // PAR-META-20: the automatic album-cover pass has its own line.
    await act(async () => pushWork([{ kind: "covers", done: 2, total: 5 }]));
    expect(document.querySelector('[data-testid="import-background-covers"]')?.textContent).toBe("Finding covers for your albums (2 of 5)");
    await act(async () => pushWork([]));
    expect(document.querySelector('[data-testid^="import-background-"]')).toBeNull();
  });

  // @req UX-JOBS-02[parrot]
  it("the panel shows Badger's loading cards until the job list arrives", async () => {
    act(() => root.unmount());
    container.remove();
    const { promise, resolve } = Promise.withResolvers<ParrotImportJob[]>();
    await mount(promise);
    await openPanel();
    expect(all("import-jobs-loading")).toHaveLength(1);
    await act(async () => resolve([finished]));
    await flush();
    expect(all("import-jobs-loading")).toHaveLength(0);
    expect(cards()).toHaveLength(1);
  });

  // @req UX-JOBS-01[parrot]
  it("when the import ends, the spinner turns back into the flask and the job shows as finished", async () => {
    await act(async () => push([{ ...running, finishedAt: 9, status: status({ phase: "done", done: 5, total: 5, imported: 5 }) }]));
    const trigger = container.querySelector('[data-testid="nav-jobs"]');
    console.info(SUITE, "trigger after end", trigger?.outerHTML.slice(0, 300));
    expect(container.querySelector('[data-testid="nav-jobs-running"]')).toBeNull();
    expect(trigger?.textContent).toBe("");
    await openPanel();
    expect(cards()).toHaveLength(1);
    expect(cards()[0]?.querySelector('[data-testid="import-job-status"]')?.textContent).toBe("Done");
    expect(header(cards()[0])?.textContent).toContain("5 added · 0 already there · 0 failed");
  });

  // @req UX-JOBS-01[parrot]
  it("while the importer says done but the app still reloads the library, the job still reads Uploading with the X and no bin", async () => {
    await act(async () => push([{ ...running, status: status({ phase: "done", running: true, done: 5, total: 5, imported: 5 }) }]));
    await openPanel();
    const only = cards()[0];
    console.info(SUITE, "early done card", only?.textContent);
    expect(only?.querySelector('[data-testid="import-job-status"]')?.textContent).toBe("Uploading");
    expect(only?.querySelector('[data-testid="import-job-remove"]')).toBeNull();
    expect(header(only)?.textContent).not.toContain("added");
  });

  // @req UX-JOBS-03[parrot]
  it("a stopped import and one that left files out say what happened, what it means, and offer Import again", async () => {
    await openPanel();
    const cut = card("Cut Album")?.querySelector('[data-testid="import-job-failed"]');
    const broken = card("Broken Album")?.querySelector('[data-testid="import-job-failed"]');
    console.info(SUITE, "failed details", { cut: cut?.textContent, broken: broken?.textContent });
    expect(cut?.textContent).toContain("Parrot closed before this import finished.");
    expect(cut?.textContent).toContain("Songs already added stay in the library. Importing again adds only what is missing.");
    expect(broken?.textContent).toContain("Some files were not added.");
    // Nothing to try again on a finished, stopped-by-the-user or running import.
    for (const name of ["Finished Album", "Stopped Album", "Running Album", "Review Album"]) {
      expect(card(name)?.querySelector('[data-testid="import-job-failed"]'), name).toBeNull();
    }
    const again = card("Cut Album")?.querySelector('[data-testid="import-job-retry"]') as HTMLButtonElement;
    expect(again.textContent).toBe("Import again");
    await act(async () => again.click());
    await flush();
    console.info(SUITE, "retry calls", vi.mocked(window.parrot.retryImportJob).mock.calls);
    expect(window.parrot.retryImportJob).toHaveBeenCalledWith("Cut Album");
    expect(window.parrot.findImportJobFolder).not.toHaveBeenCalled();
    // The bin stays beside the one action.
    expect(card("Cut Album")?.querySelector('[data-testid="import-job-remove"]')).not.toBeNull();
  });

  // @req UX-JOBS-03[parrot]
  it("when the folder is gone the card offers Find the folder, and turns to it when Import again finds nothing", async () => {
    vi.mocked(window.parrot.retryImportJob).mockResolvedValueOnce({ started: false, reason: "missing" });
    await openPanel();
    const button = () => card("Cut Album")?.querySelector('[data-testid="import-job-retry"]') as HTMLButtonElement;
    await act(async () => button().click());
    await flush();
    const detail = card("Cut Album")?.querySelector('[data-testid="import-job-failed"]')?.textContent;
    console.info(SUITE, "after missing", { label: button().textContent, detail });
    expect(button().textContent).toBe("Find the folder");
    expect(detail).toContain("The folder is no longer where it was. Find it to import again.");
    await act(async () => button().click());
    await flush();
    expect(window.parrot.findImportJobFolder).toHaveBeenCalledWith("Cut Album");
    // Main's own list says so as well; the card keeps offering the picker.
    await act(async () => push([{ ...partly, sourcesMissing: true }]));
    expect(card("Broken Album")?.querySelector('[data-testid="import-job-retry"]')?.textContent).toBe("Find the folder");
  });

  // @req UX-JOBS-03[parrot]
  it("another import under way: the card says to try again once it ends; French reads in French", async () => {
    vi.mocked(window.parrot.retryImportJob).mockResolvedValueOnce({ started: false, reason: "busy" });
    await openPanel();
    await act(async () => (card("Cut Album")?.querySelector('[data-testid="import-job-retry"]') as HTMLButtonElement).click());
    await flush();
    expect(card("Cut Album")?.querySelector('[data-testid="import-job-failed"]')?.textContent).toContain("Another import is under way. Try again once it ends.");
    act(() => root.unmount());
    container.remove();
    await mount(Promise.resolve(current), "fr");
    await openPanel();
    const french = card("Cut Album")?.querySelector('[data-testid="import-job-failed"]')?.textContent;
    console.info(SUITE, "french detail", french);
    expect(french).toContain("Parrot s’est fermé avant la fin de cet import.");
    expect(card("Cut Album")?.querySelector('[data-testid="import-job-retry"]')?.textContent).toBe("Importer à nouveau");
  });

  it("the counts and the other sources read in the right plural form: 1 ajouté, 2 ajoutés, et 1 autre, et 2 autres", async () => {
    const one = job("One", { finishedAt: 6, sources: ["/home/me/Music/One", "/home/me/Music/Extra"] }, { phase: "done", imported: 1, skipped: 1, failed: 1 });
    const two = job("Two", { finishedAt: 7, sources: ["/home/me/Music/Two", "/x", "/y"] }, { phase: "done", imported: 2, skipped: 2, failed: 2 });
    const read = async (language: ParrotLanguage) => {
      act(() => root.unmount());
      container.remove();
      current = [one, two];
      await mount(Promise.resolve(current), language);
      await openPanel();
      const lines = cards().map((el) => header(el)?.textContent?.match(/\d+ (?:added|ajoutés?) · .*?(?:failed|en échec)/u)?.[0] ?? "");
      console.info(SUITE, language, "plural lines", JSON.stringify(lines));
      return lines;
    };
    const en = await read("en");
    expect(en.sort()).toEqual(["1 added · 1 already there · 1 failed", "2 added · 2 already there · 2 failed"]);
    expect(cards().some((el) => el.textContent?.includes("One and 1 more"))).toBe(true);
    expect(cards().some((el) => el.textContent?.includes("Two and 2 more"))).toBe(true);
    const fr = await read("fr");
    expect(fr.sort()).toEqual(["1 ajouté · 1 déjà présent · 1 en échec", "2 ajoutés · 2 déjà présents · 2 en échec"]);
    expect(cards().some((el) => el.textContent?.includes("One et 1 autre") && !el.textContent?.includes("One et 1 autres"))).toBe(true);
    expect(cards().some((el) => el.textContent?.includes("Two et 2 autres"))).toBe(true);
  });

  // The real job Chris saw on 2026-11-24, made anonymous: 15 songs, 2 added, the folder deleted under the import.
  const gone = (n: number) => `${String(n).padStart(2, "0")} - Song ${n}.m4a`;
  const blackMarket = job(
    "Black Market Stuff (2018)",
    {
      finishedAt: 8,
      albumIds: ["alb-bm"],
      failures: Array.from({ length: 13 }, (_, i) => ({
        file: `/home/me/Music/Band/Black Market Stuff (2018)/${gone(i + 3)}`,
        error: `ENOENT: no such file or directory, open '/home/me/Music/Band/Black Market Stuff (2018)/${gone(i + 3)}'`,
      })),
    },
    { phase: "done", done: 15, total: 15, imported: 2, skipped: 0, failed: 13 }
  );
  const albums = (albumId: string): ImportJobAlbum | undefined =>
    albumId === "alb-bm" ? { title: "Black Market Stuff", cover: "parrot-cover://alb-bm" } : undefined;

  // @req UX-JOBS-02[parrot]
  // @req UX-JOBS-03[parrot]
  it("an import is Badger's group card: cover, album title, counts, pill and bin; one that left files out opens on its own", async () => {
    act(() => root.unmount());
    container.remove();
    current = [blackMarket, finished];
    await mount(Promise.resolve(current), "en", albums);
    await openPanel();
    const head = header(card("Black Market Stuff"));
    console.info(SUITE, "group card header", head?.textContent, head?.getAttribute("aria-expanded"));
    expect(head?.textContent).toContain("Black Market Stuff");
    expect(head?.textContent).toContain("2 added · 0 already there · 13 failed");
    expect(head?.querySelector("img")?.getAttribute("src")).toBe("parrot-cover://alb-bm");
    expect(head?.querySelector('[data-testid="import-job-status"]')?.textContent).toBe("Done");
    expect(head?.querySelector('[data-testid="import-job-remove"]')).not.toBeNull();
    expect(head?.getAttribute("aria-expanded")).toBe("true");
    expect(card("Black Market Stuff")?.querySelector('[data-testid="import-job-retry"]')?.textContent).toBe("Import again");
    // A finished import with nothing to do stays closed until its chevron opens it.
    const done = header(card("Finished Album"));
    expect(done?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => done?.click());
    expect(header(card("Finished Album"))?.getAttribute("aria-expanded")).toBe("true");
  });

  // @req UX-JOBS-03[parrot]
  it("13 files deleted under the import read as one plain line with the names behind Show files, never ENOENT or a path; French too", async () => {
    const read = async (language: ParrotLanguage) => {
      act(() => root.unmount());
      container.remove();
      current = [blackMarket];
      await mount(Promise.resolve(current), language, albums);
      await openPanel();
      return card("Black Market Stuff");
    };
    const en = await read("en");
    const groups = en?.querySelectorAll('[data-testid="import-job-failures"] > li');
    console.info(SUITE, "reason groups", [...(groups ?? [])].map((li) => li.querySelector("summary")?.textContent));
    expect(groups).toHaveLength(1);
    expect(groups?.[0]?.getAttribute("data-reason")).toBe("missing");
    expect(groups?.[0]?.querySelector("summary")?.textContent).toContain("13 files not found: they were moved or deleted after you chose them.");
    expect(groups?.[0]?.querySelector("summary")?.textContent).toContain("Show files");
    expect(groups?.[0]?.querySelectorAll("details li")).toHaveLength(13);
    expect(groups?.[0]?.querySelector("details li")?.textContent).toBe("03 - Song 3.m4a");
    expect(en?.querySelector('[data-testid="import-job-failed"]')?.textContent).toContain("Some files were not added.");
    // Neither the words nor any attribute carry the raw error, the errno or the folder.
    for (const leak of ["ENOENT", "no such file", "/home/", "open '"]) expect(en?.outerHTML, leak).not.toContain(leak);
    const fr = await read("fr");
    expect(fr?.querySelector('[data-testid="import-job-failures"] summary')?.textContent).toContain(
      "13 fichiers introuvables\u202f: ils ont été déplacés ou supprimés après votre choix."
    );
    expect(fr?.querySelector('[data-testid="import-job-failures"] summary')?.textContent).toContain("Voir les fichiers");
    for (const leak of ["ENOENT", "/home/"]) expect(fr?.outerHTML, leak).not.toContain(leak);
    // The start time is written the app language's way, not the system's.
    expect(en?.textContent).toContain(new Date(blackMarket.startedAt).toLocaleString("en"));
    expect(fr?.textContent).toContain(new Date(blackMarket.startedAt).toLocaleString("fr"));
  });

  // @req UX-JOBS-03[parrot]
  it("a stopped import says why in plain words, never the raw error", async () => {
    act(() => root.unmount());
    container.remove();
    const lost = job("Lost Album", { finishedAt: 9 }, { phase: "failed", total: 4, error: "ENOENT: no such file or directory, scandir '/home/me/Music/Lost Album'" });
    current = [lost];
    await mount(Promise.resolve(current));
    await openPanel();
    const text = card("Lost Album")?.querySelector('[data-testid="import-job-error"]')?.textContent;
    console.info(SUITE, "stopped reason", text);
    expect(text).toBe("This import stopped: its folder or files were moved or deleted after you chose them.");
    expect(card("Lost Album")?.outerHTML).not.toContain("ENOENT");
  });
});

describe("importFailureReason", () => {
  // @req UX-JOBS-03[parrot]
  it("sorts the importer's raw errors into the reasons the card names", () => {
    const cases: Record<string, ImportFailureReason> = {
      "ENOENT: no such file or directory, open '/x/a.m4a'": "missing",
      "ENOTDIR: not a directory, open '/x/a.m4a'": "missing",
      "not an audio file": "unsupported",
      "EACCES: permission denied, open '/x/a.m4a'": "unreadable",
      "EISDIR: illegal operation on a directory, read": "unreadable",
      "fetch failed": "network",
      "connect ECONNREFUSED 127.0.0.1:443": "network",
      "upload failed: HTTP 503": "network",
      "version_conflict": "conflict",
      "something odd": "other",
    };
    const got = Object.fromEntries(Object.keys(cases).map((error) => [error, importFailureReason(error)]));
    console.info(SUITE, "reasons", got);
    expect(got).toEqual(cases);
  });
});
