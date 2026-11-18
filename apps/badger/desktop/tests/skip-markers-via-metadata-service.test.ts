/**
 * @req META-SKIP-01
 * @req META-DIRECT-03
 *
 * The desktop asks the SpaceBadger metadata service for intro and credits times; it never calls a source itself:
 * `getMetadataSkipMarkers` hands the lookup to the anonymous metadata client with the `tv` body the service expects.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const skipMarkers = vi.hoisted(() => vi.fn());
vi.mock("../src/renderer/src/lib/metadataTickets", () => ({ metadataClient: { skipMarkers } }));

import { getMetadataSkipMarkers } from "../src/renderer/src/api";

describe("skip markers via the metadata service", () => {
  beforeEach(() => {
    skipMarkers.mockReset();
  });

  it("asks the metadata client for an episode, duration included", async () => {
    const envelope = { fetchedAt: "2026-11-06T00:00:00.000Z", markers: [], coverage: [] };
    skipMarkers.mockResolvedValue(envelope);
    const result = await getMetadataSkipMarkers("ignored-token", "tv", 1668, 1, 3, 1320);
    console.log("[skip-markers-via-metadata-service] episode call", { calls: skipMarkers.mock.calls, result });
    expect(skipMarkers).toHaveBeenCalledWith({ type: "tv", id: 1668, season: 1, episode: 3, durationSeconds: 1320 });
    expect(result).toBe(envelope);
  });

  it("leaves an unknown duration out of the request", async () => {
    skipMarkers.mockResolvedValue({ fetchedAt: "x", markers: [], coverage: [] });
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
