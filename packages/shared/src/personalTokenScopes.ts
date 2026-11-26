/**
 * What a personal token may be allowed to do (DEV-TOK-01). A token only ever reaches a route that
 * opts in with `scoped("<scope>")` (`openapi/helpers.ts`); every other route is session-only. The
 * website and the command-line tool read this catalogue from `GET /account/tokens/scopes`, so nothing
 * else hard-codes the list.
 */
export const TOKEN_SCOPES = [
  {
    scope: "account:read",
    description: "Read the account: profile, settings, subscription, referrals and storage usage.",
  },
  {
    scope: "devices:read",
    description: "List the devices (sessions) signed in to the account.",
  },
] as const;

export type TokenScope = (typeof TOKEN_SCOPES)[number]["scope"];

export const TOKEN_SCOPE_IDS = TOKEN_SCOPES.map((entry) => entry.scope) as [TokenScope, ...TokenScope[]];

export const isTokenScope = (value: unknown): value is TokenScope =>
  typeof value === "string" && (TOKEN_SCOPE_IDS as readonly string[]).includes(value);
