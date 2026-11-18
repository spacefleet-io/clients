import { describe, expect, it } from "vitest";

import { deriveOnboardingRemoteDecision } from "../src/renderer/src/lib/onboardingKeyDecision";

type OnboardingInput = Parameters<typeof deriveOnboardingRemoteDecision>[0];
type OnboardingDecision = ReturnType<typeof deriveOnboardingRemoteDecision>;

// On a decision mismatch, dump the full input flags + actual vs expected so the
// branch that diverged is obvious (this resolver is a known @bugfix hotspot).
const dumpOnboardingSnapshot = (
  label: string,
  input: OnboardingInput,
  actual: OnboardingDecision,
  expected: OnboardingDecision,
) => {
  try {
    console.error(`=== [onboarding-key-state:${label}] snapshot ===`);
    console.error(`input=${JSON.stringify(input)}`);
    console.error(`actual=${JSON.stringify(actual)}`);
    console.error(`expected=${JSON.stringify(expected)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// Run one decision case, dumping context before the assertion if it diverges.
const assertDecision = (label: string, input: OnboardingInput, expected: OnboardingDecision) => {
  console.info(`[onboarding-key-state:${label}] input=${JSON.stringify(input)}`);
  const actual = deriveOnboardingRemoteDecision(input);
  console.info(`[onboarding-key-state:${label}] decision=${JSON.stringify(actual)}`);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    dumpOnboardingSnapshot(label, input, actual, expected);
  }
  expect(actual).toEqual(expected);
};

describe("onboarding key remote decision", () => {
  it("[@bugfix][@regression-proof] sends bootstrap-required accounts directly into generated-key onboarding", () => {
    assertDecision(
      "bootstrap-required-generate",
      {
        existingKey: false,
        libraryError: false,
        remoteExists: false,
        bootstrapRequired: true,
      },
      {
        mode: "generate",
        promptReason: "missing",
      },
    );
  });

  it("keeps existing-library accounts on the unlock flow", () => {
    assertDecision(
      "existing-library-enter",
      {
        existingKey: false,
        libraryError: false,
        remoteExists: true,
        bootstrapRequired: false,
      },
      {
        mode: "enter",
        promptReason: "remote",
      },
    );
  });

  it("keeps invalid-key states on the unlock flow", () => {
    assertDecision(
      "invalid-key-enter",
      {
        existingKey: false,
        libraryError: true,
        remoteExists: false,
        bootstrapRequired: false,
      },
      {
        mode: "enter",
        promptReason: "invalid",
      },
    );
  });
});
