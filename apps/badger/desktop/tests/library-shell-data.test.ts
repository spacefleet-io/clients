// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { buildLibraryShellValue } from "../src/renderer/src/lib/libraryShellData";

type ShellInput = Parameters<typeof buildLibraryShellValue>[0];
type ShellValue = ReturnType<typeof buildLibraryShellValue>;

// On a shell-value mismatch, dump the raw readiness flags alongside the derived
// value so the readiness->datasetStatus derivation is diagnosable from the log.
const dumpShellSnapshot = (label: string, input: ShellInput, value: ShellValue) => {
  try {
    console.error(`=== [library-shell-data:${label}] snapshot ===`);
    console.error(`input=${JSON.stringify(input)}`);
    console.error(`value=${JSON.stringify(value)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("libraryShellData", () => {
  it("keeps shell state focused on readiness/status fields and media count", () => {
    const input: ShellInput = {
      loading: false,
      coreReady: false,
      metadataReady: true,
      playbackReady: true,
      error: "sync_unavailable",
      formatTooNew: null,
      writeBlockedReason: "maintenance",
      mediaCount: 12,
    };
    console.info(`[library-shell-data:focused-fields] input=${JSON.stringify(input)}`);
    const value = buildLibraryShellValue(input);
    console.info(`[library-shell-data:focused-fields] value=${JSON.stringify(value)}`);

    const expected = {
      loading: true,
      error: "sync_unavailable",
      formatTooNew: null,
      writeBlockedReason: "maintenance",
      datasetStatus: { core: false, metadata: true, playback: true },
      mediaCount: 12,
    };
    if (JSON.stringify(value) !== JSON.stringify(expected)) {
      dumpShellSnapshot("focused-fields", input, value);
    }
    expect(value).toEqual(expected);
  });

  it("rebuilds dataset status from primitive readiness flags", () => {
    const input: ShellInput = {
      loading: false,
      coreReady: true,
      metadataReady: false,
      playbackReady: true,
      error: null,
      formatTooNew: null,
      writeBlockedReason: null,
      mediaCount: 0,
    };
    console.info(`[library-shell-data:dataset-status] input=${JSON.stringify(input)}`);
    const value = buildLibraryShellValue(input);
    console.info(`[library-shell-data:dataset-status] value=${JSON.stringify(value)}`);

    const expectedStatus = {
      core: true,
      metadata: false,
      playback: true,
    };
    if (JSON.stringify(value.datasetStatus) !== JSON.stringify(expectedStatus) || value.loading !== false) {
      dumpShellSnapshot("dataset-status", input, value);
    }
    expect(value.datasetStatus).toEqual(expectedStatus);
    expect(value.loading).toBe(false);
  });
});
