// @vitest-environment jsdom
/**
 * Chris 2026-11-12 (chat): HEVC videos import like any other video, with no warning
 * ("drop this screen, it's scary for no reason, most devices will play it with no
 * issues"). Drives the real FileIngestionDialog drop path (scanFiles → probeMedia) with
 * ffprobe-shaped probe results that say HEVC, and checks no notice appears and "Add" opens up.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import FileIngestionDialog from "../src/renderer/src/components/FileIngestionDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const P = "[file-ingestion-hevc-no-notice]";

// Real list/match pieces; the Radix dialog frames are flattened so the content renders inline.
vi.mock("@space/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@space/ui")>()),
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "type"> & {
    onCheckedChange?: (checked: boolean) => void;
  }) => <input type="checkbox" checked={checked} onChange={(e) => onCheckedChange?.(e.target.checked)} {...props} />,
  Dialog: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  DialogDescription: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => <p {...props}>{children}</p>,
  DialogFooter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  // The shared import review frame (REL-FAM-02), flattened like the Dialog pieces above.
  ImportReviewDialog: ({ children, title, open: _open, onOpenChange: _onOpenChange, ...props }: React.HTMLAttributes<HTMLDivElement> & { title?: React.ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }) => (
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
    t: (key: string, vars?: Record<string, unknown>) =>
      typeof vars?.count === "number" ? `${key}:${vars.count}` : key,
    i18n: { language: "en" },
  }),
}));

vi.mock("../src/renderer/src/auth", () => ({
  useAuth: () => ({ token: "token", user: { id: "user-1" } }),
}));

vi.mock("../src/renderer/src/lib/useClientConfig", () => ({
  useClientConfig: () => ({
    enableCodecSelection: false,
    transcodeOutputs: [],
    trailerSource: { provider: "youtube", validated: true, invidiousUrl: "" },
  }),
}));

const addMediaFromCatalog = vi.fn();
vi.mock("../src/renderer/src/lib/libraryContext", () => ({
  useLibraryData: () => ({ media: [] }),
  useLibraryActions: () => ({
    getMediaDetails: () => null,
    getSharedSetting: () => null,
    addMediaFromCatalog,
    addSubtitleTrackWithObject: vi.fn(),
  }),
}));

vi.mock("../src/renderer/src/components/MediaImage", () => ({
  default: ({ alt }: { alt?: string }) => <img alt={alt ?? ""} />,
}));

/** Every drop is identified (one the catalog movie per title) so "Add" can become clickable. */
vi.mock("../src/renderer/src/lib/metadata", () => ({
  getTitleDetails: vi.fn(),
  getTitleDetailsForLibrary: vi.fn(),
  getTitleTrailersForLanguages: vi.fn().mockResolvedValue([]),
  localizeSearchResultForLibrary: vi.fn(async (_token: unknown, result: unknown) => result),
  searchTitles: vi.fn(async (_token: unknown, type: string, query: string) => ({
    results: [{ type, id: 1000 + query.length * 7 + query.charCodeAt(0), title: query, originalTitle: query, overview: "", year: 2020 }],
  })),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("../src/renderer/src/components/LoadingModalProvider", () => ({
  useLoadingModal: () => ({
    showLoading: vi.fn().mockReturnValue("loading-token"),
    hideLoading: vi.fn(),
  }),
}));

/** ffprobe-shaped summary, as preload's probeMedia returns it. */
const probeFor = (codec: string) => ({
  video: { codec, width: 1920, height: 1080 },
  audio: { count: 1, languages: ["en"] },
  subtitles: { count: 0, languages: [] },
  chapters: { count: 0 },
  durationSeconds: 60,
  audioTracks: [{ index: 1, language: "en", label: "English", codec: "aac", channels: 2 }],
  subtitleTracks: [],
});

/** File path → codec ffprobe reports. */
const CODECS: Record<string, string> = {
  "/movies/Dune Part Two (2024).mkv": "hevc",
  "/movies/Arrival (2016).mkv": "hevc",
};

const LOCALES = ["en", "fr", "nl", "de", "es"] as const;
const localePath = (lang: string) => resolve(__dirname, `../src/renderer/src/i18n/${lang}.json`);

const basename = (path: string) => path.split("/").pop() ?? path;

let probeMedia: Mock<(path: string) => Promise<unknown>>;
let container: HTMLDivElement | null = null;
let root: Root | null = null;

const dump = (label: string) => {
  try {
    console.error(`=== ${P}:${label} ===`);
    console.error(`probeMedia calls=${JSON.stringify(probeMedia?.mock.calls ?? [])}`);
    console.error(`dialog text:\n${container?.textContent ?? "(no container)"}`);
  } catch (err) {
    console.error(`(dump failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const addButton = () =>
  Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((button) =>
    (button.textContent ?? "").includes("ingestion.ui.addToLibrary"),
  ) ?? null;

const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      const { promise, resolve: done } = Promise.withResolvers<void>();
      setTimeout(done, 0);
      await promise;
    });
  }
};

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  probeMedia = vi.fn(async (path: string) => {
    const codec = CODECS[path] ?? "h264";
    console.info(`${P}:probeMedia(${path}) → codec=${codec}`);
    return probeFor(codec);
  });
  Object.assign(window, {
    sf: {
      scanFiles: vi.fn(async (paths: string[]) =>
        paths.map((path) => ({ path, name: basename(path), size: 1_000_000, kind: "video" as const })),
      ),
      probeMedia,
    },
  });
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container?.remove();
  container = null;
  window.localStorage.clear();
});

describe("FileIngestionDialog — HEVC imports without a warning", () => {
  it("@req INGS-HEVC-01 an HEVC drop shows no notice and Add opens up once it is identified", async () => {
    const paths = Object.keys(CODECS);
    console.info(`${P}:drop paths=${JSON.stringify(paths)}`);
    await act(async () => {
      root?.render(<FileIngestionDialog open paths={paths} pathsNonce={1} onOpenChange={vi.fn()} />);
      await Promise.resolve();
    });
    try {
      await vi.waitFor(() => expect(probeMedia).toHaveBeenCalledTimes(paths.length), { timeout: 5_000 });
      await flush();
      await vi.waitFor(() => expect(addButton()?.disabled).toBe(false), { timeout: 5_000 });
    } catch (err) {
      dump("hevc-drop");
      throw err;
    }
    const text = container?.textContent ?? "";
    console.info(`${P}:after probes add=${String(addButton()?.disabled)} mentionsHevc=${/hevc/i.test(text)}`);
    expect(container?.querySelector('[data-testid="hevc-import-notice"]')).toBeNull();
    expect(text).not.toMatch(/hevcNotice/);
    expect(addMediaFromCatalog).not.toHaveBeenCalled();
  });

  it("@req INGS-HEVC-01 no language carries the notice or its Settings switch", () => {
    for (const lang of LOCALES) {
      const strings = JSON.parse(readFileSync(localePath(lang), "utf8")) as {
        ingestion?: Record<string, unknown>;
        settings?: { video?: Record<string, unknown> };
      };
      const leftovers = [
        strings.ingestion?.hevcNotice ? "ingestion.hevcNotice" : null,
        strings.settings?.video?.hevcNotice ? "settings.video.hevcNotice" : null,
      ].filter(Boolean);
      console.info(`${P}:${lang} leftovers=${JSON.stringify(leftovers)}`);
      expect(leftovers).toEqual([]);
    }
  });
});
