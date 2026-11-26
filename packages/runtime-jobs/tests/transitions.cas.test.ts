import { describe, expect, it } from "vitest";
import { resolveTerminalCAS } from "../src/index";

const SUITE = "runtime-jobs-transitions-cas";

type CasInput = {
  current: Parameters<typeof resolveTerminalCAS>[0];
  reported: Parameters<typeof resolveTerminalCAS>[1];
  cancelPending: boolean;
  outputsDurable: boolean;
};

const dumpCasSnapshot = (
  label: string,
  ctx: {
    input: CasInput;
    expected: string;
    observed: string | unknown;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    console.error(`CAS input:\n${JSON.stringify(ctx.input, null, 2)}`);
    console.error(`expected: ${ctx.expected}`);
    console.error(`observed: ${JSON.stringify(ctx.observed)}`);
    const applied = ctx.observed === ctx.expected ? "applied" : "rejected";
    console.error(`resolution: ${applied}`);
    if (ctx.extra) console.error(`extra:\n${JSON.stringify(ctx.extra, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const runCase = (
  label: string,
  input: CasInput,
  expected: string,
) => {
  console.info(
    `[${SUITE}:${label}] current=${input.current} reported=${input.reported} cancelPending=${input.cancelPending} durable=${input.outputsDurable} expected=${expected}`,
  );
  const observed = resolveTerminalCAS(
    input.current,
    input.reported,
    input.cancelPending,
    input.outputsDurable,
  );
  try {
    expect(observed).toBe(expected);
    console.info(`[${SUITE}:${label}] OK observed=${observed}`);
  } catch (err) {
    dumpCasSnapshot(`${label}-failure`, { input, expected, observed });
    throw err;
  }
};

describe("resolveTerminalCAS", () => {
  it("runner wins when no cancel pending and outputs not durable", () => {
    runCase(
      "runner-wins-no-cancel",
      { current: "running", reported: "succeeded", cancelPending: false, outputsDurable: false },
      "succeeded",
    );
  });

  it("runner failure passes through when no cancel pending", () => {
    runCase(
      "runner-failure-passthrough",
      { current: "running", reported: "failed", cancelPending: false, outputsDurable: false },
      "failed",
    );
  });

  it("cancel wins over runner success when outputs are not durable", () => {
    runCase(
      "cancel-over-success-not-durable",
      { current: "running", reported: "succeeded", cancelPending: true, outputsDurable: false },
      "cancelled",
    );
  });

  it("cancel wins over runner failure when not durable", () => {
    runCase(
      "cancel-over-failure-not-durable",
      { current: "running", reported: "failed", cancelPending: true, outputsDurable: false },
      "cancelled",
    );
  });

  it("durable success beats a pending cancel (never throw away committed work)", () => {
    runCase(
      "durable-success-beats-cancel",
      { current: "running", reported: "succeeded", cancelPending: true, outputsDurable: true },
      "succeeded",
    );
  });

  it("explicit cancelled request applies when current is non-terminal", () => {
    runCase(
      "explicit-cancel-non-terminal",
      { current: "running", reported: "cancelled", cancelPending: true, outputsDurable: false },
      "cancelled",
    );
  });

  it("is idempotent: already-succeeded sticks", () => {
    runCase(
      "idempotent-succeeded",
      { current: "succeeded", reported: "cancelled", cancelPending: true, outputsDurable: false },
      "succeeded",
    );
  });

  it("is idempotent: already-cancelled sticks even if runner reports success", () => {
    runCase(
      "idempotent-cancelled",
      { current: "cancelled", reported: "succeeded", cancelPending: false, outputsDurable: true },
      "cancelled",
    );
  });

  it("is idempotent: already-failed sticks", () => {
    runCase(
      "idempotent-failed",
      { current: "failed", reported: "succeeded", cancelPending: false, outputsDurable: false },
      "failed",
    );
  });

  it("from queued, cancel request resolves to cancelled", () => {
    runCase(
      "queued-cancel-resolves",
      { current: "queued", reported: "succeeded", cancelPending: true, outputsDurable: false },
      "cancelled",
    );
  });

  it("from interrupted, cancel still wins absent durable outputs", () => {
    runCase(
      "interrupted-cancel-wins",
      { current: "interrupted", reported: "succeeded", cancelPending: true, outputsDurable: false },
      "cancelled",
    );
  });

  it("from interrupted with durable outputs, success wins", () => {
    runCase(
      "interrupted-durable-success",
      { current: "interrupted", reported: "succeeded", cancelPending: true, outputsDurable: true },
      "succeeded",
    );
  });
});
