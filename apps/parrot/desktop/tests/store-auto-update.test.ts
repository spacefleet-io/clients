/**
 * @test-id PARROT-DESKTOP-STORE-AUTO-UPDATE-001
 * @level unit (real store over a temp dir; only Electron's `safeStorage` replaced)
 * @req REL-UPD-02
 * @why Parrot's main process keeps the automatic-updates answer in `parrot.json`. It is ON for a new install and for a
 *   file written before the setting existed; a user's OFF must survive a restart.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParrotSetupState } from "../src/shared/ipc";
import { openParrotStore } from "../src/main/store";

vi.mock("electron", () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => false,
    encryptStringAsync: async () => {
      throw new Error("no protected storage in tests");
    },
    decryptStringAsync: async () => {
      throw new Error("no protected storage in tests");
    },
  },
}));

const defaultSetup = (): ParrotSetupState => ({ done: false, step: "language" }) as unknown as ParrotSetupState;

let dir = "";
const lines: string[] = [];
const open = () => openParrotStore({ dir, defaultSetup, log: (line) => lines.push(line) });
const stateFile = () => join(dir, "parrot.json");
const fileText = () => {
  try {
    return readFileSync(stateFile(), "utf8");
  } catch {
    return "(missing)";
  }
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "parrot-auto-update-"));
  lines.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Parrot desktop store — automatic updates", () => {
  it("is ON for a new install", async () => {
    const testId = "store-auto-update:new-install";
    console.info(`[${testId}] phase:open empty dir`);
    const store = await open();
    console.info(`[${testId}] autoUpdate=${store.autoUpdate} file=${fileText()} lines=${JSON.stringify(lines)}`);
    expect(store.autoUpdate).toBe(true);
  });

  it("is ON for a file written before the setting existed", async () => {
    const testId = "store-auto-update:old-file";
    writeFileSync(
      stateFile(),
      JSON.stringify({ version: 1, setup: { done: true, step: "done" }, user: null, keyOwnerId: null }),
    );
    console.info(`[${testId}] phase:open pre-REL-UPD file`);
    const store = await open();
    console.info(`[${testId}] autoUpdate=${store.autoUpdate} file=${fileText()}`);
    expect(store.autoUpdate).toBe(true);
  });

  it("keeps the user's OFF across a restart, and ON again once turned back on", async () => {
    const testId = "store-auto-update:persist";
    const store = await open();
    console.info(`[${testId}] phase:turn off`);
    await store.setAutoUpdate(false);
    console.info(`[${testId}] after off: live=${store.autoUpdate} file=${fileText()}`);
    expect(store.autoUpdate).toBe(false);
    const reopened = await open();
    console.info(`[${testId}] phase:reopen autoUpdate=${reopened.autoUpdate}`);
    expect(reopened.autoUpdate).toBe(false);
    await reopened.setAutoUpdate(true);
    const third = await open();
    console.info(`[${testId}] phase:reopen after on autoUpdate=${third.autoUpdate} file=${fileText()}`);
    expect(third.autoUpdate).toBe(true);
  });
});
