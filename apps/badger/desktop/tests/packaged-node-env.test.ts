import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildRuntimeSpawnEnv } from "../src/main/runtimeSpawnEnv";

const indexSource = readFileSync(fileURLToPath(new URL("../src/main/index.ts", import.meta.url)), "utf8");

const loadWith = async (isPackaged: boolean) => {
  vi.resetModules();
  vi.doMock("electron", () => ({ app: { isPackaged } }));
  await import("../src/main/packagedNodeEnv");
};

// @bugfix @regression-proof: the packaged main process had NODE_ENV unset, so the shared logger (packages/logger) ran in
// development mode (env "development", debug level, pretty output) in every shipped build, and so did the runtime child.
describe("packaged desktop main defaults NODE_ENV to production", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
    vi.doUnmock("electron");
  });

  it("sets production in a packaged app when nothing set it", async () => {
    await loadWith(true);
    expect(process.env.NODE_ENV).toBe("production");
  });

  it("keeps an explicit NODE_ENV (the e2e harness launches with test)", async () => {
    process.env.NODE_ENV = "test";
    await loadWith(true);
    expect(process.env.NODE_ENV).toBe("test");
  });

  it("leaves an unpackaged (dev / from-source) app untouched", async () => {
    await loadWith(false);
    expect(process.env.NODE_ENV).toBeUndefined();
  });

  it("is the very first import of the main entry, so the logger module sees it", () => {
    const firstImport = indexSource.split("\n").find((line) => line.startsWith("import "));
    expect(firstImport).toBe('import "./packagedNodeEnv";');
  });
});

describe("dev / source runtime spawn env", () => {
  it("does not gain a NODE_ENV the parent did not have", () => {
    expect("NODE_ENV" in buildRuntimeSpawnEnv({ PATH: "/usr/bin" }, "/u", undefined)).toBe(false);
  });
});
