// @vitest-environment jsdom
/**
 * @req PLAY-SKIP-09
 *
 * The show page's left-out episodes (Main 2026-11-24, pending Chris's review on the test copy): an episode the
 * skip-detection catch-up left out (failed or cancelled, MPV-PREV-07) reads "Left out · Try again" on its row, even
 * after its Jobs entry was removed; a title with two or more has "Try again for all left-out episodes", which asks
 * again for each of its videos and never for the whole library.
 */

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaDetails } from "@space/shared/libraryTypes";
import type { SkipCatchUpStatus } from "../src/renderer/src/lib/skipCatchUp";
import en from "../src/renderer/src/i18n/en.json";
import fr from "../src/renderer/src/i18n/fr.json";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@space/ui", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  Dialog: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  DialogContent: () => null,
  DialogDescription: () => null,
  DialogFooter: () => null,
  DialogHeader: () => null,
  DialogTitle: () => null,
  toast: vi.fn(),
}));
vi.mock("lucide-react", () => ({ SkipForward: () => <span /> }));
vi.mock("@space/metadata-client", () => ({ queueSkipContribution: vi.fn() }));
vi.mock("../src/renderer/src/lib/mpvSkipEdit", () => ({ applySkipEdit: vi.fn(), preselectSkipEdit: vi.fn() }));
vi.mock("../src/renderer/src/logger", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger };
  return { rendererLogger: logger };
});

import { SkipLeftOutChip, SkipLeftOutRetryAll } from "../src/renderer/src/components/SkipTimesEditor";

/** Parks and Recreation S1: E1 failed, E2 done, E3 cancelled (its Jobs entry removed: it is only in `cancelled`). */
const media = {
  id: "pr",
  title: "Parks and Recreation",
  episodes: [1, 2, 3].map((n) => ({ id: `e${n}`, seasonNumber: 1, episodeNumber: n })),
  files: [1, 2, 3].map((n) => ({ id: `f${n}`, season: 1, episode: n })),
  formats: [1, 2, 3].flatMap((n) => [
    { id: `pr${n}`, fileId: `f${n}`, isSource: true, durationSeconds: 1290, previewSheets: null },
    { id: `pr${n}-720`, fileId: `f${n}`, isSource: false, durationSeconds: 1290, previewSheets: null },
  ]),
  skipMarkers: [],
} as unknown as MediaDetails;

const entry = (formatId: string, mediaId: string, episode: number) => ({ formatId, mediaId, season: 1, episode });
const status = (over: Partial<SkipCatchUpStatus> = {}): SkipCatchUpStatus => ({
  state: "done",
  retryAt: null,
  handled: 4,
  total: 4,
  current: null,
  failed: [entry("pr1", "pr", 1), entry("b1", "b99", 1)],
  cancelled: [entry("pr3", "pr", 3)],
  videos: [{ ...entry("pr1", "pr", 1), status: "failed", result: null, failedStep: "download", retryAt: null }],
  finishedAt: null,
  ...over,
}) as SkipCatchUpStatus;

let current = status();
const getStatus = vi.fn(async () => current);
const retry = vi.fn(async (_formatId: string | null) => true);

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  current = status();
  vi.clearAllMocks();
  Reflect.deleteProperty(window, "sf");
});

const render = async (lng: "en" | "fr" = "en") => {
  Object.assign(window, { sf: { skipCatchUp: { getStatus, retry, setVideo: vi.fn() } } });
  const i18n = createInstance();
  await i18n.init({ lng, fallbackLng: "en", resources: { en: { translation: en }, fr: { translation: fr } }, interpolation: { escapeValue: false } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <I18nextProvider i18n={i18n}>
        <SkipLeftOutRetryAll media={media} />
        {media.episodes.map((episode) => (
          <SkipLeftOutChip key={episode.id} media={media} episodeId={episode.id} />
        ))}
      </I18nextProvider>,
    ),
  );
  // The first poll answers.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

const byId = (id: string) => container?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
const click = async (el: HTMLElement | null) =>
  act(async () => {
    el?.click();
    await new Promise((r) => setTimeout(r, 0));
  });

describe("left-out episodes on the show page (PLAY-SKIP-09)", () => {
  it("@req PLAY-SKIP-09 a failed or cancelled episode reads Left out · Try again, a done one nothing; Try again asks for that video only", async () => {
    await render("en");
    expect(byId("skip-left-out-e1")?.textContent).toBe("Left out·Try again");
    expect(byId("skip-left-out-e2")).toBeNull();
    // Removed from the Jobs history, still left out.
    expect(byId("skip-left-out-e3")?.textContent).toBe("Left out·Try again");
    await click(byId("skip-left-out-retry-e3"));
    expect(retry.mock.calls).toEqual([["pr3"]]);
  });

  it("@req PLAY-SKIP-09 Try again for all left-out episodes asks for each of the title's videos, never the whole library (FR)", async () => {
    await render("fr");
    expect(byId("skip-left-out-e1")?.textContent).toBe("Mis de côté·Réessayer");
    const all = byId("skip-left-out-retry-all");
    expect(all?.textContent).toBe("Réessayer pour tous les épisodes mis de côté");
    await click(all);
    expect(retry.mock.calls.map(([id]) => id).sort()).toEqual(["pr1", "pr3"]);
    expect(retry).not.toHaveBeenCalledWith(null);
  });

  it("@req PLAY-SKIP-09 one left-out episode has no Try again for all", async () => {
    current = status({ cancelled: [] });
    await render("en");
    expect(byId("skip-left-out-e1")).not.toBeNull();
    expect(byId("skip-left-out-retry-all")).toBeNull();
  });
});
