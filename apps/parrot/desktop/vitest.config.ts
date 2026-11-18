import { configDefaults, defineConfig } from "vitest/config";

// `e2e/` and `e2e-update/` hold Playwright specs (`bun run test:e2e`, `playwright.update.config.ts`), which need a built
// app and Playwright's runner; vitest runs the unit tests only.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "e2e/**", "e2e-update/**"],
    setupFiles: ["./tests/webAudio.setup.ts"],
  },
});
