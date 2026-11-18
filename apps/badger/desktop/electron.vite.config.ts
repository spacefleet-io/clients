import { defineConfig } from "electron-vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { resolve } from "node:path";

// Main and preload: electron-vite externalizes electron, the Node built-ins and every
// `dependencies` entry (better-sqlite3, drizzle-orm, electron-updater, loaded from node_modules
// at run time); everything else, the @space/* workspace packages included, is bundled.

// REL-LOG-06: the Bugsink address reports go to is baked in at build time and is never
// committed. A build without it cannot report (the Settings switch still exists).
const bugsinkDsn = JSON.stringify(process.env.SF_BUGSINK_DSN_BADGER_DESKTOP ?? "");

export default defineConfig({
  // electron-vite resolves the main/preload entries by convention (src/main/index.ts, src/preload/index.ts).
  main: {
    resolve: {
      alias: [
        {
          find: /^@space\/runtime-host$/,
          replacement: resolve(__dirname, "../../../packages/runtime-host/src/index.ts"),
        },
      ],
    },
    // The main process reads the dev-build switch too (ACCT-AUTH-09: the server picker; `src/shared/devBuild.ts`).
    // Vite inlines `import.meta.env.DEV` by itself; the test-build flag is passed explicitly so a release package,
    // built with it blank (`scripts/package.mjs`), compiles the picker out of main as well.
    define: {
      __SF_BUGSINK_DSN__: bugsinkDsn,
      "import.meta.env.VITE_SF_DEV_TICKET_KEY": JSON.stringify(process.env.VITE_SF_DEV_TICKET_KEY ?? ""),
    },
    build: {
      // Source maps feed Bugsink (REL-LOG-06). They stay out of the installer: `asarFileExcludes()` in
      // `scripts/packaged-asar-lib.mjs` (spread into `files` in electron-builder.config.mjs) drops `**/*.map`;
      // electron-builder does not do it by default.
      sourcemap: true,
    },
  },
  preload: {
    build: {
      sourcemap: true,
      rolldownOptions: {
        output: {
          format: "cjs",
          entryFileNames: "index.cjs",
        },
      },
    },
  },
  renderer: {
    base: "./",
    plugins: [
      react(),
      babel({
        presets: [reactCompilerPreset()],
        // packages/shared holds no React code. Bun 1.4 links it from source
        // instead of node_modules, so keep it out of the Babel/compiler pass:
        // Babel reprints its object literals multi-line, which pushed
        // AuthenticatedApp past its renderer budget (issue #25).
        exclude: [/\/node_modules\//, /\/packages\/shared\//],
      }),
    ],
    resolve: {
      alias: [
        { find: "@", replacement: resolve(__dirname, "src/renderer/src") },
        {
          find: /^@space\/runtime-client$/,
          replacement: resolve(__dirname, "../../../packages/runtime-client/src/index.ts"),
        },
      ],
    },
    build: {
      // Emits out/renderer/.vite/manifest.json; scripts/check-renderer-budgets
      // resolves budgeted chunks from it exactly (issue #25).
      manifest: true,
      sourcemap: true,
      rolldownOptions: {
        output: {
          // Pin Zod (and the runtime-contracts package that reads from it)
          // into a vendor chunk. Without this, the value-imports of
          // `runtimeJobsEventSchema` / `runtimeJobsSubscribeHandshakeResponseSchema`
          // in `@space/runtime-client/jobsV2` pull the entire Zod runtime
          // (~139 KiB) into AuthenticatedApp via the LabJobsProvider →
          // runtimeJobsStore → jobsV2 import chain, blowing the chunk
          // budget. Splitting it out lets every chunk that needs Zod load
          // it once across the app, and shrinks AuthenticatedApp below
          // its 200 KiB budget.
          manualChunks: (id) => {
            if (id.includes("/node_modules/zod/")) return "vendor-zod";
            if (id.includes("/packages/runtime-contracts/")) {
              return "vendor-runtime-contracts";
            }
            return undefined;
          },
        },
      },
    },
    optimizeDeps: {
      // Exclude workspace packages so Vite resolves them directly from source
      // on every request. Without this, newly added named exports inside
      // @space/* packages (e.g. createAsyncAction added to @space/shared)
      // stay absent from the dep pre-bundle until node_modules/.vite is cleared.
      exclude: [
        "better-sqlite3",
        "drizzle-orm",
        "drizzle-orm/better-sqlite3",
        "drizzle-orm/sqlite-core",
        "@space/shared",
        "@space/playback-abr",
        "@space/ui",
        "@space/desktop-shell",
        "@space/desktop-shell/components",
        "@space/desktop-shell/hooks",
        "@space/desktop-shell/pages",
        "@space/desktop-shell/guards",
        "@space/desktop-shell/platform",
        "@space/desktop-shell/theme",
        "@space/desktop-shell/services/auth",
        "@space/desktop-shell/services/runtime",
        "@space/desktop-shell/services/runtime-status",
        "@space/desktop-shell/services/notifications",
        "@space/desktop-shell/services/notify",
        "@space/runtime-client",
        "@space/runtime-contracts",
        "@space/tool-access/contracts",
        "@space/tool-access/client",
      ],
    },
    server: {
      host: true,
      // SF_DEV_SERVER_URL is the source of truth — the lane wrapper sets it to
      // a lane-unique port; default 3007 covers the no-lane main repo.
      port: (() => {
        const match = process.env.SF_DEV_SERVER_URL?.match(/:(\d+)/);
        return match ? Number(match[1]) : 3007;
      })(),
      strictPort: true,
      open: false,
      proxy: {
        "/api": {
          // Renderer fetches `/api/*` go through this proxy so we can swap the
          // upstream per-lane via SF_API_BASE_URL without rebuilding the bundle.
          target: process.env.SF_API_BASE_URL?.trim() || "http://localhost:3000",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
      },
    },
  },
});
