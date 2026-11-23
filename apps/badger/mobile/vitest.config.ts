import { defineConfig } from "vitest/config";
import { readFileSync } from "fs";
import path from "path";

// Workspace packages the app imports from source. Each package.json `exports` map is the one list of entry points
// (Metro and tsc read it too), so the aliases are derived from it: a hand-kept copy fell behind when packages added
// subpaths (`@space/library-db-definition/crewDdl`, `@space/mobile-shell/render-boundary`) and every test importing
// them failed to load. Exact-match regexes, so `@space/x` never swallows `@space/x/y`.
// Names are spelled out in full: tests/metro-workspace-resolution.test.ts checks each Metro workspace dep is listed here.
const SOURCE_PACKAGES = [
  "@space/error-report",
  "@space/shared",
  "@space/library-db-definition",
  "@space/library-db",
  "@space/mobile-shell",
  "@space/mobile-mpv-playback",
  "@space/mobile-media-proxy",
  "@space/mobile-media-volume",
  "@space/metadata-client",
  "@space/privacy-pass",
  "@space/pairing-crypto",
  "@space/media-crypto",
  "@space/media-session",
  "@space/mobile-media-session",
  "@space/playback-abr",
  "@space/stream-slots",
  "@space/legal",
  "@space/profile-avatars",
];

function workspaceExportAliases(): { find: RegExp; replacement: string }[] {
  const aliases: { find: RegExp; replacement: string }[] = [];
  for (const name of SOURCE_PACKAGES) {
    const root = path.resolve(__dirname, "../../../packages", name.replace("@space/", ""));
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      exports: Record<string, string>;
    };
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      const specifier = subpath === "." ? name : `${name}/${subpath.slice(2)}`;
      aliases.push({
        find: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`),
        replacement: path.resolve(root, target),
      });
    }
  }
  return aliases;
}

export default defineConfig({
  // React Native injects `__DEV__` as a build-time global. Vitest doesn't have
  // a Metro-style build step, so define it here so source files that branch on
  // `__DEV__` (mobile-shell's logger, lib/libraryDb.ts) work under the test runner.
  define: {
    __DEV__: "true",
  },
  test: {
    environment: "node",
    globals: true,
    // Several logic tests run real SQLite and the sync engine: under a loaded CI runner the 5 s default cut 7 of them
    // off in one run (34610), and a cut-off test left its artwork cache half-built for the next. Same budget as desktop.
    testTimeout: 15_000,
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    include: ["tests/**/*.test.ts", "src/tv/**/*.test.{ts,tsx}"],
    exclude: ["tests/**/*-perf.test.ts"],
    // Shared react-native / react-native-svg stand-ins, so no file fails to load on an export its own mock forgot.
    setupFiles: ["tests/setup/vitest.setup.ts"],
  },
  resolve: {
    alias: [
      // The error-report package carries its own @sentry/react-native copy (bun peer sets differ); the app has one, so
      // tests that stub the SDK see the same module whichever side imports it.
      { find: "@sentry/react-native", replacement: path.resolve(__dirname, "node_modules/@sentry/react-native") },
      // Shared packages (mobile-shell's libraryEnvelope) import quick-crypto too: one module id, so a test's vi.mock covers it.
      { find: "react-native-quick-crypto", replacement: path.resolve(__dirname, "node_modules/react-native-quick-crypto") },
      // mobile-shell resolves its own react-native copy (bun peer sets differ): one module id, so a test's vi.mock covers it.
      { find: "react-native", replacement: path.resolve(__dirname, "node_modules/react-native") },
      // mobile-shell's pairing hook and QR resolve their own react / react-native-svg copies (bun peer sets differ):
      // one module id each, so hooks share the renderer's React and a test's vi.mock covers the SVG.
      { find: "react", replacement: path.resolve(__dirname, "node_modules/react") },
      { find: "react-native-svg", replacement: path.resolve(__dirname, "node_modules/react-native-svg") },
      ...workspaceExportAliases(),
    ],
  },
});
