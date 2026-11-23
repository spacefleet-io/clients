// @vitest-environment jsdom

/**
 * Settings → Downloads → "Download everything" (ACCT-EXPORT-01) and the file-format option folded under "More
 * options". The flow: pick a folder, estimate the whole library (count + total size + free space on that disk), confirm,
 * then submit with the `library` layout. The real `exportIpc` runs (contract schemas check both ways); only the preload
 * bridge `window.sf.exportFiles` is faked.
 */
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "downloads-section-export";

const state = vi.hoisted(() => ({
  config: { offlineExportFormat: "mkv" as "mkv" | "mp4" },
  updateSetting: (() => undefined) as (key: string, value: unknown) => void,
  toasts: [] as string[],
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
    i18n: { language: "en" },
  }),
}));
vi.mock("@/logger", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { rendererLogger: { child: () => log, ...log } };
});
vi.mock("@space/ui", () => ({
  Button: ({ children, pending: _pending, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { pending?: boolean }) => (
    <button {...props}>{children}</button>
  ),
  Select: ({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) => <select {...props}>{children}</select>,
  Dialog: ({ open, children }: { open: boolean; children?: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
  DialogDescription: ({ children }: { children?: React.ReactNode }) => <p data-testid="confirm-body">{children}</p>,
  DialogFooter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) => <label {...props}>{children}</label>,
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  toast: (message: string) => {
    state.toasts.push(message);
  },
}));
vi.mock("@/lib/settings/useClientSettings", () => ({
  useClientSettings: () => ({ config: state.config, updateSetting: state.updateSetting }),
}));

import DownloadsSection from "../src/renderer/src/components/settings/sections/DownloadsSection";

const GiB = 1024 ** 3;

type Bridge = {
  pickFolder: ReturnType<typeof vi.fn>;
  estimate: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
};

let container: HTMLDivElement;
let root: Root;
let bridge: Bridge;

const installBridge = (estimate: unknown, submit: unknown, folder: string | null = "/media/exports") => {
  bridge = {
    pickFolder: vi.fn(async () => folder),
    estimate: vi.fn(async () => estimate),
    submit: vi.fn(async () => submit),
  };
  (window as unknown as { sf: { exportFiles: Bridge } }).sf = { exportFiles: bridge };
};

const flush = async () => {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const click = async (id: string) => {
  const el = byTestId(id);
  if (!el) throw new Error(`[${SUITE}] missing ${id}; dom=${container.innerHTML.slice(0, 600)}`);
  await act(async () => {
    el.click();
  });
  await flush();
};

beforeEach(() => {
  state.toasts = [];
  state.config = { offlineExportFormat: "mkv" };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = async () => {
  await act(async () => {
    root.render(<DownloadsSection />);
  });
  await flush();
};

describe("DownloadsSection — Download everything (ACCT-EXPORT-01)", () => {
  it("picks a folder, shows count + total size, then submits the whole library with the library layout", async () => {
    installBridge(
      { count: 3, totalBytes: 12 * GiB, freeBytesAvailable: 200 * GiB, sufficientSpace: true, skipped: [] },
      { submitted: [1, 2, 3].map((n) => ({ mediaId: `m${n}`, fileId: `f${n}`, jobId: `j${n}` })), skipped: [] },
    );
    await render();
    console.log(`[${SUITE}] phase=rendered more-options=${byTestId("settings-downloads-more-options")?.tagName}`);
    expect(byTestId("settings-downloads-more-options")?.tagName).toBe("DETAILS");
    expect(byTestId("settings-downloads-more-options")?.querySelector('[data-testid="settings-offline-export-format"]')).not.toBeNull();

    await click("settings-export-everything");
    console.log(`[${SUITE}] phase=estimated estimateCalls=${JSON.stringify(bridge.estimate.mock.calls)} toasts=${JSON.stringify(state.toasts)}`);
    expect(bridge.pickFolder).toHaveBeenCalledTimes(1);
    expect(bridge.estimate).toHaveBeenCalledWith({ all: true, destDir: "/media/exports", container: "mkv" });
    const body = byTestId("confirm-body")?.textContent ?? "";
    console.log(`[${SUITE}] phase=confirm body=${body}`);
    expect(body).toContain("settings.exportAll.confirmBody");
    expect(body).toContain('"count":3');
    expect(body).toContain("/media/exports");
    expect(body).toMatch(/"size":"1[23][.,]?\d*\s?G/);
    expect(byTestId("export-everything-disk-warning")).toBeNull();
    expect(bridge.submit).not.toHaveBeenCalled();

    await click("export-everything-confirm-button");
    console.log(`[${SUITE}] phase=submitted submitCalls=${JSON.stringify(bridge.submit.mock.calls)} toasts=${JSON.stringify(state.toasts)}`);
    expect(bridge.submit).toHaveBeenCalledWith({ all: true, destDir: "/media/exports", container: "mkv", layout: "library" });
    expect(state.toasts).toEqual(['library.export.submittedToast {"count":3,"folder":"/media/exports"}']);
    expect(byTestId("export-everything-confirm")).toBeNull();
  });

  it("warns and blocks the confirm when the picked disk is too small", async () => {
    installBridge(
      { count: 2, totalBytes: 50 * GiB, freeBytesAvailable: 10 * GiB, sufficientSpace: false, skipped: [] },
      { errorCode: "insufficient_disk_space", requiredBytes: 50 * GiB, freeBytes: 10 * GiB },
    );
    await render();
    await click("settings-export-everything");
    const warning = byTestId("export-everything-disk-warning")?.textContent ?? "";
    console.log(`[${SUITE}] phase=small-disk warning=${warning}`);
    expect(warning).toContain("library.export.errors.insufficient_disk_space");
    expect((byTestId("export-everything-confirm-button") as HTMLButtonElement).disabled).toBe(true);
    expect(bridge.submit).not.toHaveBeenCalled();
  });

  it("does nothing when the folder dialog is cancelled, and toasts main's refusal", async () => {
    installBridge({ count: 0, totalBytes: 0, freeBytesAvailable: 0, sufficientSpace: true, skipped: [] }, {}, null);
    await render();
    await click("settings-export-everything");
    console.log(`[${SUITE}] phase=cancelled estimateCalls=${bridge.estimate.mock.calls.length} toasts=${JSON.stringify(state.toasts)}`);
    expect(bridge.estimate).not.toHaveBeenCalled();
    expect(state.toasts).toEqual([]);

    installBridge(
      { __runtimeJobsError: true, status: 0, errorCode: "dest_not_picked", message: "The export folder was not picked" },
      {},
    );
    await click("settings-export-everything");
    console.log(`[${SUITE}] phase=refused toasts=${JSON.stringify(state.toasts)}`);
    expect(state.toasts).toEqual(["library.export.errors.dest_not_picked"]);
    expect(byTestId("export-everything-confirm")).toBeNull();
  });

  it("uses the MP4 format when the user chose it under More options", async () => {
    state.config = { offlineExportFormat: "mp4" };
    installBridge(
      { count: 1, totalBytes: GiB, freeBytesAvailable: 100 * GiB, sufficientSpace: true, skipped: [] },
      { submitted: [{ mediaId: "m1", fileId: "f1", jobId: "j1" }], skipped: [] },
    );
    await render();
    await click("settings-export-everything");
    await click("export-everything-confirm-button");
    console.log(`[${SUITE}] phase=mp4 submitCalls=${JSON.stringify(bridge.submit.mock.calls)}`);
    expect(bridge.submit).toHaveBeenCalledWith({ all: true, destDir: "/media/exports", container: "mp4", layout: "library" });
  });
});
