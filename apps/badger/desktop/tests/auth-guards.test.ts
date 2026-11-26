import { describe, expect, it, vi } from "vitest";
import { shouldLogoutAfterAuthProbe } from "../src/renderer/src/lib/authGuards";

// On a logout-decision mismatch, dump the probe call count + actual/expected
// result so an off-by-one in the retry loop is diagnosable from the log.
const dumpAuthGuardSnapshot = (
  label: string,
  ctx: {
    expectedLogout: boolean;
    actualLogout: boolean;
    expectedCalls: number;
    actualCalls: number;
  },
) => {
  try {
    console.error(`=== [auth-guards:${label}] snapshot ===`);
    console.error(`logout actual=${ctx.actualLogout} expected=${ctx.expectedLogout}`);
    console.error(`probe calls actual=${ctx.actualCalls} expected=${ctx.expectedCalls}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("shouldLogoutAfterAuthProbe", () => {
  it("does not logout when probe eventually succeeds", async () => {
    let calls = 0;
    const probe = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("unauthorized_once") as Error & { status?: number };
        error.status = 401;
        throw error;
      }
      return { ok: true };
    });
    console.info(`[auth-guards:eventual-success] attempts=2 delayMs=0 (first 401, then ok)`);
    const result = await shouldLogoutAfterAuthProbe({ probe, attempts: 2, delayMs: 0 });
    console.info(
      `[auth-guards:eventual-success] result=${result} probeCalls=${probe.mock.calls.length}`
    );
    if (result !== false || probe.mock.calls.length !== 2) {
      dumpAuthGuardSnapshot("eventual-success", {
        expectedLogout: false,
        actualLogout: result,
        expectedCalls: 2,
        actualCalls: probe.mock.calls.length,
      });
    }
    expect(result).toBe(false);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("logs out when probe keeps returning unauthorized", async () => {
    const probe = vi.fn(async () => {
      const error = new Error("unauthorized") as Error & { status?: number };
      error.status = 401;
      throw error;
    });
    console.info(`[auth-guards:persistent-401] attempts=2 delayMs=0 (always 401)`);
    const result = await shouldLogoutAfterAuthProbe({ probe, attempts: 2, delayMs: 0 });
    console.info(
      `[auth-guards:persistent-401] result=${result} probeCalls=${probe.mock.calls.length}`
    );
    if (result !== true || probe.mock.calls.length !== 2) {
      dumpAuthGuardSnapshot("persistent-401", {
        expectedLogout: true,
        actualLogout: result,
        expectedCalls: 2,
        actualCalls: probe.mock.calls.length,
      });
    }
    expect(result).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("does not logout on non-auth errors", async () => {
    const probe = vi.fn(async () => {
      const error = new Error("server_error") as Error & { status?: number };
      error.status = 500;
      throw error;
    });
    console.info(`[auth-guards:non-auth-error] attempts=2 delayMs=0 (always 500)`);
    const result = await shouldLogoutAfterAuthProbe({ probe, attempts: 2, delayMs: 0 });
    console.info(
      `[auth-guards:non-auth-error] result=${result} probeCalls=${probe.mock.calls.length}`
    );
    if (result !== false || probe.mock.calls.length !== 1) {
      dumpAuthGuardSnapshot("non-auth-error", {
        expectedLogout: false,
        actualLogout: result,
        expectedCalls: 1,
        actualCalls: probe.mock.calls.length,
      });
    }
    expect(result).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
