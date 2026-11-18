import { describe, expect, it } from "vitest";

import { formatLaunchTimeline, runPrelaunchLoads } from "../src/renderer/src/lib/playbackPrelaunch";

/**
 * #928: the metadata payload (subtitle cache), the HLS prewarm and the backdrop still used to run one after another
 * before mpv spawned (up to 3 + 2 + 1.5 s). They are independent, so they start together and the launch waits for
 * the slowest only.
 */
describe("runPrelaunchLoads", () => {
  it("starts all three loads before any of them answers", async () => {
    const started: string[] = [];
    const metadata = Promise.withResolvers<string>();
    const prewarm = Promise.withResolvers<{ sourceUnreachable: boolean }>();
    const backdrop = Promise.withResolvers<string | null>();
    const result = runPrelaunchLoads({
      metadata: () => (started.push("metadata"), metadata.promise),
      prewarm: () => (started.push("prewarm"), prewarm.promise),
      backdrop: () => (started.push("backdrop"), backdrop.promise),
    });
    expect(started).toEqual(["metadata", "prewarm", "backdrop"]);
    backdrop.resolve("data:image/jpeg;base64,AAAA");
    prewarm.resolve({ sourceUnreachable: false });
    metadata.resolve("payload");
    const settled = await result;
    expect(settled.metadata).toBe("payload");
    expect(settled.prewarm).toEqual({ sourceUnreachable: false });
    expect(settled.backdrop).toBe("data:image/jpeg;base64,AAAA");
  });

  it("waits for the slowest load, not the sum, and times each from the shared start", async () => {
    let clock = 0;
    const now = () => clock;
    const metadata = Promise.withResolvers<string>();
    const prewarm = Promise.withResolvers<null>();
    const backdrop = Promise.withResolvers<null>();
    const result = runPrelaunchLoads({ metadata: () => metadata.promise, prewarm: () => prewarm.promise, backdrop: () => backdrop.promise }, now);
    clock = 300;
    backdrop.resolve(null);
    await Promise.resolve();
    await Promise.resolve();
    clock = 2000;
    prewarm.resolve(null);
    await Promise.resolve();
    await Promise.resolve();
    clock = 2100;
    metadata.resolve("payload");
    const { timings } = await result;
    expect(timings).toEqual({ metadataMs: 2100, prewarmMs: 2000, backdropMs: 300, totalMs: 2100 });
  });

  it("rejects when a load rejects (the caller's launch error path)", async () => {
    await expect(
      runPrelaunchLoads({
        metadata: () => Promise.reject(new Error("metadata broke")),
        prewarm: async () => ({ sourceUnreachable: false }),
        backdrop: async () => null,
      }),
    ).rejects.toThrow("metadata broke");
  });
});

describe("formatLaunchTimeline", () => {
  it("renders stage timings as one string, rounding and marking missing stages", () => {
    expect(formatLaunchTimeline({ launchIpcMs: 812.6, mainStartMs: null, sinceLoadStreamMs: 0 })).toBe(
      "launchIpcMs=813 mainStartMs=- sinceLoadStreamMs=0",
    );
  });
});
