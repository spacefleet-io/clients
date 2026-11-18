import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheMpvBackdrop } from "../src/main/mpvBackdropCache";

vi.mock("../src/main/logger", () => ({
  scopeLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

/**
 * @bugfix @regression-proof mpv-backdrop-black-window (#25 P5/B3)
 *
 * The bundled mpv has no https, so the play-time backdrop is handed to mpv as a
 * local file. The renderer gets the image from the metadata service as a
 * base64 data URI (META-ART-02: never the catalog image CDN); the main process
 * writes it once. Contract: a cached copy is reused; the extension follows the
 * image type (mpv picks the demuxer by it); anything that is not a small image
 * data URI yields null (mpv then opens idle — never a slower start); no
 * network request is made.
 */

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const dataUrl = (body: Buffer, type: string) => `data:${type};base64,${body.toString("base64")}`;

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sf-mpv-backdrop-cache-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const dumpDir = (label: string) => {
  console.error(`=== [mpv-backdrop-cache:${label}] dir=${dir} entries=${JSON.stringify(readdirSync(dir))} ===`);
};

// @req META-ART-02[badger-desktop]
describe("@bugfix @regression-proof cacheMpvBackdrop", () => {
  it("writes the file once, names it by type, reuses it, and never touches the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const uri = dataUrl(JPEG, "image/jpeg");
    const first = await cacheMpvBackdrop(uri, { dir });
    const second = await cacheMpvBackdrop(uri, { dir });
    console.info(`[mpv-backdrop-cache:hit] first=${first} second=${second} fetches=${fetchSpy.mock.calls.length}`);
    if (!first || first !== second) dumpDir("hit");
    expect(first).not.toBeNull();
    expect(path.dirname(first ?? "")).toBe(dir);
    expect(first?.endsWith(".jpg")).toBe(true);
    expect(readFileSync(first ?? "")).toEqual(JPEG);
    expect(second).toBe(first);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readdirSync(dir).filter((name) => name.endsWith(".part"))).toEqual([]);
  });

  it.each([
    ["image/png", ".png"],
    ["image/webp", ".webp"],
  ])("%s → %s", async (type, extension) => {
    const file = await cacheMpvBackdrop(dataUrl(JPEG, type), { dir });
    console.info(`[mpv-backdrop-cache:type] type=${type} file=${file}`);
    expect(file?.endsWith(extension)).toBe(true);
  });

  it("returns null (idle launch) for http(s) URLs, a non-image, a non-base64 URI, an empty or oversized body", async () => {
    const results = await Promise.all([
      cacheMpvBackdrop("https://images.example.test/backdrop/a.jpg", { dir }),
      cacheMpvBackdrop("file:///etc/passwd", { dir }),
      cacheMpvBackdrop(dataUrl(Buffer.from("<html>"), "text/html"), { dir }),
      cacheMpvBackdrop("data:image/png,not-base64", { dir }),
      cacheMpvBackdrop("data:image/png;base64,", { dir }),
      cacheMpvBackdrop(dataUrl(Buffer.alloc(8 * 1024 * 1024 + 1), "image/png"), { dir }),
    ]);
    console.info(`[mpv-backdrop-cache:null] results=${JSON.stringify(results)}`);
    if (results.some((value) => value !== null)) dumpDir("null");
    expect(results).toEqual([null, null, null, null, null, null]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("returns null (idle launch) when the cache dir is unusable instead of failing the play", async () => {
    const blocker = path.join(dir, "not-a-dir");
    writeFileSync(blocker, "x");
    let result: string | null | "threw" = "threw";
    let error: unknown = null;
    try {
      result = await cacheMpvBackdrop(dataUrl(JPEG, "image/jpeg"), { dir: blocker });
    } catch (caught) {
      error = caught;
    }
    console.info(`[mpv-backdrop-cache:baddir] result=${result} error=${error instanceof Error ? error.message : error}`);
    expect(error).toBeNull();
    expect(result).toBeNull();
  });
});
