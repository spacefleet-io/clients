/**
 * @req META-SRC-09[badger-desktop]
 *
 * Skip-marker cache rows and markers written by Badger versions released before the neutral format still load:
 * the readers accept the old provider tags, the old show catalog id key and the old marker `source`, while new
 * writes carry only the neutral names.
 */
import { describe, expect, it } from "vitest";
import {
  LEGACY_SHOW_CATALOG_ID_KEY,
  LEGACY_SKIP_MARKER_PROVIDERS,
  LEGACY_SKIP_MARKER_SOURCE_PREFIX,
} from "../src/shared/legacyFormat";
import {
  SERVICE_SKIP_MARKER_SOURCE,
  SKIP_MARKER_PROVIDER,
  createExternalSkipMarkerFetchPayload,
  createShowSkipCachePayload,
  isExternalSkipMarkerFetchPayload,
  isServiceSkipMarkerSource,
  parseShowSkipCachePayload,
} from "../src/shared/skipMarkerCache";

const P = "[skip-marker-legacy-format.test]";
const FETCHED_AT = "2026-10-28T00:00:00.000Z";
const coverage = [{ seasonNumber: 1, episodeNumber: 1, status: "hit" as const, markerTypes: ["intro" as const] }];
const intro = { type: "intro" as const, startSeconds: 0, endSeconds: 46, source: SERVICE_SKIP_MARKER_SOURCE, confidence: null };

describe("skip-marker cache legacy format", () => {
  it("reads an old show cache row into the neutral shape", () => {
    for (const provider of LEGACY_SKIP_MARKER_PROVIDERS) {
      const old = { provider, [LEGACY_SHOW_CATALOG_ID_KEY]: 901, fetchedAt: FETCHED_AT, coverage, markersByEpisode: { "1:1": [intro] } };
      const parsed = parseShowSkipCachePayload(old);
      console.info(P, "old show row", JSON.stringify({ old, parsed }));
      expect(parsed).toEqual({ provider, showCatalogId: 901, fetchedAt: FETCHED_AT, coverage, markersByEpisode: { "1:1": [intro] } });
    }
  });

  it("writes new show cache rows with neutral names only, and reads them back", () => {
    const payload = createShowSkipCachePayload({ showCatalogId: 901, fetchedAt: FETCHED_AT, coverage, markersByEpisode: {} });
    console.info(P, "new show row", JSON.stringify(payload));
    expect(payload.provider).toBe(SKIP_MARKER_PROVIDER);
    expect(Object.keys(payload)).not.toContain(LEGACY_SHOW_CATALOG_ID_KEY);
    expect(parseShowSkipCachePayload(payload)).toEqual(payload);
  });

  it("rejects a show row without a catalog id", () => {
    expect(parseShowSkipCachePayload({ provider: SKIP_MARKER_PROVIDER, fetchedAt: FETCHED_AT, coverage, markersByEpisode: {} })).toBeNull();
  });

  it("accepts old per-episode fetch rows and tags new ones neutrally", () => {
    for (const provider of LEGACY_SKIP_MARKER_PROVIDERS) {
      expect(isExternalSkipMarkerFetchPayload({ provider, status: "miss", fetchedAt: FETCHED_AT })).toBe(true);
    }
    const fresh = createExternalSkipMarkerFetchPayload(coverage[0], FETCHED_AT);
    console.info(P, "new fetch row", JSON.stringify(fresh));
    expect(fresh.provider).toBe(SKIP_MARKER_PROVIDER);
    expect(isExternalSkipMarkerFetchPayload(fresh)).toBe(true);
    expect(isExternalSkipMarkerFetchPayload({ provider: "other", status: "miss", fetchedAt: FETCHED_AT })).toBe(false);
  });

  it("treats old and new service markers alike", () => {
    expect(isServiceSkipMarkerSource(`${LEGACY_SKIP_MARKER_SOURCE_PREFIX}-v3`)).toBe(true);
    expect(isServiceSkipMarkerSource(SERVICE_SKIP_MARKER_SOURCE)).toBe(true);
    expect(isServiceSkipMarkerSource("local:audio-fingerprint")).toBe(false);
  });
});
