import type { RuntimeJobLane } from "./models";

export const RUNTIME_JOB_LANES = ["interactive", "background", "cpu", "io", "network"] as const satisfies ReadonlyArray<RuntimeJobLane>;

export const isRuntimeJobLane = (value: unknown): value is RuntimeJobLane =>
  typeof value === "string" && (RUNTIME_JOB_LANES as readonly string[]).includes(value);
