import { FORGE_ORG } from "./git";

export const GITHUB_API_URL = "https://api.github.com";

/** The repository whose releases carry the bundles: new forks take its visibility (private until it is published). */
export const VISIBILITY_REFERENCE_REPO = "media-deps";

export type ForgeApi = {
  token: string;
  baseUrl?: string;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
};

const endpoints = (api: ForgeApi) => ({
  base: api.baseUrl ?? GITHUB_API_URL,
  send: api.fetchImpl ?? fetch,
  headers: {
    Accept: "application/vnd.github+json",
    ...(api.token ? { Authorization: `Bearer ${api.token}` } : {}),
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  },
});

/**
 * Upstream repos ship their own CI (GitHub workflows, cibuildwheel, ...). A fork must never run them, so Actions is
 * switched off on every fork; only the spacefleet repo's workflows touch the forks.
 */
const disableActions = async (api: ForgeApi, name: string): Promise<void> => {
  const { base, send, headers } = endpoints(api);
  const response = await send(`${base}/repos/${FORGE_ORG}/${name}/actions/permissions`, { method: "PUT", headers, body: JSON.stringify({ enabled: false }) });
  if (!response.ok) throw new Error(`forge_disable_actions_failed:${response.status}:${name}`);
};

/**
 * Creates `<org>/<name>` when it does not exist yet, with the visibility of the bundle releases repository, and makes
 * sure its Actions are off BEFORE the caller can push anything. Returns true when it was created.
 */
export const ensureForkRepo = async (api: ForgeApi, name: string, description: string): Promise<boolean> => {
  const { base, send, headers } = endpoints(api);
  const existing = await send(`${base}/repos/${FORGE_ORG}/${name}`, { headers });
  if (existing.ok) {
    await disableActions(api, name);
    return false;
  }
  if (existing.status !== 404) throw new Error(`forge_repo_lookup_failed:${existing.status}:${name}`);
  const reference = await send(`${base}/repos/${FORGE_ORG}/${VISIBILITY_REFERENCE_REPO}`, { headers });
  if (!reference.ok) throw new Error(`forge_repo_lookup_failed:${reference.status}:${VISIBILITY_REFERENCE_REPO}`);
  const referenceRepo: unknown = await reference.json();
  // Private unless the releases repository is known to be public.
  const isPrivate = !(referenceRepo && typeof referenceRepo === "object" && "private" in referenceRepo && referenceRepo.private === false);
  const created = await send(`${base}/orgs/${FORGE_ORG}/repos`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, description, private: isPrivate, has_issues: false, has_wiki: false, has_projects: false, auto_init: false }),
  });
  if (!created.ok) throw new Error(`forge_repo_create_failed:${created.status}:${name}:${await created.text()}`);
  await disableActions(api, name);
  return true;
};

/** The fork repos among `names` that have Actions enabled (a missing repo counts as fine: `create` makes it). Empty means the guard holds. */
export const reposWithActionsEnabled = async (api: ForgeApi, names: readonly string[]): Promise<string[]> => {
  const { base, send, headers } = endpoints(api);
  const enabled: string[] = [];
  for (const name of names) {
    const response = await send(`${base}/repos/${FORGE_ORG}/${name}/actions/permissions`, { headers });
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`forge_actions_lookup_failed:${response.status}:${name}`);
    const permissions: unknown = await response.json();
    if (permissions && typeof permissions === "object" && "enabled" in permissions && permissions.enabled !== false) enabled.push(name);
  }
  return enabled;
};

/** Throws `actions_enabled_on_forks:<names>` when any fork has Actions on: callers must stop before pushing anything. */
export const assertForksHaveNoActions = async (api: ForgeApi, names: readonly string[]): Promise<void> => {
  const enabled = await reposWithActionsEnabled(api, names);
  if (enabled.length > 0) throw new Error(`actions_enabled_on_forks:${enabled.join(",")} (run forks.ts create to switch them off)`);
};

/** Sets the fork's default branch (the branch the first push created may not be upstream's HEAD). */
export const setDefaultBranch = async (api: ForgeApi, name: string, branch: string): Promise<void> => {
  const { base, send, headers } = endpoints(api);
  const response = await send(`${base}/repos/${FORGE_ORG}/${name}`, { method: "PATCH", headers, body: JSON.stringify({ default_branch: branch }) });
  if (!response.ok) throw new Error(`forge_default_branch_failed:${response.status}:${name}:${branch}`);
};
