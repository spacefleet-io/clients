// @vitest-environment jsdom
/**
 * @req MPV-PREV-07
 *
 * The skip-detection catch-up is a job type in the Jobs queue (Chris 2026-11-24, via Main): one "Finding intro and
 * credits" job per video, grouped per title like an import, its step in the badge and its bar in the row. Cancel
 * keeps the job with "Try again" in the failed layout; Remove from history hides a finished one (a removed failed or
 * cancelled video stays left out, with "Try again" on its title's details); "Clear finished" removes every finished
 * job, imports' and skip detection's alike; a title's queued and done episodes stay folded, so hundreds of done
 * episodes never render open.
 */

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createInstance, type TFunction } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaRow } from "@space/shared/libraryTypes";
import type { SkipCatchUpStatus } from "../src/renderer/src/lib/skipCatchUp";
import { buildSkipDetectGroups, formatRetryTime } from "../src/renderer/src/lib/skipDetectJobs";
import View from "../src/renderer/src/components/TopNavJobsSidebarContent";
import en from "../src/renderer/src/i18n/en.json";
import fr from "../src/renderer/src/i18n/fr.json";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "skip-detect-jobs";

vi.mock("@space/ui", () => ({
  Button: ({ children, onClick, title, variant: _v, size: _s, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button onClick={onClick} aria-label={title} {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@space/desktop-shell/components", async () => ({
  ...(await vi.importActual<object>("@space/desktop-shell/desktop-job-card")),
  AnimatedDismissRow: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  DesktopJobsFilterBar: ({ trailing }: { trailing?: React.ReactNode }) => <div>{trailing}</div>,
  DesktopJobsEmpty: () => <div data-testid="jobs-empty" />,
  useStaggeredDismiss: () => ({ dismissing: new Set<string>(), scheduleDismiss: (_id: string, action: () => void) => action() }),
}));

vi.mock("lucide-react", () => ({
  ChevronDown: () => <span />,
  ChevronRight: () => <span />,
  Trash2: () => <span />,
  X: () => <span />,
}));

const { dismissJob } = vi.hoisted(() => ({ dismissJob: vi.fn() }));

vi.mock("../src/renderer/src/components/MediaImage", () => ({ default: () => <div /> }));
vi.mock("../src/renderer/src/lib/useClientConfig", () => ({
  useClientConfig: () => ({ enableCodecSelection: false, runtimeEngineV2Enabled: true }),
}));

const media = [
  { id: "b99", title: "Brooklyn Nine-Nine", type: "tv", posterPath: null },
  { id: "pr", title: "Parks and Recreation", type: "tv", posterPath: null },
  { id: "coco", title: "Coco", type: "movie", posterPath: null },
] as unknown as MediaRow[];

vi.mock("../src/renderer/src/lib/libraryContext", () => ({ useOptionalLibraryData: () => ({ media }) }));

// One import beside the skip jobs: the two kinds share the panel.
vi.mock("../src/renderer/src/lib/runtimeIngestJobs", () => ({
  useRuntimeIngestJobs: () => ({
    jobs: [],
    groups: [
      {
        id: "import-1",
        title: "The Office",
        posterPath: null,
        type: "movie",
        progress: 40,
        status: "transcoding",
        stageLabel: "Transcoding 360p",
        uploadSpeedMbps: 0,
        jobs: [{ id: "imp-job", filename: "office.mkv", status: "transcoding", progress: 40, createdAt: "2026-11-24T10:00:00Z", jobType: "transcode" }],
      },
    ],
    loading: false,
    error: null,
  }),
  useRuntimeIngestActions: () => ({ cancelJob: vi.fn(), cancelByGroup: vi.fn(), dismissJob, retryJob: vi.fn(), submitSources: vi.fn() }),
  findStaleOrphanGroupIds: () => [],
  pickMostActiveJob: (jobs: Array<{ status: string }>) =>
    jobs.find((j) => j.status === "transcoding" || j.status === "uploading") ??
    jobs.find((j) => !["done", "cancelled", "failed"].includes(j.status)) ??
    jobs[0] ??
    null,
}));

type Video = SkipCatchUpStatus["videos"][number];
const video = (formatId: string, mediaId: string, episode: number | null, status: Video["status"], over: Partial<Video> = {}): Video => ({
  formatId,
  mediaId,
  season: episode === null ? null : 1,
  episode,
  status,
  result: status === "done" ? "found_both" : null,
  failedStep: status === "failed" ? "download" : null,
  retryAt: null,
  ...over,
});

/** Parks and Recreation: E3 running, E4-E5 queued, E1-E2 done; Brooklyn Nine-Nine: 200 done episodes; Coco done. */
const library = (over: Partial<SkipCatchUpStatus> = {}): SkipCatchUpStatus => ({
  state: "running",
  retryAt: null,
  handled: 203,
  total: 206,
  current: { formatId: "pr3", mediaId: "pr", season: 1, episode: 3, running: true, phase: "download", downloaded: 0.25, downloadedBytes: 12_400_000, totalBytes: 48_200_000, progress: 0.225 },
  failed: [],
  cancelled: [],
  videos: [
    video("pr3", "pr", 3, "running"),
    video("pr4", "pr", 4, "queued"),
    video("pr5", "pr", 5, "queued"),
    video("pr1", "pr", 1, "done", { result: "found_intro" }),
    video("pr2", "pr", 2, "done"),
    ...Array.from({ length: 200 }, (_, i) => video(`b${i + 1}`, "b99", i + 1, "done")),
    video("coco", "coco", null, "done", { result: "previews_made" }),
  ],
  finishedAt: null,
  ...over,
});

const i18nFor = async (lng: "en" | "fr") => {
  const i18n = createInstance();
  await i18n.init({
    lng,
    fallbackLng: "en",
    resources: { en: { translation: en }, fr: { translation: fr } },
    interpolation: { escapeValue: false },
  });
  return i18n;
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let current: SkipCatchUpStatus = library();
const getStatus = vi.fn(async () => current);
const retry = vi.fn(async (_formatId: string | null) => true);
const setVideo = vi.fn(async (_formatId: string, _action: "cancel" | "dismiss") => true);

const render = async (lng: "en" | "fr" = "en") => {
  Object.assign(window, { sf: { skipCatchUp: { getStatus, retry, setVideo }, runtimeJobs: { availability: async () => ({ jobs: [], keptBytesTotal: 0 }) } } });
  const i18n = await i18nFor(lng);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <I18nextProvider i18n={i18n}>
        <View />
      </I18nextProvider>,
    ),
  );
  // The first poll answers.
  await act(async () => {
    await Promise.resolve();
  });
};

const byTestId = (id: string) => container?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
const click = async (el: Element | null | undefined) => {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};
/** The group card whose title is `title`. */
const card = (title: string) =>
  [...(container?.querySelectorAll<HTMLElement>('[role="button"]') ?? [])].find((el) => el.textContent?.includes(title)) ?? null;
/** The episode heading whose title is `title` ("S01E03"). */
const heading = (title: string) =>
  [...(container?.querySelectorAll<HTMLElement>('[role="button"]') ?? [])].find((el) => el.querySelector("span.truncate")?.textContent === title) ?? null;
/** The failed-layout detail of a job, drawn only while its episode is open. */
const rowOf = (id: string) => byTestId(`failed-job-detail-${id}`);
const repoll = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  current = library();
  getStatus.mockClear();
  retry.mockClear();
  setVideo.mockClear();
  dismissJob.mockClear();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "sf");
});

describe("skip detection in the Jobs queue (MPV-PREV-07)", () => {
  it("@req MPV-PREV-07 maps each video to a Finding intro and credits job, one group per title, running first, step and bar from the running video", async () => {
    const t = (await i18nFor("en")).t as TFunction;
    const { groups, videos } = buildSkipDetectGroups(library(), media, t, Date.now(), "en");
    console.info(`[${SUITE}:map] ${JSON.stringify(groups.map((g) => [g.id, g.title, g.status, g.stageLabel, g.jobs.length]))}`);
    expect(groups.map((g) => g.title)).toEqual(["Parks and Recreation", "Brooklyn Nine-Nine", "Coco"]);
    const [pr] = groups;
    // The title's badge says the step in one word, so the title keeps its room; the row's badge has the detail.
    expect(pr).toMatchObject({ status: "transcoding", stageLabel: "Downloading", type: "tv" });
    expect(pr!.jobs[0]!.stageLabel).toBe("Downloading 12 of 48 MB");
    expect(pr!.jobs.map((j) => [j.filename, j.status, j.progress, j.queuePosition ?? null])).toEqual([
      ["S01E03", "transcoding", 23, null],
      ["S01E04", "waiting", 0, 1],
      ["S01E05", "waiting", 0, 2],
      ["S01E01", "done", 100, null],
      ["S01E02", "done", 100, null],
    ]);
    expect(pr!.jobs.every((j) => j.jobType === "skip-detect")).toBe(true);
    expect(videos.get("skip-detect:pr1")?.result).toBe("found_intro");
    const frT = (await i18nFor("fr")).t as TFunction;
    const sound = library({ current: { ...library().current!, phase: "sound" } });
    const [frGroup] = buildSkipDetectGroups(sound, media, frT, Date.now(), "fr").groups;
    expect([frGroup!.stageLabel, frGroup!.jobs[0]!.stageLabel]).toEqual(["Son", "Lecture du son"]);
    // Hidden a day after the list ran dry.
    const done = library({ state: "done", current: null, finishedAt: "2026-11-20T10:00:00Z" });
    expect(buildSkipDetectGroups(done, media, t, Date.parse("2026-11-22T10:00:00Z"), "en").groups).toEqual([]);
  });

  it("@req MPV-PREV-07 sits beside an import in the panel, folded per title: hundreds of done episodes render no row", async () => {
    await render("en");
    const text = container?.textContent ?? "";
    console.info(`[${SUITE}:panel] rows=${container?.querySelectorAll("button[aria-label]").length} text=${text.slice(0, 300)}`);
    expect(text).toContain("The Office");
    expect(text).toContain("Parks and Recreation");
    expect(text).toContain("Brooklyn Nine-Nine");
    // Every title is folded: no episode heading of the 200 done ones, no row.
    expect(text).not.toContain("S01E150");
    expect(text).not.toContain("Finding intro and credits");
    await click(card("Brooklyn Nine-Nine"));
    const open = container?.textContent ?? "";
    // Opened, the done episodes show as one heading each, folded: no row.
    expect(open).toContain("S01E150");
    expect(open).not.toContain("Intro and credits found");
    for (const word of ["confidence", "group", "split", "adjust"]) expect(open.toLowerCase()).not.toContain(word);
  });

  it("@req MPV-PREV-07 Cancel keeps the video with what happened and Try again; Try again asks the runtime again", async () => {
    await render("en");
    await click(card("Parks and Recreation"));
    // The running episode is open: its label, its step once (in its badge, not again in the label), and its Cancel.
    expect(container?.textContent).toContain("Finding intro and creditsS01E03Downloading 12 of 48 MB23%");
    expect(container?.textContent).not.toContain("Finding intro and credits · ");
    const cancel = container?.querySelector('button[aria-label="Cancel"]');
    current = library({
      current: null,
      videos: [video("pr3", "pr", 3, "cancelled"), ...library().videos.filter((v) => v.formatId !== "pr3")],
    });
    await click(cancel);
    await repoll();
    // Cancel folds the episode, open as it was (Chris 2026-11-24); the title stays open, its queued episodes still wait.
    expect(rowOf("skip-detect:pr3")).toBeNull();
    expect(container?.textContent).toContain("S01E04");
    await click(heading("S01E03"));
    console.info(`[${SUITE}:cancel] setVideo=${JSON.stringify(setVideo.mock.calls)} detail=${byTestId("failed-job-detail-skip-detect:pr3")?.textContent ?? "(none)"}`);
    expect(setVideo).toHaveBeenCalledWith("pr3", "cancel");
    const detail = byTestId("failed-job-detail-skip-detect:pr3");
    expect(detail?.textContent).toContain("You cancelled it.");
    expect(detail?.textContent).toContain("This video is left out until you try again.");
    // It has a bin too: removed, it stays left out and its title's details keep "Try again" (PLAY-SKIP-09).
    const bin = container?.querySelector('button[aria-label="Remove from history"]');
    expect(bin).not.toBeNull();
    await click(byTestId("failed-job-action-skip-detect:pr3"));
    expect(retry).toHaveBeenCalledWith("pr3");
    await click(bin);
    expect(setVideo).toHaveBeenCalledWith("pr3", "dismiss");
  });

  it("@req MPV-PREV-07 a failed video opens its title with what happened and Try again (EN + FR)", async () => {
    current = library({ videos: [video("pr3", "pr", 3, "failed"), ...library().videos.filter((v) => v.formatId !== "pr3")], current: null, state: "running" });
    await render("fr");
    const detail = byTestId("failed-job-detail-skip-detect:pr3");
    console.info(`[${SUITE}:failed] ${detail?.textContent}`);
    expect(detail?.textContent).toContain("Impossible de télécharger la copie stockée");
    expect(byTestId("failed-job-action-skip-detect:pr3")?.textContent).toBe("Réessayer");
  });

  it("@req MPV-PREV-07 Remove from history on a done film hides it through the runtime; a film only gets previews", async () => {
    await render("en");
    await click(card("Coco"));
    expect(container?.textContent).toContain("Making seek-bar previews");
    const remove = container?.querySelector('button[aria-label="Remove from history"]');
    expect(container?.textContent).toContain("Seek-bar previews ready");
    await click(remove);
    expect(setVideo).toHaveBeenCalledWith("coco", "dismiss");
  });

  it("@req MPV-PREV-07 Clear finished removes every finished job, imports' and skip detection's; what runs or waits stays (EN + FR)", async () => {
    current = library({ videos: [video("pr6", "pr", 6, "cancelled"), video("pr7", "pr", 7, "failed"), ...library().videos] });
    await render("fr");
    const clear = byTestId("jobs-clear-finished");
    expect(clear?.textContent).toBe("Effacer les tâches terminées");
    await click(clear);
    const dismissed = setVideo.mock.calls.filter(([, a]) => a === "dismiss").map(([id]) => id);
    console.info(`[${SUITE}:clear] dismissed=${dismissed.length} imports=${JSON.stringify(dismissJob.mock.calls)}`);
    expect(new Set(dismissed)).toEqual(new Set(["pr1", "pr2", "pr6", "pr7", ...Array.from({ length: 200 }, (_, i) => `b${i + 1}`), "coco"]));
    for (const id of ["pr3", "pr4", "pr5"]) expect(dismissed).not.toContain(id);
    // The transcoding import is not finished: it stays.
    expect(dismissJob).not.toHaveBeenCalled();
  });

  it("@req MPV-PREV-07 a title with only failed or cancelled episodes has Remove all from history, which removes them all", async () => {
    current = library({ current: null, videos: [video("pr3", "pr", 3, "failed"), video("pr4", "pr", 4, "cancelled"), ...library().videos.filter((v) => v.mediaId !== "pr")] });
    await render("en");
    const prCard = card("Parks and Recreation");
    const bulk = [...(container?.querySelectorAll('button[aria-label="Remove all from history"]') ?? [])].find((b) => prCard?.contains(b) || b.closest('[role="button"]') === prCard);
    expect(bulk).toBeTruthy();
    await click(bulk);
    expect(setVideo.mock.calls.filter(([, a]) => a === "dismiss").map(([id]) => id).sort()).toEqual(["pr3", "pr4"]);
  });

  it("@req MPV-PREV-07 paused: one line says why, under the filters", async () => {
    current = library({ state: "paused_playback", current: { ...library().current!, running: false } , videos: library().videos.map((v) => (v.status === "running" ? { ...v, status: "queued" as const } : v)) });
    await render("fr");
    expect(byTestId("skip-detect-paused")?.textContent).toBe("En pause pendant la lecture");
  });

  it("@req MPV-PREV-07 a cancelled title goes to the bottom; the rest of the list keeps its order", async () => {
    const t = (await i18nFor("en")).t as TFunction;
    // The runtime lists cancelled videos last; a title with only cancelled videos sinks below the done ones.
    const status = library({
      current: null,
      videos: [
        video("pr4", "pr", 4, "queued"),
        ...Array.from({ length: 3 }, (_, i) => video(`b${i + 1}`, "b99", i + 1, "done")),
        video("pr1", "pr", 1, "done"),
        video("coco", "coco", null, "cancelled"),
        video("pr3", "pr", 3, "cancelled"),
      ],
    });
    const { groups } = buildSkipDetectGroups(status, media, t, Date.now(), "en");
    console.info(`[${SUITE}:order] ${JSON.stringify(groups.map((g) => [g.title, g.status, g.jobs.map((j) => j.filename)]))}`);
    expect(groups.map((g) => g.title)).toEqual(["Parks and Recreation", "Brooklyn Nine-Nine", "Coco"]);
    expect(groups[0]!.jobs.map((j) => j.filename)).toEqual(["S01E04", "S01E01", "S01E03"]);
    // Coco was first among the titles before its cancel; now only its rank moved.
    const before = buildSkipDetectGroups(
      library({ current: null, videos: [video("coco", "coco", null, "queued"), ...status.videos.filter((v) => v.formatId !== "coco")] }),
      media,
      t,
      Date.now(),
      "en",
    ).groups;
    expect(before.map((g) => g.title)).toEqual(["Coco", "Parks and Recreation", "Brooklyn Nine-Nine"]);
  });

  it("@req MPV-PREV-07 cancel folds the card, open or not; running to done leaves an open card open", async () => {
    current = library({
      current: { formatId: "coco", mediaId: "coco", season: null, episode: null, running: true, phase: "pictures", downloaded: 1, downloadedBytes: 1, totalBytes: 1, progress: 0.6 },
      videos: [video("coco", "coco", null, "running"), video("pr1", "pr", 1, "done"), video("pr2", "pr", 2, "queued")],
    });
    // Only the 5 s status poll is faked, so a status change lands without a user action.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await render("en");
    await click(card("Coco"));
    expect(container?.textContent).toContain("Reading pictures");
    // Running to done: the card the user opened stays open.
    current = library({ current: null, videos: [video("coco", "coco", null, "done", { result: "previews_made" }), video("pr1", "pr", 1, "done"), video("pr2", "pr", 2, "running")] });
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    await repoll();
    expect(container?.textContent).toContain("Seek-bar previews ready");
    // E2 was first seen waiting, so it started folded and starting to run did not open it.
    await click(card("Parks and Recreation"));
    expect(container?.querySelectorAll('button[aria-label="Cancel"]').length).toBe(0);
    // Opened by hand, then cancelled: the episode and the card fold.
    await click(heading("S01E02"));
    const cancel = container?.querySelector('button[aria-label="Cancel"]');
    expect(cancel).not.toBeNull();
    current = library({ current: null, videos: [video("coco", "coco", null, "done", { result: "previews_made" }), video("pr1", "pr", 1, "done"), video("pr2", "pr", 2, "cancelled")] });
    await click(cancel);
    await repoll();
    console.info(`[${SUITE}:fold] ${container?.textContent?.slice(0, 400)}`);
    expect(setVideo).toHaveBeenCalledWith("pr2", "cancel");
    expect(container?.textContent).not.toContain("S01E02");
    // Coco was not touched: still open.
    expect(container?.textContent).toContain("Seek-bar previews ready");
  });

  it.each([
    ["en", "Waiting for your import"],
    ["fr", "En attente de votre import"],
  ] as const)("@req MPV-PREV-07 while an import runs, the waiting videos say so instead of their place in line (%s)", async (lng, label) => {
    const t = (await i18nFor(lng)).t as TFunction;
    const status = library({
      state: "paused_import",
      current: null,
      videos: library().videos.map((v) => (v.status === "running" ? { ...v, status: "queued" as const } : v)),
    });
    const [pr] = buildSkipDetectGroups(status, media, t, Date.now(), lng).groups;
    console.info(`[${SUITE}:waitingImport:${lng}] ${pr!.stageLabel} ${JSON.stringify(pr!.jobs.map((j) => [j.stageLabel ?? null, j.queuePosition ?? null]))}`);
    expect(pr!.stageLabel).toBe(label);
    expect(pr!.queuePosition).toBeUndefined();
    expect(pr!.jobs.filter((j) => j.status === "waiting").every((j) => j.stageLabel === label && j.queuePosition === undefined)).toBe(true);
  });

  it.each([
    ["en", "Trying again at", "Could not download the stored copy", "Badger tries this video again on its own at", "Try again now"],
    ["fr", "Nouvel essai à", "Impossible de télécharger la copie stockée", "Badger réessaie cette vidéo de lui-même à", "Réessayer maintenant"],
  ] as const)(
    "@req MPV-PREV-07 a video waiting out its hour after a failed try reads 'trying again at HH:MM', never a place in line, and Try again now asks the runtime (%s)",
    async (lng, at, what, meaning, action) => {
      // Chris 2026-11-24 (Mad Men stuck in Jobs): E4 failed once and sits out its hour while E5 waits in line.
      const retryAt = "2026-11-24T14:05:00.000Z";
      const time = formatRetryTime(retryAt, lng);
      const t = (await i18nFor(lng)).t as TFunction;
      const videos = library().videos.map((v) =>
        v.formatId === "pr4" ? { ...v, status: "retry_waiting" as const, failedStep: "download" as const, retryAt } : v,
      );
      const [pr] = buildSkipDetectGroups(library({ videos }), media, t, Date.now(), lng).groups;
      console.info(`[${SUITE}:retryWait:${lng}] ${pr!.stageLabel} ${JSON.stringify(pr!.jobs.map((j) => [j.filename, j.stageLabel ?? null, j.queuePosition ?? null]))}`);
      const e4 = pr!.jobs.find((j) => j.filename === "S01E04")!;
      expect(e4).toMatchObject({ status: "waiting", stageLabel: `${at} ${time}` });
      expect(e4.queuePosition).toBeUndefined();
      // E5 is first in line now; the held one takes no place.
      expect(pr!.jobs.find((j) => j.filename === "S01E05")!.queuePosition).toBe(1);

      // Only held videos left: the title says when, with no place in line, and so does the panel.
      const onlyHeld = library({
        state: "retry_wait",
        retryAt,
        current: null,
        videos: [video("pr4", "pr", 4, "retry_waiting", { failedStep: "download", retryAt }), video("pr1", "pr", 1, "done")],
      });
      const [held] = buildSkipDetectGroups(onlyHeld, media, t, Date.now(), lng).groups;
      expect(held).toMatchObject({ status: "waiting", stageLabel: `${at} ${time}` });
      expect(held!.queuePosition).toBeUndefined();

      current = onlyHeld;
      await render(lng);
      expect(byTestId("skip-detect-paused")?.textContent).toBe(`${at} ${time}`);
      await click(card("Parks and Recreation"));
      await click(heading("S01E04"));
      const detail = rowOf("skip-detect:pr4");
      console.info(`[${SUITE}:retryWaitDetail:${lng}] ${detail?.textContent}`);
      expect(detail?.textContent).toContain(what);
      expect(detail?.textContent).toContain(`${meaning} ${time}.`);
      expect(container?.textContent).not.toMatch(/1st|1er|in line|file d’attente/i);
      const tryNow = byTestId("failed-job-action-skip-detect:pr4");
      expect(tryNow?.textContent).toBe(action);
      await click(tryNow);
      expect(retry).toHaveBeenCalledWith("pr4");
    },
  );
});
