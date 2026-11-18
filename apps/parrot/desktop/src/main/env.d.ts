/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
  /** `1` in a test build (`bun run build:test`); never set by `scripts/package.mjs`. */
  readonly VITE_SF_DEV_TICKET_KEY?: string;
  /** `on` turns anonymous tickets back on in a dev run (META-ANON-06); a packaged build ignores it. */
  readonly VITE_METADATA_TICKETS?: string;
  /** The metadata service of a dev run (the dev launcher's or the dev stack's target, META-ANON-09); SF_METADATA_URL wins. */
  readonly VITE_METADATA_URL?: string;
}

/**
 * Replaced at build time by electron.vite.config.ts `define` (REL-LOG-06): the Bugsink address from
 * SF_BUGSINK_DSN_PARROT_DESKTOP, or "" when the build has none.
 */
declare const __SF_BUGSINK_DSN__: string;
