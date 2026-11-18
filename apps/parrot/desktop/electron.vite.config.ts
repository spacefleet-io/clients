import { defineConfig } from "electron-vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { resolve } from "node:path";

// Main and preload: electron-vite externalizes electron, the Node built-ins and every `dependencies` entry. Parrot
// has none, so everything (the @space/* workspace packages, music-metadata, the error-report SDK) is bundled and the
// packaged app ships no node_modules. SQLite is `node:sqlite`, built into Electron's Node: no native module.

// REL-LOG-06: the Bugsink address reports go to is baked in at build time and is never committed. A build without
// it cannot report (the setup question is still asked).
const bugsinkDsn = JSON.stringify(process.env.SF_BUGSINK_DSN_PARROT_DESKTOP ?? "");

export default defineConfig({
  main: {
    // The main process reads the dev-build switch (`src/shared/devBuild.ts`): a release package, built with
    // VITE_SF_DEV_TICKET_KEY blank (`scripts/package.mjs`), always talks to the production API.
    define: {
      __SF_BUGSINK_DSN__: bugsinkDsn,
      "import.meta.env.VITE_SF_DEV_TICKET_KEY": JSON.stringify(process.env.VITE_SF_DEV_TICKET_KEY ?? ""),
    },
    build: {
      sourcemap: true,
    },
    plugins: [
      {
        // The e2e runner reads this marker (`e2e/buildFlavour.ts`) and refuses a release build, which cannot get
        // tickets from a dev stack (META-ANON-07).
        name: "parrot-build-flavour",
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "build-flavour.json",
            source: JSON.stringify({ devTicketKey: process.env.VITE_SF_DEV_TICKET_KEY === "1" }),
          });
        },
      },
    ],
  },
  preload: {
    build: {
      sourcemap: true,
      rolldownOptions: {
        // `lightcopy`: the hidden encoder window's preload (PAR-FMT-02 light copies).
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
          lightcopy: resolve(__dirname, "src/preload/lightcopy.ts"),
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
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
        exclude: [/\/node_modules\//, /\/packages\/shared\//],
      }),
    ],
    resolve: {
      alias: [{ find: "@", replacement: resolve(__dirname, "src/renderer/src") }],
    },
    build: {
      rolldownOptions: {
        // The app's window, and the hidden window that makes light copies (PAR-FMT-02).
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          lightcopy: resolve(__dirname, "src/renderer/lightcopy.html"),
        },
      },
    },
    optimizeDeps: {
      // Workspace packages are resolved from source on every request so the React Compiler sees their components.
      exclude: ["@space/shared", "@space/ui", "@space/desktop-shell", "@space/desktop-shell/components"],
    },
    server: {
      host: "127.0.0.1",
      // scripts/dev.mjs sets SF_DEV_SERVER_URL to a lane-unique port; 3013 without a lane.
      port: Number(process.env.SF_DEV_SERVER_URL?.match(/:(\d+)/)?.[1] ?? 3013),
      strictPort: true,
      open: false,
      fs: {
        allow: [resolve(__dirname, "../../..")],
      },
    },
  },
});
