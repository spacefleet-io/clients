/**
 * "Download everything" (ACCT-EXPORT-01): the runtime's answer to a submit (or main's refusal) becomes an outcome and
 * a toast. The real `exportIpc` runs, so a result that drifts from the contract fails here; only the preload bridge
 * `window.sf.exportFiles` is faked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";

vi.mock("@/logger", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { rendererLogger: { child: () => log, ...log } };
});

import { callExportSubmit } from "../src/renderer/src/lib/exportIpc";
import { exportErrorMessage, exportOutcomeFromResult, exportOutcomeToast } from "../src/renderer/src/lib/exportFlow";

const SUITE = "export-flow";
const t = ((key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key)) as unknown as TFunction;

let bridge: { pickFolder: ReturnType<typeof vi.fn>; submit: ReturnType<typeof vi.fn>; estimate: ReturnType<typeof vi.fn> };

const install = (submitResult: unknown) => {
  bridge = { pickFolder: vi.fn(), submit: vi.fn(async () => submitResult), estimate: vi.fn() };
  (globalThis as unknown as { window: { sf: { exportFiles: typeof bridge } } }).window = { sf: { exportFiles: bridge } };
};

const submitOutcome = async (destDir: string) =>
  exportOutcomeFromResult(t, await callExportSubmit({ destDir, container: "mkv" }), destDir, "en");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("export outcome (Download everything, ACCT-EXPORT-01)", () => {
  it("a submitted library becomes a 'Saving N files' toast naming the folder", async () => {
    install({
      submitted: [
        { mediaId: "m1", fileId: "f1", jobId: "j1" },
        { mediaId: "s1", fileId: "e1", jobId: "j2" },
      ],
      skipped: [{ mediaId: "m2", reason: "no-file" }],
    });
    const outcome = await submitOutcome("/home/me/Videos");
    console.log(`[${SUITE}] phase=submitted submit=${JSON.stringify(bridge.submit.mock.calls)} outcome=${JSON.stringify(outcome)}`);
    expect(bridge.submit).toHaveBeenCalledWith({ destDir: "/home/me/Videos", container: "mkv" });
    expect(outcome).toEqual({ kind: "submitted", count: 2, skipped: 1, destDir: "/home/me/Videos" });
    expect(exportOutcomeToast(t, outcome)).toBe('library.export.submittedToast {"count":2,"folder":"/home/me/Videos"}');
  });

  it("turns the runtime's and main's refusals into user-facing reasons", async () => {
    install({ errorCode: "insufficient_disk_space", requiredBytes: 5_000_000_000, freeBytes: 1_000_000_000 });
    const disk = await submitOutcome("/x");
    console.log(`[${SUITE}] phase=disk outcome=${JSON.stringify(disk)}`);
    expect(disk.kind).toBe("failed");
    expect(exportOutcomeToast(t, disk)).toMatch(/^library\.export\.errors\.insufficient_disk_space \{"required":"[^"]+","free":"[^"]+"\}$/);

    install({ errorCode: "not_authenticated" });
    expect(exportOutcomeToast(t, await submitOutcome("/x"))).toBe("library.export.errors.not_authenticated");

    install({ __runtimeJobsError: true, status: 0, errorCode: "dest_not_picked", message: "nope" });
    expect(exportOutcomeToast(t, await submitOutcome("/x"))).toBe("library.export.errors.dest_not_picked");

    install({ surprise: true });
    const drift = await submitOutcome("/x").then(() => null, (e: unknown) => e as Error);
    console.log(`[${SUITE}] phase=drift err=${String(drift)}`);
    expect(String(drift)).toContain("unexpected shape");
    expect(exportErrorMessage(t, { message: drift?.message }, "en")).toContain("library.export.errors.generic");
  });
});
