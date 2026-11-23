/**
 * The production API every release build of every app talks to (ACCT-AUTH-09, REL-LAUNCH-03), and a development
 * build's default until a server is picked. One constant for the phone, TV and desktop apps so they cannot drift.
 */
export const PRODUCTION_API_BASE_URL = "https://api.spacefleet.io";

/**
 * The API a browser build talks to (the website, its web players, the admin): its `VITE_API_BASE_URL` (the absolute API
 * host every deployed web build bakes in), else same-origin `/api` (proxied by Vite in dev). An empty value counts as
 * unset: Docker turns an ARG without a default into an empty ENV, and the copies of this fallback disagreed on it, some
 * calling `/api`, others the page's own origin (#3350 S54). Callers pass `import.meta.env.VITE_API_BASE_URL`: this
 * module is shared with the phone apps, whose bundler has no `import.meta.env`.
 */
export const webApiBaseUrl = (configured: string | undefined): string => configured?.trim() || "/api";
