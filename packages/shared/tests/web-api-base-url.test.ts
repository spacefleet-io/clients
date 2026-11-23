/**
 * @test-id SHARED-WEB-API-BASE-URL-001
 * @level unit
 * @bugfix #3350 S54: the `VITE_API_BASE_URL` fallback was copied ~24 times and the copies disagreed on an empty value
 *   (`||` vs `??`): with an empty Docker build arg Badger web called `/api` while Parrot web and the site called the
 *   page's own origin. One helper now decides for every browser build.
 * @covers packages/shared/src/productionApi.ts
 */
import { describe, expect, it } from "vitest";
import { webApiBaseUrl } from "../src/productionApi";

describe("webApiBaseUrl", () => {
  it("uses the build's API host when one is set", () => {
    expect(webApiBaseUrl("https://api.spacefleet.io")).toBe("https://api.spacefleet.io");
  });

  it("falls back to same-origin /api when unset, empty or blank", () => {
    for (const configured of [undefined, "", "   "]) expect(webApiBaseUrl(configured)).toBe("/api");
  });
});
