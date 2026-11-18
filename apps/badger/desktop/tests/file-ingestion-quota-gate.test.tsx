// @vitest-environment jsdom
/**
 * Spec INGS-QUOTA-01, INGS-QUOTA-02 in the real import window: "Add to library" checks the
 * import against the account's space BEFORE anything is created or submitted. Drives the
 * real FileIngestionDialog drop path (scanFiles → probeMedia → TMDB match) and watches
 * whether the add went ahead through `getTmdbDetailsForLibrary`, its first step.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { AccountStorageSummary } from "@space/shared/api";
import FileIngestionDialog from "../src/renderer/src/components/FileIngestionDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const P = "[file-ingestion-quota-gate]";
const GIB = 1024 ** 3;

vi.mock("@space/ui", async (importOriginal) => ({
  // The real exports the dialog grew since (ImportReviewPicker); the stubs below stay in charge of what they replace.
  ...(await importOriginal<Record<string, unknown>>()),
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => {
    const { variant: _variant, size: _size, ...rest } = props;
    return <button {...rest}>{children}</button>;
  },
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

const setUser = vi.fn();
vi.mock("../src/renderer/src/auth", () => ({
  useAuth: () => ({ token: "token", user: { id: "user-1" }, setUser }),
}));

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
    getSharedSetting: () => null,
    addMediaFromTmdb: vi.fn(),
    addSubtitleTrackWithObject: vi.fn(),
  }),
}));

vi.mock("../src/renderer/src/components/MediaImage", () => ({
  default: ({ alt }: { alt?: string }) => <img alt={alt ?? ""} />,
}));

/**
 * The quota window is a React.lazy chunk: Add sets the gate at once (Add greys out, nothing is
 * added) but the window itself only shows once that chunk has loaded, which on a loaded machine
 * takes longer than a few event-loop turns. Its first load is held back here so every run sees
 * that order, and the tests below wait for the window itself (`waitForQuotaWindow`).
 */
vi.mock("../src/renderer/src/components/FileIngestionQuotaDialog", async (importOriginal) => {
  console.info("[file-ingestion-quota-gate]:quota window chunk load held back 50ms");
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 50);
  await promise;
  return importOriginal();
});

/** The first step of an add that went ahead. Rejecting stops it right there, harmlessly. */
const getTmdbDetailsForLibrary = vi.fn();
vi.mock("../src/renderer/src/lib/metadata", () => ({
  getTmdbDetails: vi.fn(),
  getTmdbDetailsForLibrary: (...args: unknown[]) => getTmdbDetailsForLibrary(...args),
  getTmdbTrailersForLanguages: vi.fn().mockResolvedValue([]),
  localizeSearchResultForLibrary: vi.fn(async (_token: unknown, result: unknown) => result),
  searchTmdb: vi.fn(async (_token: unknown, type: string, query: string) => ({
    results: [{ type, id: 1000 + query.length * 7 + query.charCodeAt(0), title: query, originalTitle: query, overview: "", year: 2020 }],
  })),
}));

const getAccountStorage = vi.fn();
const updateSubscription = vi.fn();
const getMe = vi.fn();
const getBillingStatus = vi.fn();
vi.mock("../src/renderer/src/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAccountStorage: (...args: unknown[]) => getAccountStorage(...args),
  updateSubscription: (...args: unknown[]) => updateSubscription(...args),
  getMe: (...args: unknown[]) => getMe(...args),
  getBillingStatus: (...args: unknown[]) => getBillingStatus(...args),
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

const probe = {
  video: { codec: "h264", width: 1920, height: 1080 },
  audio: { count: 1, languages: ["en"] },
  subtitles: { count: 0, languages: [] },
  chapters: { count: 0 },
  durationSeconds: 60,
  audioTracks: [{ index: 1, language: "en", label: "English", codec: "aac", channels: 2 }],
  subtitleTracks: [],
};

const LANTERN = "/videos/Lantern Harbor (2019).mkv";
const ORCHARD = "/videos/Quiet Orchard (2018).mkv";

const storage = (plan: string, limitGb: number, usedGb: number): AccountStorageSummary => ({
  plan,
  storageAddonCount: 0,
  limitBytes: limitGb * GIB,
  usedBytes: usedGb * GIB,
  reservedBytes: 0,
  usageRatio: usedGb / limitGb,
  warningLevel: usedGb >= limitGb ? "blocked" : "ok",
  apps: [],
  lastReconciledAt: null,
});

let probeMedia: Mock<(path: string) => Promise<unknown>>;
let fileSize = GIB;
let container: HTMLDivElement | null = null;
let root: Root | null = null;

const byTestId = <T extends HTMLElement = HTMLElement>(id: string) =>
  container?.querySelector<T>(`[data-testid="${id}"]`) ?? null;
const quotaDialog = () => byTestId("import-quota-dialog");
const addButton = () =>
  Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((button) =>
    (button.textContent ?? "").includes("ingestion.ui.addToLibrary"),
  ) ?? null;

const dump = (label: string) => {
  try {
    console.error(`=== ${P}:${label} ===`);
    console.error(`getAccountStorage calls=${JSON.stringify(getAccountStorage.mock.calls)}`);
    console.error(`updateSubscription calls=${JSON.stringify(updateSubscription.mock.calls)}`);
    console.error(`getTmdbDetailsForLibrary calls=${JSON.stringify(getTmdbDetailsForLibrary.mock.calls.map((call) => call.slice(1)))}`);
    console.error(`add button=${addButton() ? (addButton()!.disabled ? "disabled" : "enabled") : "missing"}`);
    console.error(`quota dialog mode=${quotaDialog()?.getAttribute("data-mode") ?? "(none)"}`);
    console.error(`dialog text:\n${container?.textContent ?? "(no container)"}`);
  } catch (err) {
    console.error(`(dump failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 0);
      await promise;
    });
  }
};

const click = async (el: HTMLElement | null, label: string) => {
  if (!el) {
    dump(`missing-${label}`);
    throw new Error(`${P}: nothing to click for ${label}`);
  }
  console.info(`${P}:click ${label}`);
  await act(async () => {
    el.click();
  });
  await flush();
};

/** Waits for the quota window to be on screen (its lazy chunk loaded), dumping state if it never comes. */
const waitForQuotaWindow = async (label: string) => {
  try {
    await vi.waitFor(
      async () => {
        await flush(1);
        expect(quotaDialog()).not.toBeNull();
      },
      { timeout: 5_000 },
    );
  } catch (err) {
    dump(`no-window-${label}`);
    throw err;
  }
  console.info(`${P}:window ${label} mode=${quotaDialog()?.getAttribute("data-mode")}`);
};

/** Drops `paths`, waits for them to be probed and matched, and returns once Add is clickable. */
const dropAndWaitForAdd = async (paths: string[]) => {
  console.info(`${P}:drop paths=${JSON.stringify(paths)} size=${fileSize}`);
  await act(async () => {
    root?.render(<FileIngestionDialog open paths={paths} pathsNonce={1} onOpenChange={vi.fn()} />);
  });
  try {
    await vi.waitFor(() => expect(probeMedia).toHaveBeenCalledTimes(paths.length), { timeout: 5_000 });
    await flush();
    await vi.waitFor(() => expect(addButton()?.disabled).toBe(false), { timeout: 5_000 });
    await vi.waitFor(() => expect(getAccountStorage).toHaveBeenCalled(), { timeout: 5_000 });
    await flush();
  } catch (err) {
    dump("drop");
    throw err;
  }
  console.info(`${P}:ready add=enabled`);
};

/** TMDB ids of the movies whose add went ahead (getTmdbDetailsForLibrary's 3rd argument). */
const addedIds = () => getTmdbDetailsForLibrary.mock.calls.map((call) => call[2]);
/** The id the mocked TMDB search gives a title. */
const tmdbIdOf = (title: string) => 1000 + title.length * 7 + title.charCodeAt(0);

beforeEach(() => {
  window.localStorage.clear();
  fileSize = GIB;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  getAccountStorage.mockReset();
  updateSubscription.mockReset();
  getMe.mockReset().mockResolvedValue({ user: { id: "user-1", access: null }, access: null });
  getBillingStatus
    .mockReset()
    .mockResolvedValue({ provider: "standin", checkoutAllowed: false, checkoutBlockedReason: "billing_provider_standin", subscription: null });
  setUser.mockReset();
  getTmdbDetailsForLibrary.mockReset();
  getTmdbDetailsForLibrary.mockRejectedValue(new Error("stop-after-gate"));
  probeMedia = vi.fn(async (path: string) => {
    console.info(`${P}:probeMedia(${path})`);
    return probe;
  });
  Object.assign(window, {
    sf: {
      scanFiles: vi.fn(async (paths: string[]) =>
        paths.map((path) => ({ path, name: path.split("/").pop() ?? path, size: fileSize, kind: "video" as const })),
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

describe("FileIngestionDialog — storage check on Add", () => {
  it("@req INGS-QUOTA-01 an import that fits goes straight ahead, no window", async () => {
    getAccountStorage.mockResolvedValue(storage("tier1", 100, 10));
    fileSize = 2 * GIB;
    await dropAndWaitForAdd([LANTERN]);
    await click(addButton(), "add");
    if (quotaDialog() || getTmdbDetailsForLibrary.mock.calls.length !== 1) dump("fits");
    expect(quotaDialog()).toBeNull();
    expect(getTmdbDetailsForLibrary).toHaveBeenCalledTimes(1);
  });

  it("@req INGS-QUOTA-01 one movie too big: the window opens instead of the import, and Cancel adds nothing", async () => {
    getAccountStorage.mockResolvedValue(storage("free", 20, 15));
    fileSize = 8 * GIB;
    await dropAndWaitForAdd([LANTERN]);
    await click(addButton(), "add");
    // The gate holds from the click itself: nothing added, Add greyed out, before the window has even loaded.
    if (getTmdbDetailsForLibrary.mock.calls.length > 0 || !addButton()?.disabled) dump("single-click");
    expect(getTmdbDetailsForLibrary).not.toHaveBeenCalled();
    expect(addButton()?.disabled).toBe(true);
    await waitForQuotaWindow("single");
    try {
      expect(quotaDialog()?.getAttribute("data-mode")).toBe("single");
      expect(getTmdbDetailsForLibrary).not.toHaveBeenCalled();
      expect(addButton()?.disabled).toBe(true);
    } catch (err) {
      dump("single-gate");
      throw err;
    }
    await click(byTestId("import-quota-cancel"), "cancel");
    if (quotaDialog() || getTmdbDetailsForLibrary.mock.calls.length > 0) dump("single-cancel");
    expect(quotaDialog()).toBeNull();
    expect(getTmdbDetailsForLibrary).not.toHaveBeenCalled();
    expect(addButton()?.disabled).toBe(false);
  });

  it("@req INGS-QUOTA-01 a full account is offered the upgrade, not a dead Add button", async () => {
    getAccountStorage.mockResolvedValue(storage("free", 20, 20));
    await dropAndWaitForAdd([LANTERN]);
    expect(addButton()?.disabled).toBe(false);
    await click(addButton(), "add");
    await waitForQuotaWindow("blocked");
    if (!quotaDialog()) dump("blocked");
    expect(quotaDialog()).not.toBeNull();
    expect(byTestId("import-quota-upgrade")).not.toBeNull();
  });

  it("@req INGS-QUOTA-01 several movies: only the ticked ones are imported", async () => {
    getAccountStorage.mockResolvedValue(storage("free", 20, 10));
    fileSize = 8 * GIB;
    await dropAndWaitForAdd([LANTERN, ORCHARD]);
    await click(addButton(), "add");
    await waitForQuotaWindow("batch");
    const items = Array.from(container?.querySelectorAll<HTMLInputElement>('[data-testid="import-quota-item"]') ?? []);
    console.info(`${P}:batch items=${JSON.stringify(items.map((item) => item.getAttribute("data-item-id")))} text=${quotaDialog()?.textContent}`);
    try {
      expect(quotaDialog()?.getAttribute("data-mode")).toBe("batch");
      expect(items).toHaveLength(2);
    } catch (err) {
      dump("batch-gate");
      throw err;
    }
    // Tick the SECOND movie: an add that ignored the selection would start with Lantern Harbor
    // (the harness stops every add at its first metadata call, so only the first one shows).
    const orchardRow = items.find((item) => (item.parentElement?.textContent ?? "").includes("Quiet Orchard"));
    await click(orchardRow ?? null, "tick Quiet Orchard");
    await click(byTestId("import-quota-import-selected"), "import selected");
    await flush();
    console.info(`${P}:batch added=${JSON.stringify(addedIds())}`);
    if (getTmdbDetailsForLibrary.mock.calls.length !== 1) dump("batch-after");
    expect(quotaDialog()).toBeNull();
    expect(addedIds()).toEqual([tmdbIdOf("Quiet Orchard")]);
  });

  it("@req INGS-QUOTA-01 upgrading from the window carries the whole import on by itself", async () => {
    getAccountStorage.mockResolvedValueOnce(storage("free", 20, 10)).mockResolvedValue(storage("tier1", 100, 10));
    updateSubscription.mockResolvedValue({ user: { id: "user-1", access: null }, access: null, outcome: "applied" });
    fileSize = 8 * GIB;
    await dropAndWaitForAdd([LANTERN, ORCHARD]);
    await click(addButton(), "add");
    await waitForQuotaWindow("upgrade");
    await click(byTestId("import-quota-upgrade"), "upgrade");
    await vi.waitFor(() => expect(getTmdbDetailsForLibrary).toHaveBeenCalled(), { timeout: 5_000 }).catch((err) => {
      dump("upgrade");
      throw err;
    });
    console.info(`${P}:upgrade added=${JSON.stringify(addedIds())}`);
    expect(updateSubscription).toHaveBeenCalledWith("token", "tier1", { billingPeriod: "annual", addonCount: 0 });
    // No window again: the fresh storage figures were taken, and the add runs over both movies from the first one
    // (each stops at its rejected metadata call, which no longer ends the whole import).
    expect(quotaDialog()).toBeNull();
    await vi.waitFor(() => expect(addedIds()).toEqual([tmdbIdOf("Lantern Harbor"), tmdbIdOf("Quiet Orchard")]));
  });

  it("@req INGS-QUOTA-02 fits but leaves the account over 90% full: carry on with the current plan", async () => {
    getAccountStorage.mockResolvedValue(storage("tier1", 100, 85));
    fileSize = 8 * GIB;
    await dropAndWaitForAdd([LANTERN]);
    await click(addButton(), "add");
    if (getTmdbDetailsForLibrary.mock.calls.length > 0 || !addButton()?.disabled) dump("high-usage-click");
    expect(getTmdbDetailsForLibrary).not.toHaveBeenCalled();
    expect(addButton()?.disabled).toBe(true);
    await waitForQuotaWindow("high-usage");
    try {
      expect(quotaDialog()?.getAttribute("data-mode")).toBe("high-usage");
      expect(getTmdbDetailsForLibrary).not.toHaveBeenCalled();
    } catch (err) {
      dump("high-usage-gate");
      throw err;
    }
    await click(byTestId("import-quota-continue"), "continue on current plan");
    if (getTmdbDetailsForLibrary.mock.calls.length !== 1) dump("high-usage-continue");
    expect(quotaDialog()).toBeNull();
    expect(getTmdbDetailsForLibrary).toHaveBeenCalledTimes(1);
    expect(updateSubscription).not.toHaveBeenCalled();
  });
});
