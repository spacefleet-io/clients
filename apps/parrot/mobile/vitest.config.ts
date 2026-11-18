import { defineConfig } from "vitest/config";
import path from "path";

// Unit tests of the app's pure modules (src/lib), and screens rendered against mocked React Native (tests/*.test.tsx);
// native modules are tried on a device.
export default defineConfig({
  // React Native injects `__DEV__` as a build-time global; vitest has no Metro build step, so source that reads it
  // (src/lib/lookup.ts, mobile-shell's logger) needs it defined here, as in Badger's vitest config.
  define: {
    __DEV__: "true",
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    // import-match-bundle transforms the source with the phone's babel config: over the 5 s default on a loaded
    // CI runner (run 34610). Same budget as desktop.
    testTimeout: 15_000,
  },
  resolve: {
    alias: {
      // The error-report package carries its own @sentry/react-native copy (bun peer sets differ); one module id, so a
      // test's vi.mock covers the SDK whichever side imports it.
      "@sentry/react-native": path.resolve(__dirname, "node_modules/@sentry/react-native"),
      // mobile-shell resolves its own react-native copy (bun peer sets differ): one module id, so a test's vi.mock covers it.
      "react-native": path.resolve(__dirname, "node_modules/react-native"),
    },
  },
});
