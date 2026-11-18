// @vitest-environment jsdom
/**
 * "Add to library" must not open up for one render when a video's probe lands after its sidecar subtitle was grouped
 * with it. The episode slot was seeded with the sidecar's track only; the probe's embedded tracks (one with no
 * language) were left out of the slot's selection until an effect caught up a render later, so the language prompt
 * was missing for that render and Add turned on, then off again (#2760). The drag-drop-import e2e caught that window
 * and clicked a button that switched itself off.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FileIngestionDialog from "../src/renderer/src/components/FileIngestionDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@space/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@space/ui")>()),
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "type"> & { onCheckedChange?: (checked: boolean) => void }) => (
    <input type="checkbox" checked={checked} onChange={(event) => onCheckedChange?.(event.target.checked)} {...props} />
  ),
  Dialog: ({ children, open }: { children?: React.ReactNode; open?: boolean }) => (open === false ? null : <div>{children}</div>),
  DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  DialogDescription: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => <p {...props}>{children}</p>,
  DialogFooter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ImportReviewDialog: ({
    children,
    title,
    open: _open,
    onOpenChange: _onOpenChange,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & { title?: React.ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }) => (
    <div {...props}>
      <div>{title}</div>
      {children}
    </div>
  ),
  ImportReviewPicker: ({ title }: { title?: React.ReactNode }) => <div>{title}</div>,
  ImportReviewBody: (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} />,
  ImportReviewList: (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} />,
  ImportReviewDetail: (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} />,
  ImportReviewFooter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ImportReviewSummary: (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} />,
  ImportReviewActions: (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} />,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  toast: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (typeof vars?.count === "number" ? `${key}:${vars.count}` : key),
    i18n: { language: "en" },
  }),
}));
vi.mock("../src/renderer/src/auth", () => ({ useAuth: () => ({ token: "token", user: { id: "user-1" } }) }));
vi.mock("../src/renderer/src/lib/useClientConfig", () => ({
  useClientConfig: () => ({
    enableCodecSelection: false,
    transcodeOutputs: [],
    trailerSource: { provider: "youtube", validated: true, invidiousUrl: "" },
  }),
}));
vi.mock("../src/renderer/src/lib/libraryContext", () => ({
  useLibraryData: () => ({ media: [] }),
  useLibraryActions: () => ({
    getMediaDetails: () => null,
    fetchMediaDetails: async () => null,
    getSharedSetting: () => null,
    addMediaFromTmdb: vi.fn(),
    addSubtitleTrackWithObject: vi.fn(),
    listSkipAnalysis: async () => [],
    upsertSkipAnalysis: async () => undefined,
  }),
}));
vi.mock("../src/renderer/src/components/MediaImage", () => ({ default: ({ alt }: { alt?: string }) => <img alt={alt ?? ""} /> }));
vi.mock("../src/renderer/src/lib/metadata", () => ({
  getTmdbDetails: vi.fn(),
  getTmdbDetailsForLibrary: vi.fn(),
  getTmdbTrailersForLanguages: vi.fn().mockResolvedValue([]),
  localizeSearchResultForLibrary: vi.fn(async (_token: unknown, result: unknown) => result),
  searchTmdb: vi.fn(async (_token: unknown, type: string, query: string) => ({
    results: [{ type, id: 900763, title: query, originalTitle: query, overview: "", year: 2018 }],
  })),
}));
vi.mock("../src/renderer/src/lib/metadataTickets", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  metadataClient: { skipMarkers: async () => ({ markers: [], coverage: [] }) },
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../src/renderer/src/components/LoadingModalProvider", () => ({
  useLoadingModal: () => ({ showLoading: vi.fn().mockReturnValue("loading"), hideLoading: vi.fn() }),
}));

const EPISODE = "/tv/Saltmarsh - S01E01 - Low Tide.mkv";
const SIDECAR = "/subs/Saltmarsh - S01E01 - Low Tide.fr.srt";

/** What ffprobe reports for the drag-drop-import Saltmarsh fixture: English sound, four embedded subtitles, one `und`. */
const episodeProbe = {
  video: { codec: "h264", width: 1920, height: 1080 },
  audio: { count: 1, languages: ["eng"] },
  subtitles: { count: 4, languages: ["eng", "fre", "fre", "und"] },
  chapters: { count: 0 },
  durationSeconds: 60,
  audioTracks: [{ index: 1, language: "eng", label: "English", codec: "ac3", channels: 6 }],
  subtitleTracks: [
    { index: 2, language: "eng", label: "English", codec: "subrip" },
    { index: 3, language: "fre", label: "French", codec: "subrip" },
    { index: 4, language: "fre", label: "French Forced", codec: "subrip" },
    { index: 5, language: "und", label: null, codec: "subrip" },
  ],
};

let container: HTMLDivElement;
let root: Root;
let releaseProbe: (value: unknown) => void;

const addButton = () =>
  Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
    (button.textContent ?? "").includes("ingestion.ui.addToLibrary"),
  ) ?? null;
const inputNeededButton = () =>
  Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
    (button.textContent ?? "").startsWith("ingestion.ui.yourInputNeeded:"),
  ) ?? null;

const flush = async (rounds = 10) => {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 0);
      await promise;
    });
  }
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const probe = Promise.withResolvers<unknown>();
  releaseProbe = probe.resolve;
  Object.assign(window, {
    sf: {
      scanFiles: vi.fn(async (paths: string[]) =>
        paths.map((path) => ({
          path,
          name: path.split("/").pop() ?? path,
          size: 1_000_000,
          kind: path.endsWith(".srt") ? ("subtitle" as const) : ("video" as const),
        })),
      ),
      probeMedia: vi.fn(() => probe.promise),
      sampleSubtitleText: vi.fn(async () => ({ kind: "text", value: "Bonjour, je suis là. Où est la gare ? Merci beaucoup." })),
    },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("FileIngestionDialog — a probe that lands late", () => {
  it("keeps Add to library off while the late probe's undefined subtitle waits for a language", async () => {
    await act(async () => {
      root.render(<FileIngestionDialog open paths={[EPISODE, SIDECAR]} pathsNonce={1} onOpenChange={vi.fn()} />);
    });
    await flush();
    const add = addButton();
    expect(add, container.textContent ?? "").not.toBeNull();
    // Identified and grouped with its sidecar, still waiting on the probe.
    expect(add?.disabled).toBe(true);
    expect(container.textContent).toContain("Saltmarsh");

    // Every commit's `disabled` change on Add, in order: `null` old value = it was enabled before that change.
    const changes: Array<{ wasDisabled: boolean }> = [];
    const observer = new MutationObserver((records) => {
      records.forEach((record) => {
        if (record.target === add && record.attributeName === "disabled") {
          changes.push({ wasDisabled: record.oldValue !== null });
        }
      });
    });
    observer.observe(container, { subtree: true, attributes: true, attributeFilter: ["disabled"], attributeOldValue: true });

    await act(async () => {
      releaseProbe(episodeProbe);
    });
    await flush();
    observer.takeRecords().forEach((record) => {
      if (record.target === add && record.attributeName === "disabled") {
        changes.push({ wasDisabled: record.oldValue !== null });
      }
    });
    observer.disconnect();

    expect(inputNeededButton()?.textContent, container.textContent ?? "").toBe("ingestion.ui.yourInputNeeded:1");
    expect(addButton()).toBe(add);
    expect(add?.disabled).toBe(true);
    // Add never opened up on the way: the old code removed `disabled` for one render, then put it back.
    expect(changes).toEqual([]);
  });
});
