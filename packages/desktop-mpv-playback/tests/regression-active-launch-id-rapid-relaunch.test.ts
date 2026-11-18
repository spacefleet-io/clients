/**
 * @bugfix @regression-proof
 *
 * Locks the rapid-relaunch invariant. Two-part regression net post-Tier-3:
 *
 * (1) `isCurrentExternalMpvLaunch` is the original guard helper (commit
 *     77309483). Pre-Tier-3, `externalMpv.ts` called it inside every async
 *     IPC callback so stale launches couldn't apply side-effects to a new
 *     session. Tier-3 collapsed the 8 module-globals into
 *     `UnixSocketMpvClient` and replaced the activeLaunchId comparison
 *     with object-identity (`currentClient !== thisClient`). The helper
 *     is now utility-only (no production callers in externalMpv.ts) but
 *     the tests below stay green to lock it for future callers and to
 *     prevent silent semantics drift.
 *
 * (2) The new object-identity invariant lives in
 *     `apps/badger/desktop/src/main/externalMpv.ts` at the
 *     `currentClient !== thisClient` checks around lines 358/365/370/394/404.
 *     That guard is exercised end-to-end by the desktop E2E suite (the
 *     "close dialog, re-open" path forces rapid client recreation) and
 *     by the integration tests; the unit-layer assertion remains the
 *     helper-shape lock below.
 *
 * References: commits 77309483 (helper); efbde17f (Tier-3 object-identity migration).
 */

import { describe, expect, it } from "vitest";
import { isCurrentExternalMpvLaunch } from "../src/index";

// On a guard mismatch, dump the (active, candidate) pair and observed-vs-expected
// so a regression in the strict-equality semantics is diagnosable from the CI
// log alone. Wrapped in try/catch so a dump failure can't mask the assertion.
const dumpLaunchSnapshot = (
  label: string,
  active: number,
  candidate: number,
  observed: boolean,
  expected: boolean,
) => {
  try {
    console.error(`=== [active-launch-id-rapid-relaunch:${label}] guard snapshot ===`);
    console.error(`activeLaunchId=${active} candidateLaunchId=${candidate}`);
    console.error(`isCurrentExternalMpvLaunch observed=${observed} expected=${expected}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// Assert helper: runs the guard, dumps context on mismatch, then defers to the
// original `expect` so the assertion itself is unchanged.
const assertCurrent = (label: string, active: number, candidate: number, expected: boolean) => {
  const observed = isCurrentExternalMpvLaunch(active, candidate);
  console.info(
    `[active-launch-id-rapid-relaunch:check] ${label} active=${active} candidate=${candidate} → ${observed} (expect ${expected})`,
  );
  if (observed !== expected) {
    dumpLaunchSnapshot(label, active, candidate, observed, expected);
  }
  expect(isCurrentExternalMpvLaunch(active, candidate)).toBe(expected);
};

describe("@bugfix @regression-proof isCurrentExternalMpvLaunch rapid-relaunch guard", () => {
  it("@bugfix @regression-proof stale launch id (2,1) is not current", () => {
    assertCurrent("stale-2-1", 2, 1, false);
  });

  it("@bugfix @regression-proof matching launch id (2,2) is current", () => {
    assertCurrent("matching-2-2", 2, 2, true);
  });

  it("@bugfix @regression-proof first launch (1,1) is current", () => {
    assertCurrent("first-1-1", 1, 1, true);
  });

  it("@bugfix @regression-proof far-future stale id (10,1) is not current", () => {
    assertCurrent("far-future-stale-10-1", 10, 1, false);
  });

  it("@bugfix @regression-proof activeLaunchId 0 with candidateLaunchId 0 is current", () => {
    // Zero / initial state: both are 0, same value → current.
    assertCurrent("zero-init-0-0", 0, 0, true);
  });

  it("@bugfix @regression-proof candidate one ahead of active is not current", () => {
    // Guards against forward-skipping (shouldn't happen in practice, but the
    // strict equality check must never treat future ids as current either).
    assertCurrent("forward-skip-5-6", 5, 6, false);
  });
});
