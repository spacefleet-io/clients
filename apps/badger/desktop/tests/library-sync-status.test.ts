import { describe, expect, it } from "vitest";
import { shouldShowLibrarySyncBanner } from "../src/renderer/src/lib/librarySyncStatus";

// Decision-matrix dump: on mismatch, print the exact input and the observed
// vs expected output so the failing case is unambiguous in CI. Wrapped in
// try/catch so a dump failure can't mask the assertion.
const dumpLibrarySyncStatusSnapshot = (
  label: string,
  input: Parameters<typeof shouldShowLibrarySyncBanner>[0],
  observed: boolean,
  expected: boolean,
) => {
  try {
    console.error(`=== [library-sync-status:${label}] decision snapshot ===`);
    console.error(`input=${JSON.stringify(input)}`);
    console.error(`observed=${observed} expected=${expected}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// Helper to assert a single matrix row with a dump on mismatch.
const assertBanner = (
  label: string,
  input: Parameters<typeof shouldShowLibrarySyncBanner>[0],
  expected: boolean,
) => {
  const observed = shouldShowLibrarySyncBanner(input);
  if (observed !== expected) {
    dumpLibrarySyncStatusSnapshot(label, input, observed, expected);
  }
  expect(observed).toBe(expected);
};

describe("shouldShowLibrarySyncBanner", () => {
  it("shows banner while loading", () => {
    console.info("[library-sync-status:case] loading=true → banner expected true");
    assertBanner(
      "loading-true",
      {
        loading: true,
        hasError: false,
        datasetStatus: { core: false, metadata: false, playback: false },
      },
      true,
    );
  });

  it("shows banner when core dataset is not ready", () => {
    console.info("[library-sync-status:case] core=false → banner expected true");
    assertBanner(
      "core-not-ready",
      {
        loading: false,
        hasError: false,
        datasetStatus: { core: false, metadata: true, playback: true },
      },
      true,
    );
  });

  it("hides banner when ready or when there is an error", () => {
    console.info("[library-sync-status:case] all-ready → banner expected false");
    assertBanner(
      "all-ready",
      {
        loading: false,
        hasError: false,
        datasetStatus: { core: true, metadata: true, playback: true },
      },
      false,
    );
    console.info("[library-sync-status:case] hasError=true (loading) → banner expected false (error precedence)");
    assertBanner(
      "error-precedence-while-loading",
      {
        loading: true,
        hasError: true,
        datasetStatus: { core: false, metadata: false, playback: false },
      },
      false,
    );
  });

  describe("@bugfix @regression-proof requirePlayback matrix", () => {
    it("with requirePlayback=true, banner shows while playback is not ready even if core is ready", () => {
      console.info("[library-sync-status:require-playback] core ready, playback NOT ready → expected true");
      assertBanner(
        "require-playback-playback-not-ready",
        {
          loading: false,
          hasError: false,
          datasetStatus: { core: true, metadata: true, playback: false },
          requirePlayback: true,
        },
        true,
      );
    });

    it("with requirePlayback=true, banner hides once both core and playback are ready", () => {
      console.info("[library-sync-status:require-playback] core+playback ready → expected false");
      assertBanner(
        "require-playback-all-ready",
        {
          loading: false,
          hasError: false,
          datasetStatus: { core: true, metadata: true, playback: true },
          requirePlayback: true,
        },
        false,
      );
    });

    it("with requirePlayback=true, banner still hides when there is an error (error precedence preserved)", () => {
      console.info("[library-sync-status:require-playback] hasError=true → expected false (error precedence)");
      assertBanner(
        "require-playback-error-precedence",
        {
          loading: false,
          hasError: true,
          datasetStatus: { core: true, metadata: true, playback: false },
          requirePlayback: true,
        },
        false,
      );
    });

    it("with requirePlayback=true, banner still shows while loading regardless of playback state", () => {
      console.info("[library-sync-status:require-playback] loading=true → expected true regardless of playback");
      assertBanner(
        "require-playback-loading",
        {
          loading: true,
          hasError: false,
          datasetStatus: { core: true, metadata: true, playback: true },
          requirePlayback: true,
        },
        true,
      );
    });

    it("with requirePlayback=false (default), banner ignores playback readiness", () => {
      console.info("[library-sync-status:require-playback] default (undefined) playback ignored → expected false");
      assertBanner(
        "require-playback-default-ignored",
        {
          loading: false,
          hasError: false,
          datasetStatus: { core: true, metadata: true, playback: false },
        },
        false,
      );
      console.info("[library-sync-status:require-playback] explicit false → playback ignored → expected false");
      assertBanner(
        "require-playback-explicit-false-ignored",
        {
          loading: false,
          hasError: false,
          datasetStatus: { core: true, metadata: true, playback: false },
          requirePlayback: false,
        },
        false,
      );
    });

    it("with requirePlayback=true, core-not-ready still shows banner regardless of playback", () => {
      console.info("[library-sync-status:require-playback] core NOT ready, playback ready → expected true");
      assertBanner(
        "require-playback-core-not-ready",
        {
          loading: false,
          hasError: false,
          datasetStatus: { core: false, metadata: true, playback: true },
          requirePlayback: true,
        },
        true,
      );
    });
  });
});
