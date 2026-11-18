/**
 * @req MPV-PREV-04[badger-desktop]
 * @bugfix previews-recorded-after-player-opened
 * @regression-proof
 *
 * Chris 2026-11-02: "I re-ingested the pond lighthouse, but didn't get any previews". The import committed the
 * film at 06:02:10, he opened it at 06:02:14 (mpv: `[sf-preview] sheets none`), and the runtime recorded its 28
 * sheets at ~06:05:29 (decoding a 3 h 48 film takes minutes, MPV-PREV-02). The renderer handed the record to the
 * main process only with a metadata send (load, skip-marker change), and the player's media snapshot was frozen at
 * launch, so a player opened before the sheets landed showed none for the whole playback.
 *
 * Pins:
 *  1. the handoff re-sends the playing file's record when it changes mid-playback, and only then;
 *  2. the engine reads the record from the library's latest formats (`libraryFormats`) and re-sends it on change;
 *  3. the playback controller passes the library's latest formats of the playing media to the engine.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MediaPreviewSheets } from "@space/shared/previewSheets";
import { createPreviewSheetsHandoff, type PreviewSheetsHandoffPayload } from "../src/renderer/src/lib/previewSheetsHandoff";

const TAG = "[mpv-preview-sheets-late-record]";

const sheets = (key: string): MediaPreviewSheets => ({
  version: 1,
  intervalSeconds: 5,
  pictureWidth: 160,
  pictureHeight: 66,
  columns: 10,
  rows: 10,
  pictureCount: 2740,
  sheets: [{ objectKey: key, sizeBytes: 67948, firstPicture: 0, pictureCount: 100 }],
});

const MISSING = { formatId: "fmt-src", hint: "Previews are being prepared" };
const payload = (record: MediaPreviewSheets | null): PreviewSheetsHandoffPayload => ({ record, missing: MISSING });
const key = (sent: PreviewSheetsHandoffPayload) => sent.record?.sheets[0]?.objectKey ?? null;

const harness = () => {
  const delivered: PreviewSheetsHandoffPayload[] = [];
  const logs: string[] = [];
  const deliver = vi.fn(async (sent: PreviewSheetsHandoffPayload) => {
    delivered.push(sent);
  });
  const handoff = createPreviewSheetsHandoff({
    deliver,
    log: (line, data) => logs.push(`${line} ${JSON.stringify(data)}`),
  });
  const dump = (label: string) => {
    console.info(`${TAG} ${label} delivered=${JSON.stringify(delivered.map(key))}`);
    for (const line of logs) console.info(`${TAG} ${label} log: ${line}`);
  };
  return { handoff, delivered, deliver, dump };
};

describe("@bugfix @regression-proof preview record recorded after the player opened (MPV-PREV-04)", () => {
  it("@bugfix @regression-proof re-sends when the record lands mid-playback, not when unchanged", () => {
    const { handoff, delivered, dump } = harness();
    console.info(`${TAG} phase=load: metadata send with no record yet (import still decoding)`);
    handoff.send(payload(null));
    expect(handoff.sendIfChanged(payload(null))).toBe(false);
    console.info(`${TAG} phase=recorded: the runtime records the sheets while the film plays`);
    expect(handoff.sendIfChanged(payload(sheets("lotr")))).toBe(true);
    console.info(`${TAG} phase=library-push: an unrelated push hands an equal record in a new object`);
    expect(handoff.sendIfChanged(payload(sheets("lotr")))).toBe(false);
    dump("after");
    expect(delivered.map(key)).toEqual([null, "lotr"]);
    expect(delivered.every((sent) => sent.missing.formatId === "fmt-src")).toBe(true);
  });

  it("@bugfix @regression-proof every metadata send hands the record over, even unchanged (main re-tells the OSC)", () => {
    const { handoff, delivered, dump } = harness();
    handoff.send(payload(sheets("a")));
    handoff.send(payload(sheets("a")));
    expect(handoff.sendIfChanged(payload(sheets("a")))).toBe(false);
    expect(handoff.sendIfChanged(payload(sheets("b")))).toBe(true);
    dump("after");
    expect(delivered.map(key)).toEqual(["a", "a", "b"]);
  });

  it("@bugfix @regression-proof a failed delivery is logged, not thrown, and retried on the next change", async () => {
    const logs: string[] = [];
    const deliver = vi.fn(async () => {
      throw new Error("ipc down");
    });
    const handoff = createPreviewSheetsHandoff({ deliver, log: (line, data) => logs.push(`${line} ${JSON.stringify(data)}`) });
    expect(handoff.sendIfChanged(payload(sheets("x")))).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    for (const line of logs) console.info(`${TAG} failed-delivery log: ${line}`);
    expect(logs.some((line) => line.includes("ipc down"))).toBe(true);
    expect(handoff.sendIfChanged(payload(sheets("x")))).toBe(true);
  });

  const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
  const engine = read("src/renderer/src/lib/useMpvPlaybackEngine.ts");
  const controller = read("src/renderer/src/components/MediaPlaybackController.tsx");
  const show = (label: string, source: string, anchor: string) => {
    const idx = source.indexOf(anchor);
    console.error(`${TAG} ${label} anchor=${JSON.stringify(anchor)} at ${idx}: ${idx >= 0 ? source.slice(Math.max(0, idx - 200), idx + 400) : "NOT FOUND"}`);
  };

  it("@bugfix @regression-proof source: the engine reads the library's latest formats and re-sends on change", () => {
    const checks: Array<[string, RegExp]> = [
      ["record from latest formats", /const latestFormats = libraryFormats \?\? media\.formats;[\s\S]{0,80}?sourcePreviewSheets\(latestFormats, fileId\)/],
      ["one deliver call site", /createPreviewSheetsHandoff\(\{[\s\S]{0,200}?setExternalMpvPreviewSheets/],
      ["metadata send goes through the handoff", /previewSheetsHandoff\.send\(\{ record: previewSheets, missing: missingPreviews \}\)/],
      ["mid-playback re-send", /isExternalActive\(lifecycleRef\.current\)\)\s*return;\s*previewSheetsHandoff\.sendIfChanged\(\{ record: previewSheets, missing: missingPreviews \}\)/],
    ];
    for (const [label, pattern] of checks) {
      if (!pattern.test(engine)) show(label, engine, "previewSheets");
      expect(engine, label).toMatch(pattern);
    }
    const directCalls = engine.match(/setExternalMpvPreviewSheets/g)?.length ?? 0;
    console.info(`${TAG} engine direct setExternalMpvPreviewSheets calls=${directCalls}`);
    expect(directCalls).toBe(1);
  });

  it("@bugfix @regression-proof source: the controller hands the engine the playing media's latest library formats", () => {
    const pattern = /libraryFormats:\s*getMediaDetails\(currentMedia\.id\)\?\.formats/;
    if (!pattern.test(controller)) show("controller", controller, "usePlaybackEngine({");
    expect(controller).toMatch(pattern);
  });
});
