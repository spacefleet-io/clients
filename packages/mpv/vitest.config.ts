import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Test files run one at a time. Four of them start a real mpv, three inside `xvfb-run -a` (each picks
    // its own display number, a race when several start together). Run in parallel they failed 2 of 3
    // runs (mpv.sock ECONNREFUSED, "OSC input section never became enabled"); one at a time they pass,
    // and the whole package still takes well under a minute.
    fileParallelism: false,
  },
});
