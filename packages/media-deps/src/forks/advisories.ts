import type { ForkEntry } from "./catalog";
import { GITHUB_API_URL, type ForgeApi } from "./forge";
import { FORGE_ORG } from "./git";

/**
 * The forks whose default branch (`sf/<version>`, the pinned upstream tree) carries upstream's own
 * `.github/dependabot.yml`, so GitHub keeps opening `dependabot/*` branches on them although every alert and
 * security update is off. The file stays: `sf/<version>` must stay exactly the pinned sha (`forks.ts check`), so a
 * commit removing it is not possible, and archiving the repo would refuse the nightly mirror push. The monthly
 * advisory job deletes those branches instead (REL-DEPS-15).
 */
export const DEPENDABOT_FORKS = ["expat", "fast-float", "glslang", "harfbuzz", "spirv-headers", "spirv-tools", "vulkan-headers"] as const;

export const OSV_API_URL = "https://api.osv.dev";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const githubHeaders = (api: ForgeApi) => ({
  Accept: "application/vnd.github+json",
  ...(api.token ? { Authorization: `Bearer ${api.token}` } : {}),
  "X-GitHub-Api-Version": "2022-11-28",
});

/**
 * Deletes every `dependabot/*` branch of `repo`. Idempotent: a branch already gone (404/422) counts as done, and a
 * repo with none deletes nothing. Never touches any other branch. Returns the branch names it removed.
 */
export const deleteDependabotBranches = async (api: ForgeApi, repo: string): Promise<string[]> => {
  const base = api.baseUrl ?? GITHUB_API_URL;
  const send: Fetch = api.fetchImpl ?? fetch;
  const headers = githubHeaders(api);
  const listed = await send(`${base}/repos/${FORGE_ORG}/${repo}/git/matching-refs/heads/dependabot/`, { headers });
  if (!listed.ok) throw new Error(`forge_refs_lookup_failed:${listed.status}:${repo}`);
  const refs = (await listed.json()) as { ref?: unknown }[];
  const deleted: string[] = [];
  for (const { ref } of refs) {
    if (typeof ref !== "string" || !ref.startsWith("refs/heads/dependabot/")) continue;
    const branch = ref.slice("refs/heads/".length);
    const path = branch.split("/").map(encodeURIComponent).join("/");
    const response = await send(`${base}/repos/${FORGE_ORG}/${repo}/git/refs/heads/${path}`, { method: "DELETE", headers });
    if (response.ok) deleted.push(branch);
    else if (response.status !== 404 && response.status !== 422) throw new Error(`forge_ref_delete_failed:${response.status}:${repo}:${branch}`);
  }
  return deleted;
};

export type PinAdvisories = {
  id: string;
  repo: string;
  version: string;
  /** The commits asked about: the pin and, when it is our own commit on top of upstream, its upstream parent. */
  commits: string[];
  /** OSV ids affecting any of `commits`, sorted. */
  vulns: string[];
};

/** The pin's parents on its fork (one upstream commit when the pin is our import or `.gitmodules` rewrite). */
const parentsOf = async (api: ForgeApi, repo: string, sha: string): Promise<string[]> => {
  const base = api.baseUrl ?? GITHUB_API_URL;
  const send: Fetch = api.fetchImpl ?? fetch;
  const response = await send(`${base}/repos/${FORGE_ORG}/${repo}/commits/${sha}`, { headers: githubHeaders(api) });
  if (!response.ok) throw new Error(`forge_commit_lookup_failed:${response.status}:${repo}:${sha}`);
  const commit = (await response.json()) as { parents?: { sha?: unknown }[] };
  return (commit.parents ?? []).map((parent) => parent.sha).filter((parent): parent is string => typeof parent === "string");
};

/**
 * Asks OSV which published advisories affect each pinned commit (OSV matches a git commit against the affected
 * ranges of the upstream repository). Report only: nothing is changed. An imported pin (`release` or a
 * `.gitmodules` rewrite) is our commit, unknown to OSV, so its upstream parent is asked too.
 */
export const pinAdvisories = async (api: ForgeApi, entries: readonly ForkEntry[], osvFetch: Fetch = fetch, osvUrl = OSV_API_URL): Promise<PinAdvisories[]> => {
  const pins: PinAdvisories[] = [];
  for (const entry of entries) {
    const parents = entry.spec.release || entry.submoduleRepos ? await parentsOf(api, entry.spec.repo, entry.spec.sha) : [];
    pins.push({ id: entry.id, repo: entry.spec.repo, version: entry.spec.version, commits: [entry.spec.sha, ...parents], vulns: [] });
  }
  const queries = pins.flatMap((pin, index) => pin.commits.map((commit) => ({ index, commit })));
  const response = await osvFetch(`${osvUrl}/v1/querybatch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queries: queries.map(({ commit }) => ({ commit })) }),
  });
  if (!response.ok) throw new Error(`osv_query_failed:${response.status}`);
  const { results = [] } = (await response.json()) as { results?: { vulns?: { id?: unknown }[] }[] };
  results.forEach((result, i) => {
    const pin = pins[queries[i]?.index ?? -1];
    for (const vuln of result.vulns ?? []) if (pin && typeof vuln.id === "string") pin.vulns.push(vuln.id);
  });
  for (const pin of pins) pin.vulns = [...new Set(pin.vulns)].sort();
  return pins;
};

/** The plain-text report: advisories per pin, then the Dependabot branch cleanup. */
export const advisoryReport = (pins: readonly PinAdvisories[], cleanup: Readonly<Record<string, readonly string[]>>): string => {
  const affected = pins.filter((pin) => pin.vulns.length > 0);
  const deletedCount = Object.values(cleanup).reduce((sum, branches) => sum + branches.length, 0);
  const lines = [
    `Media dependency advisories (OSV): ${affected.length} of ${pins.length} pins affected.`,
    ...affected.map((pin) => `- ${pin.id} ${pin.version} (${pin.commits[0]?.slice(0, 12)}): ${pin.vulns.map((id) => `${id} https://osv.dev/vulnerability/${id}`).join(", ")}`),
    "",
    `Dependabot branches deleted on the forks: ${deletedCount}.`,
    ...Object.entries(cleanup)
      .filter(([, branches]) => branches.length > 0)
      .map(([repo, branches]) => `- ${repo}: ${branches.join(", ")}`),
  ];
  return `${lines.join("\n")}\n`;
};
