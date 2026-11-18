/**
 * The build-time flags that make a desktop build a development build (Vite inlines both; the main process gets
 * `VITE_SF_DEV_TICKET_KEY` through `define` in electron.vite.config.ts).
 */
export interface DesktopBuildEnv {
  DEV?: boolean;
  /** `1` in a test build of the packaged app (`bun run build:test`, e2e and electron integration runs); never set by `package`. */
  VITE_SF_DEV_TICKET_KEY?: string;
}

/**
 * Whether this is a development build: `electron-vite dev`, or a test build made with `VITE_SF_DEV_TICKET_KEY=1`.
 * A release package is never one (`scripts/package.mjs` refuses the flag). It decides both the ticket keys the build
 * trusts (META-ANON-06, META-ANON-07) and whether it has the server picker (ACCT-AUTH-09). Decided by the build,
 * never by the URL the app talks to.
 */
export const isDesktopDevBuild = (env: DesktopBuildEnv): boolean => env.DEV === true || env.VITE_SF_DEV_TICKET_KEY === "1";

/** The flags of the running bundle, read at call time (tests stub them with `vi.stubEnv`). */
export const currentDesktopBuildEnv = (): DesktopBuildEnv => ({
  DEV: import.meta.env.DEV,
  VITE_SF_DEV_TICKET_KEY: import.meta.env.VITE_SF_DEV_TICKET_KEY,
});
