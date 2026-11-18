import { describe, expect, it } from "vitest";
import { advisoryReport, DEPENDABOT_FORKS, deleteDependabotBranches, pinAdvisories } from "../src/forks/advisories";
import type { ForkEntry } from "../src/forks/catalog";

type Call = { method: string; path: string; body?: unknown };

/** A fake GitHub API: `branches` maps a fork to its branch names; `deleteStatus` forces a DELETE answer. */
const fakeGithub = (branches: Record<string, string[]>, deleteStatus?: number, parents: Record<string, string[]> = {}) => {
  const calls: Call[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname });
    const list = /^\/repos\/spacefleet-io\/([^/]+)\/git\/matching-refs\/heads\/dependabot\/$/.exec(url.pathname);
    if (list && method === "GET") {
      const repo = list[1]!;
      if (!(repo in branches)) return new Response("", { status: 404 });
      return Response.json(branches[repo]!.filter((name) => name.startsWith("dependabot/")).map((name) => ({ ref: `refs/heads/${name}` })));
    }
    const ref = /^\/repos\/spacefleet-io\/([^/]+)\/git\/refs\/heads\/(.+)$/.exec(url.pathname);
    if (ref && method === "DELETE") {
      if (deleteStatus) return new Response("", { status: deleteStatus });
      const name = decodeURIComponent(ref[2]!);
      branches[ref[1]!] = (branches[ref[1]!] ?? []).filter((branch) => branch !== name);
      return new Response(null, { status: 204 });
    }
    const commit = /^\/repos\/spacefleet-io\/([^/]+)\/commits\/([0-9a-f]+)$/.exec(url.pathname);
    if (commit && method === "GET") return Response.json({ sha: commit[2], parents: (parents[commit[2]!] ?? []).map((sha) => ({ sha })) });
    return new Response("", { status: 500 });
  };
  return { api: { token: "t", baseUrl: "https://api.test", fetchImpl }, calls };
};

const entry = (id: string, sha: string, extra: Partial<ForkEntry["spec"]> = {}, submoduleRepos?: Record<string, string>): ForkEntry => ({
  id,
  spec: { repo: id, sha, version: "1.0", upstreamRef: "v1.0", upstream: { kind: "git", url: `https://example.org/${id}.git` }, ...extra } as ForkEntry["spec"],
  submoduleRepos,
});

describe("dependabot branch cleanup", () => {
  // @req REL-DEPS-15[ci]
  it("deletes only dependabot branches and nothing on a second run", async () => {
    const branches = { harfbuzz: ["main", "sf/11.2.1", "dependabot/github_actions/actions/checkout-5", "dependabot/pip/meson-1.9"] };
    const { api, calls } = fakeGithub(branches);
    expect(await deleteDependabotBranches(api, "harfbuzz")).toEqual(["dependabot/github_actions/actions/checkout-5", "dependabot/pip/meson-1.9"]);
    expect(branches.harfbuzz).toEqual(["main", "sf/11.2.1"]);
    expect(calls.filter((call) => call.method === "DELETE").every((call) => call.path.includes("/git/refs/heads/dependabot/"))).toBe(true);
    expect(await deleteDependabotBranches(api, "harfbuzz")).toEqual([]);
  });

  // @req REL-DEPS-15[ci]
  it("counts a branch already gone as done and fails on any other error", async () => {
    for (const status of [404, 422]) {
      expect(await deleteDependabotBranches(fakeGithub({ expat: ["dependabot/x"] }, status).api, "expat")).toEqual([]);
    }
    await expect(deleteDependabotBranches(fakeGithub({ expat: ["dependabot/x"] }, 403).api, "expat")).rejects.toThrow("forge_ref_delete_failed:403:expat:dependabot/x");
    await expect(deleteDependabotBranches(fakeGithub({}).api, "expat")).rejects.toThrow("forge_refs_lookup_failed:404:expat");
  });

  // @req REL-DEPS-15[ci]
  it("covers the seven forks carrying upstream's dependabot.yml", () => {
    expect([...DEPENDABOT_FORKS].sort()).toEqual(["expat", "fast-float", "glslang", "harfbuzz", "spirv-headers", "spirv-tools", "vulkan-headers"]);
  });
});

describe("OSV advisories of the pins", () => {
  // @req REL-DEPS-15[ci]
  it("asks OSV per pinned commit, adds the upstream parent of an imported pin, and maps results back", async () => {
    const { api } = fakeGithub({}, undefined, { bbbb: ["cccc"] });
    let sent: { queries: { commit: string }[] } | undefined;
    const osvFetch = async (input: string, init?: RequestInit) => {
      expect(input).toBe("https://osv.test/v1/querybatch");
      sent = JSON.parse(String(init?.body)) as typeof sent;
      return Response.json({ results: [{ vulns: [{ id: "OSV-2" }, { id: "OSV-1" }] }, {}, { vulns: [{ id: "OSV-1" }] }] });
    };
    const pins = await pinAdvisories(api, [entry("expat", "aaaa"), entry("lame", "bbbb", { release: { url: "u", sha256: "h" } } as never)], osvFetch, "https://osv.test");
    expect(sent?.queries).toEqual([{ commit: "aaaa" }, { commit: "bbbb" }, { commit: "cccc" }]);
    expect(pins.map(({ id, commits, vulns }) => ({ id, commits, vulns }))).toEqual([
      { id: "expat", commits: ["aaaa"], vulns: ["OSV-1", "OSV-2"] },
      { id: "lame", commits: ["bbbb", "cccc"], vulns: ["OSV-1"] },
    ]);
  });

  // @req REL-DEPS-15[ci]
  it("fails when OSV does", async () => {
    const osvFetch = async () => new Response("", { status: 503 });
    await expect(pinAdvisories(fakeGithub({}).api, [entry("expat", "aaaa")], osvFetch)).rejects.toThrow("osv_query_failed:503");
  });

  // @req REL-DEPS-15[ci]
  it("reports the affected pins and the dependabot branch count", () => {
    const report = advisoryReport(
      [
        { id: "expat", repo: "expat", version: "2.7.1", commits: ["aaaaaaaaaaaaaaaa"], vulns: ["CVE-2025-1"] },
        { id: "zlib", repo: "zlib", version: "1.3", commits: ["dddd"], vulns: [] },
      ],
      { expat: [], harfbuzz: ["dependabot/a", "dependabot/b"] },
    );
    expect(report).toContain("Media dependency advisories (OSV): 1 of 2 pins affected.");
    expect(report).toContain("- expat 2.7.1 (aaaaaaaaaaaa): CVE-2025-1 https://osv.dev/vulnerability/CVE-2025-1");
    expect(report).toContain("Dependabot branches deleted on the forks: 2.");
    expect(report).toContain("- harfbuzz: dependabot/a, dependabot/b");
    expect(report).not.toContain("zlib");
  });
});
