/**
 * @req META-SKIP-01
 * @req META-DIRECT-03
 *
 * The desktop asks the SpaceBadger metadata service for intro and credits times; it never calls TheIntroDB itself.
 * Two proofs: no source file names TheIntroDB's host, and `getMetadataSkipMarkers` hands the lookup to the anonymous
 * metadata client with the `tv` body the service expects.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const skipMarkers = vi.hoisted(() => vi.fn());
vi.mock("../src/renderer/src/lib/metadataTickets", () => ({ metadataClient: { skipMarkers } }));

import { getMetadataSkipMarkers } from "../src/renderer/src/api";

const SRC_ROOT = join(__dirname, "..", "src");

const listSourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listSourceFiles(path);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(name) ? [path] : [];
  });

describe("skip markers via the metadata service", () => {
  beforeEach(() => {
    skipMarkers.mockReset();
  });

  it("no desktop source file calls TheIntroDB", () => {
    const files = listSourceFiles(SRC_ROOT);
    const offenders = files
      .filter((file) => /theintrodb\.org/i.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC_ROOT, file));
    console.log("[skip-markers-via-metadata-service] scanned", { files: files.length, offenders });
    expect(files.length).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });

  it("asks the metadata client for an episode, duration included", async () => {
    const envelope = { provider: "theintrodb-v3", fetchedAt: "2026-11-06T00:00:00.000Z", markers: [], coverage: [] };
    skipMarkers.mockResolvedValue(envelope);
    const result = await getMetadataSkipMarkers("ignored-token", "tv", 1668, 1, 3, 1320);
    console.log("[skip-markers-via-metadata-service] episode call", { calls: skipMarkers.mock.calls, result });
    expect(skipMarkers).toHaveBeenCalledWith({ type: "tv", id: 1668, season: 1, episode: 3, durationSeconds: 1320 });
    expect(result).toBe(envelope);
  });

  it("leaves an unknown duration out of the request", async () => {
    skipMarkers.mockResolvedValue({ provider: "theintrodb-v3", fetchedAt: "x", markers: [], coverage: [] });
    await getMetadataSkipMarkers("ignored-token", "tv", 1668, 2, 1, null);
    await getMetadataSkipMarkers("ignored-token", "tv", 1668, 2, 2, Number.NaN);
    console.log("[skip-markers-via-metadata-service] no duration", { calls: skipMarkers.mock.calls });
    expect(skipMarkers.mock.calls).toEqual([
      [{ type: "tv", id: 1668, season: 2, episode: 1 }],
      [{ type: "tv", id: 1668, season: 2, episode: 2 }],
    ]);
  });

  it("answers a movie with no markers without asking anyone", async () => {
    const result = await getMetadataSkipMarkers("ignored-token", "movie", 603, 0, 0, 8160);
    console.log("[skip-markers-via-metadata-service] movie", { calls: skipMarkers.mock.calls.length, result });
    expect(skipMarkers).not.toHaveBeenCalled();
    expect(result).toMatchObject({ markers: [], coverage: [] });
  });
});
