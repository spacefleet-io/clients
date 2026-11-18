/**
 * @test-id MOBILE-EMPTY-001
 * @level unit
 * @why When a user's library doesn't exist on the server, the app must reach
 *   the main screen with an empty state — not get stuck loading, not logout,
 *   not crash. This tests the full state combination end-to-end.
 * @regression-proof Bugs #4 + #5 combined: login → no library → main screen.
 */
import { describe, expect, it } from "vitest";
import { resolveNavigatorScreen } from "../src/navigation/resolveScreen";

// Dump-on-failure: print the exact resolver input + computed screen so a
// failing navigation assertion is diagnosable from the CI log alone. Wrapped
// in try/catch so a dump failure can never mask the real assertion error.
const dumpScreenSnapshot = (
  label: string,
  input: Parameters<typeof resolveNavigatorScreen>[0],
  observed: ReturnType<typeof resolveNavigatorScreen>,
) => {
  try {
    console.error(`=== [library-empty-state:${label}] snapshot ===`);
    console.error(`resolver input: ${JSON.stringify(input)}`);
    console.error(`resolveNavigatorScreen => ${JSON.stringify(observed)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("library empty-state behavior", () => {
  it("navigator shows main screen when library doesn't exist", () => {
    console.info(`[library-empty-state:main-screen] resolving with core-ready empty-library state`);
    // After login, if library doesn't exist, the library store should set:
    // (resolver input assembled below)
    // - datasetStatus: { core: true, metadata: true, playback: true }
    // - initializing: false (because coreReady = true in finally block)
    // - needsKey: false (key was checked before meta fetch)
    // - media: []
    // - playlists: []
    const input = {
      authLoading: false,
      user: { id: "u1" },
      contractIssue: null,
      formatTooNew: false,
      needsKey: false,
      errorReportsAnswered: true,
      initializing: false,
      datasetStatus: { core: true },
    };
    const screen = resolveNavigatorScreen(input);

    console.info(`[library-empty-state:main-screen] resolved screen=${screen} (expected "main")`);
    if (screen !== "main") dumpScreenSnapshot("main-screen", input, screen);
    expect(screen).toBe("main");
  });

  it("navigator does NOT show loading-library when datasets are all ready", () => {
    const input = {
      authLoading: false,
      user: { id: "u1" },
      contractIssue: null,
      formatTooNew: false,
      needsKey: false,
      errorReportsAnswered: true,
      initializing: false,
      datasetStatus: { core: true },
    };
    console.info(`[library-empty-state:not-loading] resolving with datasets ready`);
    const screen = resolveNavigatorScreen(input);

    console.info(`[library-empty-state:not-loading] resolved screen=${screen} (must NOT be "loading-library")`);
    if (screen === "loading-library") dumpScreenSnapshot("not-loading", input, screen);
    expect(screen).not.toBe("loading-library");
  });

  it("navigator does NOT show auth when user exists (no phantom logout)", () => {
    const input = {
      authLoading: false,
      user: { id: "u1" },
      contractIssue: null,
      formatTooNew: false,
      needsKey: false,
      errorReportsAnswered: true,
      initializing: false,
      datasetStatus: { core: true },
    };
    console.info(`[library-empty-state:no-phantom-logout] resolving with authenticated user`);
    const screen = resolveNavigatorScreen(input);

    console.info(`[library-empty-state:no-phantom-logout] resolved screen=${screen} (must NOT be "auth")`);
    if (screen === "auth") dumpScreenSnapshot("no-phantom-logout", input, screen);
    expect(screen).not.toBe("auth");
  });

  it("pre-fix state (initializing=true, core=true) would be stuck on loading-library", () => {
    // This reproduces the bug #5 pre-fix behavior
    const input = {
      authLoading: false,
      user: { id: "u1" },
      contractIssue: null,
      formatTooNew: false,
      needsKey: false,
      errorReportsAnswered: true,
      initializing: true,  // ← pre-fix: never cleared because coreReady was false
      datasetStatus: { core: true },
    };
    console.info(`[library-empty-state:prefix-bug5] resolving pre-fix initializing=true state`);
    const screen = resolveNavigatorScreen(input);

    // Before the fix, this would show loading-library forever
    console.info(`[library-empty-state:prefix-bug5] resolved screen=${screen} (expected "loading-library")`);
    if (screen !== "loading-library") dumpScreenSnapshot("prefix-bug5", input, screen);
    expect(screen).toBe("loading-library");
  });

  it("pre-fix state (logout called) would show auth screen", () => {
    // This reproduces bug #4: exists:false → logout → back to login
    const input = {
      authLoading: false,
      user: null,  // ← pre-fix: logout cleared user
      contractIssue: null,
      formatTooNew: false,
      needsKey: false,
      errorReportsAnswered: true,
      initializing: false,
      datasetStatus: { core: false },
    };
    console.info(`[library-empty-state:prefix-bug4] resolving pre-fix logged-out state`);
    const screen = resolveNavigatorScreen(input);

    console.info(`[library-empty-state:prefix-bug4] resolved screen=${screen} (expected "auth")`);
    if (screen !== "auth") dumpScreenSnapshot("prefix-bug4", input, screen);
    expect(screen).toBe("auth");
  });
});
