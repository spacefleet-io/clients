import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertForksHaveNoActions, ensureForkRepo, reposWithActionsEnabled } from "../src/forks/forge";

type Call = { method: string; path: string; body?: unknown };

/** A fake GitHub API for the spacefleet-io org: `repos` maps a fork to whether its Actions are enabled. */
const fakeForge = (repos: Record<string, boolean>, releasesRepoPrivate = true) => {
  const calls: Call[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method, path: url.pathname, body });
    const single = /^\/repos\/spacefleet-io\/([^/]+)$/.exec(url.pathname);
    if (single?.[1] === "media-deps" && method === "GET") return Response.json({ name: "media-deps", private: releasesRepoPrivate });
    if (single && method === "GET") return single[1]! in repos ? Response.json({ name: single[1] }) : new Response("", { status: 404 });
    const actions = /^\/repos\/spacefleet-io\/([^/]+)\/actions\/permissions$/.exec(url.pathname);
    if (actions && !(actions[1]! in repos)) return new Response("", { status: 404 });
    if (actions && method === "GET") return Response.json({ enabled: repos[actions[1]!], allowed_actions: "all" });
    if (actions && method === "PUT") {
      repos[actions[1]!] = (body as { enabled: boolean }).enabled;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/orgs/spacefleet-io/repos" && method === "POST") {
      // GitHub creates a repo with Actions enabled
      repos[(body as { name: string }).name] = true;
      return Response.json({ name: (body as { name: string }).name }, { status: 201 });
    }
    return new Response("", { status: 500 });
  };
  return { calls, fetchImpl };
};

describe("fork repos never run upstream workflows", () => {
  it("disables Actions on a repo straight after creating it, before any push can happen", async () => {
    const repos: Record<string, boolean> = {};
    const { calls, fetchImpl } = fakeForge(repos);
    expect(await ensureForkRepo({ token: "t", fetchImpl }, "markupsafe", "d")).toBe(true);
    expect(repos.markupsafe).toBe(false);
    expect(calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /orgs/spacefleet-io/repos",
      "PUT /repos/spacefleet-io/markupsafe/actions/permissions",
    ]);
  });

  it("creates a fork private while the releases repository is private, public once it is public", async () => {
    const created = async (releasesRepoPrivate: boolean) => {
      const { calls, fetchImpl } = fakeForge({}, releasesRepoPrivate);
      await ensureForkRepo({ token: "t", fetchImpl }, "zimg", "d");
      return calls.find((call) => call.method === "POST")?.body as { private: boolean; has_issues: boolean };
    };
    expect(await created(true)).toMatchObject({ private: true, has_issues: false });
    expect((await created(false)).private).toBe(false);
  });

  it("also switches Actions off on a repo that already exists", async () => {
    const repos: Record<string, boolean> = { zlib: true };
    const { fetchImpl } = fakeForge(repos);
    expect(await ensureForkRepo({ token: "t", fetchImpl }, "zlib", "d")).toBe(false);
    expect(repos.zlib).toBe(false);
  });

  it("lists the forks with Actions enabled; a fork that does not exist yet is fine", async () => {
    const { fetchImpl } = fakeForge({ a: false, b: true, c: false });
    expect(await reposWithActionsEnabled({ token: "t", fetchImpl }, ["a", "b", "c", "missing"])).toEqual(["b"]);
  });
});

describe("@bugfix @regression-proof forks must never run upstream CI on our runners (markupsafe cibuildwheel starved the shared runner)", () => {
  it("@bugfix @regression-proof a failed Actions switch-off makes ensureForkRepo throw and nothing else is called afterwards", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${new URL(input).pathname}`);
      if (method === "PUT") return new Response("forbidden", { status: 403 });
      return Response.json({ name: "markupsafe" });
    };
    await expect(ensureForkRepo({ token: "t", fetchImpl }, "markupsafe", "d")).rejects.toThrow("forge_disable_actions_failed:403:markupsafe");
    expect(calls).toEqual(["GET /repos/spacefleet-io/markupsafe", "PUT /repos/spacefleet-io/markupsafe/actions/permissions"]);
  });

  it("@bugfix @regression-proof assertForksHaveNoActions names every offender, and a refused lookup is an error, never a pass", async () => {
    const { fetchImpl } = fakeForge({ zlib: false, markupsafe: true, zimg: true });
    await expect(assertForksHaveNoActions({ token: "t", fetchImpl }, ["zlib", "markupsafe", "zimg"])).rejects.toThrow("actions_enabled_on_forks:markupsafe,zimg");
    const clean = fakeForge({ zlib: false });
    await expect(assertForksHaveNoActions({ token: "t", fetchImpl: clean.fetchImpl }, ["zlib"])).resolves.toBeUndefined();
    const refused = async () => new Response("", { status: 403 });
    await expect(assertForksHaveNoActions({ token: "t", fetchImpl: refused }, ["zlib"])).rejects.toThrow("forge_actions_lookup_failed:403:zlib");
  });

  it.each(["sync", "pin", "check"])("@bugfix @regression-proof forks.ts %s stops with actions_enabled_on_forks before it starts any git process", (command) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "forks-guard-"));
    try {
      const marker = path.join(dir, "git-was-run");
      writeFileSync(path.join(dir, "git"), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
      chmodSync(path.join(dir, "git"), 0o755);
      // every fetch (the GitHub API) answers: Actions are on
      writeFileSync(path.join(dir, "preload.ts"), `globalThis.fetch = async () => Response.json({ enabled: true, allowed_actions: "all" });\n`);
      const env: Record<string, string | undefined> = { ...process.env, PATH: `${dir}:${process.env.PATH}`, MEDIA_DEPS_GH_TOKEN: "tok", FORKS_CACHE: path.join(dir, "cache") };
      delete env.GH_TOKEN;
      const result = spawnSync("bun", ["--preload", path.join(dir, "preload.ts"), path.resolve(__dirname, "../scripts/forks.ts"), command, ...(command === "pin" ? ["--all"] : [])], {
        env,
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("actions_enabled_on_forks:");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
