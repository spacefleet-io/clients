/**
 * @test-id MOBILE-NAV-001
 * @level unit
 * @why The navigator's screen selection logic is the single gate controlling
 *   what the user sees. Bugs here cause stuck loading screens, login loops,
 *   and invisible crashes. This tests every state combination as a pure function.
 * @regression-proof Bug #5: "loading library" hung forever because initializing
 *   stayed true when library didn't exist.
 */
import { describe, expect, it } from "vitest";
import { resolveNavigatorScreen } from "../src/navigation/resolveScreen";

const base = {
  authLoading: false,
  user: { id: "u1" },
  contractIssue: null,
  formatTooNew: false,
  needsKey: false,
  errorReportsAnswered: true,
  initializing: false,
  datasetStatus: { core: true },
};

// On mismatch, dump the full input the resolver saw + the screen it returned vs
// expected, so a priority-ladder regression is obvious without a debugger.
const dumpNavSnapshot = (
  label: string,
  input: Parameters<typeof resolveNavigatorScreen>[0],
  expected: string,
  actual: string,
) => {
  try {
    console.error(`=== [navigator-transitions:${label}] snapshot ===`);
    console.error(`input:\n${JSON.stringify(input, null, 2)}`);
    console.error(`expected screen=${expected} actual screen=${actual}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// Resolve + assert with a dump on mismatch. Keeps every case's diagnostics
// uniform without changing any expected value.
const expectScreen = (
  label: string,
  input: Parameters<typeof resolveNavigatorScreen>[0],
  expected: string,
) => {
  const actual = resolveNavigatorScreen(input);
  console.info(`[navigator-transitions:${label}] resolved screen=${actual} (expected=${expected})`);
  if (actual !== expected) dumpNavSnapshot(label, input, expected, actual);
  expect(actual).toBe(expected);
};

describe("resolveNavigatorScreen", () => {
  it("shows loading when auth is loading", () => {
    expectScreen("loading-when-auth-loading", { ...base, authLoading: true }, "loading");
  });

  it("shows auth when no user", () => {
    expectScreen("auth-when-no-user", { ...base, user: null }, "auth");
  });

  it("shows contract-error when contract issue exists", () => {
    expectScreen("contract-error-when-issue", { ...base, contractIssue: "app_disabled" }, "contract-error");
  });

  it("shows onboarding when key needed", () => {
    expectScreen("onboarding-when-needs-key", { ...base, needsKey: true }, "onboarding");
  });

  it("shows loading-library when initializing", () => {
    expectScreen("loading-library-when-initializing", { ...base, initializing: true }, "loading-library");
  });

  it("shows loading-library when dataset core not ready", () => {
    expectScreen("loading-library-when-core-not-ready", { ...base, datasetStatus: { core: false } }, "loading-library");
  });

  it("shows main when user authenticated and library ready", () => {
    expectScreen("main-when-authed-and-ready", base, "main");
  });

  // Priority order: auth trumps contract, contract trumps key, etc.
  it("auth loading takes priority over everything", () => {
    expectScreen(
      "auth-loading-priority",
      {
        ...base,
        authLoading: true,
        contractIssue: "blocked",
        needsKey: true,
      },
      "loading",
    );
  });

  it("no user takes priority over contract issue", () => {
    expectScreen(
      "no-user-over-contract",
      {
        ...base,
        user: null,
        contractIssue: "blocked",
      },
      "auth",
    );
  });

  it("contract issue takes priority over needsKey", () => {
    expectScreen(
      "contract-over-needs-key",
      {
        ...base,
        contractIssue: "blocked",
        needsKey: true,
      },
      "contract-error",
    );
  });

  it("needsKey takes priority over loading-library", () => {
    expectScreen(
      "needs-key-over-loading-library",
      {
        ...base,
        needsKey: true,
        initializing: true,
        datasetStatus: { core: false },
      },
      "onboarding",
    );
  });

  // Regression: library doesn't exist → should reach main
  it("shows main when library doesn't exist but datasets marked ready", () => {
    expectScreen(
      "main-when-no-library-but-ready",
      {
        ...base,
        initializing: false,
        datasetStatus: { core: true },
      },
      "main",
    );
  });

  // Regression: initializing true + core true → still stuck
  it("shows loading-library when initializing is true even if core is ready", () => {
    expectScreen(
      "loading-library-initializing-over-core-ready",
      {
        ...base,
        initializing: true,
        datasetStatus: { core: true },
      },
      "loading-library",
    );
  });

  // Part D3: format-too-new gate
  // @req LIB-FMT-04
  it("shows format-too-new when formatTooNew is true", () => {
    expectScreen("format-too-new-gate", { ...base, formatTooNew: true }, "format-too-new");
  });

  it("formatTooNew outranks needsKey", () => {
    // Library is unreadable by this build — key entry is not meaningful.
    expectScreen("format-too-new-over-needs-key", { ...base, formatTooNew: true, needsKey: true }, "format-too-new");
  });

  it("formatTooNew outranks initializing", () => {
    expectScreen(
      "format-too-new-over-initializing",
      {
        ...base,
        formatTooNew: true,
        initializing: true,
        datasetStatus: { core: false },
      },
      "format-too-new",
    );
  });

  it("contractIssue still outranks formatTooNew", () => {
    // The priority ladder: loading > no-user > contract-error > format-too-new.
    expectScreen(
      "contract-over-format-too-new",
      {
        ...base,
        contractIssue: "app_disabled",
        formatTooNew: true,
      },
      "contract-error",
    );
  });

  it("formatTooNew=false does not affect normal navigation to main", () => {
    expectScreen("format-too-new-false-no-effect", { ...base, formatTooNew: false }, "main");
  });
});

describe("resolveNavigatorScreen: error reports question", () => {
  // @req REL-LOG-06[badger-mobile]
  it("asks the error report question once the key step and library load are done", () => {
    expectScreen("reports-when-unanswered", { ...base, errorReportsAnswered: false }, "onboarding-reports");
  });

  // @req REL-LOG-06[badger-mobile]
  it("does not ask again once answered", () => {
    expectScreen("main-when-answered", { ...base, errorReportsAnswered: true }, "main");
  });

  // @req REL-LOG-06[badger-mobile]
  it("comes after the key step and the library load, never racing them", () => {
    const unanswered = { ...base, errorReportsAnswered: false };
    expectScreen("key-before-reports", { ...unanswered, needsKey: true }, "onboarding");
    expectScreen("loading-before-reports", { ...unanswered, initializing: true }, "loading-library");
    expectScreen("core-before-reports", { ...unanswered, datasetStatus: { core: false } }, "loading-library");
  });

  // @req REL-LOG-06[badger-mobile]
  it("is never shown to a signed-out user or over a blocking gate", () => {
    const unanswered = { ...base, errorReportsAnswered: false };
    expectScreen("auth-before-reports", { ...unanswered, user: null }, "auth");
    expectScreen("contract-before-reports", { ...unanswered, contractIssue: "blocked" }, "contract-error");
    expectScreen("format-before-reports", { ...unanswered, formatTooNew: true }, "format-too-new");
  });
});

describe("resolveNavigatorScreen: Who's watching? (UX-PROF-01)", () => {
  // @req UX-PROF-01[badger-mobile]
  it("asks who is watching before the app opens, while the library keeps loading behind it", () => {
    expectScreen("profiles-when-choose", { ...base, profiles: "choose" }, "profiles");
    expectScreen("profiles-over-library-load", { ...base, profiles: "choose", initializing: true }, "profiles");
    expectScreen("profiles-before-reports", { ...base, profiles: "choose", errorReportsAnswered: false }, "profiles");
  });

  // @req UX-PROF-01[badger-mobile]
  it("waits for the first profile list, and opens the app once a profile is chosen", () => {
    expectScreen("loading-while-profiles-unknown", { ...base, profiles: "loading" }, "loading");
    expectScreen("main-when-profile-ready", { ...base, profiles: "ready" }, "main");
    expectScreen("main-without-profile-gate", { ...base }, "main");
  });

  // @req UX-PROF-01[badger-mobile]
  it("never asks a signed-out user, nor before the key step or over a blocking gate", () => {
    const choosing = { ...base, profiles: "choose" as const };
    expectScreen("auth-before-profiles", { ...choosing, user: null }, "auth");
    expectScreen("contract-before-profiles", { ...choosing, contractIssue: "blocked" }, "contract-error");
    expectScreen("format-before-profiles", { ...choosing, formatTooNew: true }, "format-too-new");
    expectScreen("key-before-profiles", { ...choosing, needsKey: true }, "onboarding");
  });
});
