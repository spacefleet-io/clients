// The perf lane (issue #3350 C6): absolute timing budgets (`tests/**/*.perf.test.ts`), which only hold on an unloaded
// machine. One file at a time so the budgets are not measured against each other. CI runs it after the desktop suite
// as a non-gating step; the gating suite checks the same behaviour relative to a baseline measured in the same run.
// Spread, not mergeConfig: mergeConfig concatenates include/exclude, and the base config excludes these files.
import { defineConfig } from "vitest/config";
import base from "./vitest.config";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["tests/**/*.perf.test.ts"],
    exclude: ["node_modules/**"],
    fileParallelism: false,
  },
});
