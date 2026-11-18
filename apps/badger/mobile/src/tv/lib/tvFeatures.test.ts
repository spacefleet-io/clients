import { describe, expect, it } from "vitest";
import { featureAvailability, isFeatureAvailable, isRouteAvailable, ROUTE_FEATURE, TV_HIDDEN_FEATURES, type TvFeature } from "./tvFeatures";

const ALL_FEATURES: readonly TvFeature[] = ["cameraScan", "downloads", "subscription"];

describe("TV feature visibility", () => {
  it("[TV-SHELL-FEAT-001] hides camera scan, downloads and the plan/payment screen on TV", () => {
    console.info("[TV-SHELL-FEAT-001] phase=start hidden=", TV_HIDDEN_FEATURES);
    for (const feature of ALL_FEATURES) {
      console.info("[TV-SHELL-FEAT-001] phase=check feature=", feature);
      expect(isFeatureAvailable(feature, true)).toBe(false);
    }
    console.info("[TV-SHELL-FEAT-001] phase=done");
  });

  it("[TV-SHELL-FEAT-002] keeps every feature on the phone", () => {
    console.info("[TV-SHELL-FEAT-002] phase=start");
    for (const feature of ALL_FEATURES) expect(isFeatureAvailable(feature, false)).toBe(true);
    expect(Object.values(featureAvailability(false)).every(Boolean)).toBe(true);
    expect(Object.values(featureAvailability(true)).some(Boolean)).toBe(false);
    console.info("[TV-SHELL-FEAT-002] phase=done");
  });

  it("[TV-SHELL-FEAT-003] hides the Subscription and Downloads routes on TV only", () => {
    console.info("[TV-SHELL-FEAT-003] phase=start routes=", ROUTE_FEATURE);
    for (const route of Object.keys(ROUTE_FEATURE) as (keyof typeof ROUTE_FEATURE)[]) {
      console.info("[TV-SHELL-FEAT-003] phase=check route=", route);
      expect(isRouteAvailable(route, true)).toBe(false);
      expect(isRouteAvailable(route, false)).toBe(true);
    }
    console.info("[TV-SHELL-FEAT-003] phase=done");
  });
});
