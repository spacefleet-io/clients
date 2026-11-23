import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

// react-hooks 7's preset adds the React Compiler rules as errors. Keep
// rules-of-hooks / exhaustive-deps at the preset level; the compiler rules warn
// until the renderer is migrated to them.
const CLASSIC_HOOK_RULES = new Set(["react-hooks/rules-of-hooks", "react-hooks/exhaustive-deps"]);
const reactHooksRules = Object.fromEntries(
  Object.entries(reactHooks.configs.recommended.rules).map(([rule, level]) => [
    rule,
    CLASSIC_HOOK_RULES.has(rule) ? level : "warn",
  ]),
);

export default defineConfig([
  globalIgnores(["dist/**", "out/**", "node_modules/**", "electron.vite.config.ts", "**/*.d.ts"]),
  {
    files: ["src/main/**/*.{ts,tsx}", "src/preload/**/*.{ts,tsx}", "src/shared/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ["src/renderer/src/**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactRefresh.configs.vite,
    ],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-refresh/only-export-components": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      ...reactHooksRules,
      // Renderer code routes through @space/logger/browser via ./logger.
      // Bare console.* bypasses level gating and production noise control.
      // Exempt logger.ts itself (the one place where console is legitimate
      // before the logger is bootstrapped) via the exception override below.
      "no-console": "error",
    },
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    // logger.ts is exempt — it may call console internally after creation
    // (createBrowserLogger does all actual writes) and serves as the boundary.
    files: ["src/renderer/src/logger.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // Every e2e* suite (e2e, e2e-ultimate, e2e-perf, …) and the TS test
    // tooling in scripts/ is test code too. Without a TS-aware block,
    // `--ext ts,tsx` hands those files to the default JS parser (one parsing
    // error per file).
    files: ["tests/**/*.{ts,tsx}", "e2e*/**/*.{ts,tsx}", "scripts/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  {
    // The desktop Electron e2e suite must use the trace-recording `test` from
    // e2e/_helpers/electronTest.ts: Playwright's `use.trace` never covers
    // `_electron.launch`, so a file importing `test` straight from
    // @playwright/test silently loses its failure traces in CI.
    files: ["e2e/*.e2e.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@playwright/test",
              importNames: ["test", "expect"],
              message: "Import test/expect from ./_helpers/electronTest (records Electron traces for failed tests).",
            },
          ],
        },
      ],
    },
  },
  {
    // These e2e files drive a plain Chromium page (the web player / harness API), never Electron: they need
    // Playwright's own `test`, and there is no Electron trace to lose.
    files: [
      "e2e/harness-abuse-limits.e2e.test.ts",
      "e2e/web-home-library.e2e.test.ts",
      "e2e/web-player-chrome.e2e.test.ts",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  {
    files: [
      "src/main/dummyIngestQueue.ts",
      "src/main/externalMpv.ts",
      "src/main/fileSystem.ts",
      "src/main/labQueueLibraryCommit.ts",
      "src/preload/index.ts",
      "src/renderer/src/lib/config.ts",
      "src/renderer/src/lib/metadata.ts",
      "src/renderer/src/pages/OnboardingKey.tsx",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // ESLint 10 added these to js.configs.recommended. The existing hits
    // (mostly e2e/test code under active work) warn rather than fail lint.
    // max-lines: the repo-wide warning (root eslint.config.mjs, issue #3350 C11);
    // an oversized file is split when a change touches it.
    rules: {
      "no-useless-assignment": "warn",
      "preserve-caught-error": "warn",
      "max-lines": ["warn", { max: 1000, skipBlankLines: true, skipComments: true }],
    },
  },
]);
