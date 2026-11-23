import { configDefaults, defineConfig } from "vitest/config";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";

// `e2e/` and `e2e-update/` hold Playwright specs (`bun run test:e2e`, `playwright.update.config.ts`), which need a built
// app and Playwright's runner; vitest runs the unit tests only.
export default defineConfig({
  // The React Compiler as in the build (electron.vite.config.ts): a value it memoizes too long only shows with it on.
  // The app's code only, as the build compiles it: a test's own components stay as written.
  plugins: [react(), babel({ presets: [reactCompilerPreset()], exclude: [/\/node_modules\//, /\/packages\/shared\//, /\/tests\//] })],
  test: {
    exclude: [...configDefaults.exclude, "e2e/**", "e2e-update/**"],
    setupFiles: ["./tests/webAudio.setup.ts"],
    // A file's first test pays its React Compiler transform: over the 5 s default on a loaded CI runner
    // (stream-slot in run 47476, demo-extras in 47526, then the rest of the file cascades). No test asserts on
    // wall time; same budget as badger desktop.
    testTimeout: 15_000,
  },
});
