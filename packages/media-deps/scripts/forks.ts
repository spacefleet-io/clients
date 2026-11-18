import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { forkEntries, forkRepos, type ForkEntry } from "../src/forks/catalog";
import { assertForksHaveNoActions, ensureForkRepo, setDefaultBranch } from "../src/forks/forge";
import { FORGE_ORG, forgeAuthFromEnv, forkCloneUrl, git, gitAuthEnv } from "../src/forks/git";
import { gitlinkProblems } from "../src/forks/gitlinks";
import { sfBranchName } from "../src/forks/names";
import { mirrorFork, parseLsRemote } from "../src/forks/mirror";
import { pinRelease } from "../src/forks/pin";
import { importReleases, listReleaseVersions } from "../src/forks/releases";
import { findNewTags, newTagsKey, tagNames } from "../src/forks/newTags";
import { advisoryReport, DEPENDABOT_FORKS, deleteDependabotBranches, pinAdvisories } from "../src/forks/advisories";

/**
 * Maintains the forks of every upstream library: one GitHub repository per library in the `spacefleet-io` org.
 *
 *   forks.ts create                      create the missing repos (with the visibility of spacefleet-io/media-deps), with Actions switched off (also on existing ones),
 *                                        and realign each default branch with upstream's HEAD (both need repo admin: run it by hand, never from CI)
 *   forks.ts sync [--only a,b]           mirror upstream branches/tags (and new release tarballs) into the forks; never touches sf/*
 *   forks.ts pin <id>|--all [--ref R] [--version V] [--release-url U --release-sha256 H] [--offline]
 *                                        create/verify `sf/<version>`, push it, print the pin (sha) for src/sources.ts;
 *                                        --offline: no forge access at all, in the bare repos already in FORKS_CACHE, nothing
 *                                        pushed (the lib-bump agent, which holds no forge credential; its trusted step pushes)
 *   forks.ts check                       every pinned sha is the tip of its fork's sf/<version> branch; fails when any fork has Actions enabled (as do sync and pin)
 *   forks.ts new-tags [--upstream] [--out F]
 *                                        the newest STABLE upstream tag above each pin (REL-DEPS-12, REL-UPG-08), read from the
 *                                        forks after a sync (or straight from upstream with --upstream: no forge credential, for a
 *                                        hand check); prints one line per pin and writes {key, found, checked, skipped, missing} as
 *                                        JSON to F; exit 0 either way, 1 when a repository could not be listed
 *   forks.ts advisories [--out F]        monthly (REL-DEPS-15): delete the dependabot/* branches on DEPENDABOT_FORKS, then ask OSV
 *                                        which advisories affect each pinned commit; prints the report (and writes it to F); report
 *                                        only, exit 1 only when GitHub or OSV fails
 *
 * Environment: MEDIA_DEPS_GH_TOKEN (or GH_TOKEN): a GitHub token with contents write on the forks for sync/pin and
 * administration for create; read for check and new-tags (none once the forks are public; none for `pin --offline` and
 * `new-tags --upstream`), contents write on DEPENDABOT_FORKS for advisories, FORKS_CACHE (bare working repos; default ~/.cache/spacefleet/forks).
 */
const [command = "", ...rest] = process.argv.slice(2);
const args: Record<string, string | true> = {};
const positional: string[] = [];
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i] ?? "";
  if (!arg.startsWith("--")) positional.push(arg);
  else if (arg === "--all" || arg === "--upstream" || arg === "--offline") args[arg.slice(2)] = true;
  else args[arg.slice(2)] = rest[++i] ?? "";
}

const auth = forgeAuthFromEnv();
const writes = command === "create" || command === "sync" || command === "advisories" || (command === "pin" && args.offline !== true);
if (writes && !auth) throw new Error("MEDIA_DEPS_GH_TOKEN (or GH_TOKEN) is required");
const authEnv = gitAuthEnv(auth);
const cacheDir = process.env.FORKS_CACHE ?? path.join(os.homedir(), ".cache", "spacefleet", "forks");
const only = typeof args.only === "string" ? new Set(args.only.split(",")) : undefined;
const entries = forkEntries().filter((entry) => !only || only.has(entry.id) || only.has(entry.spec.repo));

const describeFork = (entry: ForkEntry) =>
  `Fork of ${entry.spec.upstream.kind === "git" ? entry.spec.upstream.url : entry.spec.upstream.index} used to build SpaceFleet's media dependencies. Upstream is mirrored nightly; our changes live on sf/* only.`;

const download = async (url: string, expected?: string): Promise<string> => {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download_failed:${response.status}:${url}`);
  const body = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (expected !== undefined && sha256 !== expected) throw new Error(`sha256_mismatch:${url}:got ${sha256} want ${expected}`);
  const dir = mkdtempSync(path.join(os.tmpdir(), "media-deps-release-"));
  const file = path.join(dir, path.basename(new URL(url).pathname));
  writeFileSync(file, body);
  return file;
};

const pinOne = async (entry: ForkEntry) => {
  const { spec } = entry;
  const forkUrl = forkCloneUrl(spec.repo);
  const repoDir = path.join(cacheDir, `${spec.repo}.git`);
  const offline = args.offline === true;
  if (offline) {
    // the trusted step fetched the fork into FORKS_CACHE before the agent ran; nothing to reach from here
    if (!existsSync(repoDir)) throw new Error(`pin --offline: ${repoDir} is missing (the fork must already be in FORKS_CACHE)`);
  } else {
    mkdirSync(cacheDir, { recursive: true });
    await git(["init", "--bare", "-q", repoDir]);
    await git(["fetch", "--no-tags", "-q", forkUrl, "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"], { cwd: repoDir, env: authEnv });
  }
  const releaseUrl = typeof args["release-url"] === "string" ? args["release-url"] : spec.release?.url;
  const releaseSha = typeof args["release-sha256"] === "string" ? args["release-sha256"] : spec.release?.sha256;
  const file = releaseUrl ? await download(releaseUrl, releaseSha) : undefined;
  try {
    const ref = typeof args.ref === "string" ? args.ref : spec.upstreamRef;
    // a release-tarballs upstream's tag is made by the importer; its release is already the tag's tree
    const release = file && spec.upstream.kind === "git" && releaseUrl ? { url: releaseUrl, file, sha256: releaseSha } : undefined;
    const version = typeof args.version === "string" ? args.version : spec.version;
    const result = await pinRelease({ repoDir, ref, version, release, submoduleRepos: entry.submoduleRepos });
    const branch = sfBranchName(version);
    if (!offline) await git(["push", "-q", forkUrl, `refs/heads/${branch}:refs/heads/${branch}`], { cwd: repoDir, env: authEnv });
    console.info(JSON.stringify({ id: entry.id, repo: spec.repo, version, ...result, release: release ? { url: release.url, sha256: result.releaseSha256 } : undefined }));
    return result;
  } finally {
    if (file) rmSync(path.dirname(file), { recursive: true, force: true });
  }
};

// Upstream workflows must never run on a fork: sync/pin/check refuse to touch the forks while any has Actions on.
// (`pin --offline` and `new-tags` neither push nor start anything on the forks.)
const forge = { token: auth?.token ?? "" };
// Without a token (a public checkout running `check`) there is nothing to guard: it pushes and starts nothing.
if (command === "sync" || (command === "pin" && args.offline !== true) || (command === "check" && auth)) {
  await assertForksHaveNoActions(forge, forkRepos(forkEntries()).map((entry) => entry.spec.repo));
}

if (command === "create") {
  for (const entry of forkRepos(entries)) {
    const created = await ensureForkRepo(forge, entry.spec.repo, describeFork(entry));
    console.info(`[forks] ${FORGE_ORG}/${entry.spec.repo} ${created ? "created" : "exists"}`);
    // Editing a repo's default branch needs repo admin, which the sync token (write only) does not have: realign it here.
    if (entry.spec.upstream.kind === "git") {
      const head = await git(["ls-remote", "--symref", entry.spec.upstream.url, "HEAD"], { env: authEnv });
      const branch = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(head)?.[1];
      const forkRefs = parseLsRemote(await git(["ls-remote", "--heads", forkCloneUrl(entry.spec.repo)], { env: authEnv }));
      if (branch && forkRefs.some((ref) => ref.name === `refs/heads/${branch}`)) await setDefaultBranch(forge, entry.spec.repo, branch);
    }
  }
} else if (command === "sync") {
  const failures: string[] = [];
  for (const entry of forkRepos(entries)) {
    const { spec } = entry;
    try {
      const forkUrl = forkCloneUrl(spec.repo);
      if (spec.upstream.kind === "git") {
        await mirrorFork({ name: spec.repo, upstreamUrl: spec.upstream.url, forkUrl, cacheDir, auth, log: console.info });
      } else {
        await importReleases({
          name: spec.repo,
          upstream: spec.upstream,
          forkUrl,
          cacheDir,
          auth,
          expected: spec.release ? { [spec.version]: spec.release.sha256 } : undefined,
          log: console.info,
        });
      }
    } catch (error) {
      failures.push(spec.repo);
      console.error(`[forks] ${spec.repo}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(`sync_failed:${failures.join(",")}`);
} else if (command === "pin") {
  const wanted = args.all === true ? entries : entries.filter((entry) => positional.includes(entry.id));
  if (wanted.length === 0) throw new Error("pin needs an <id> (or --all)");
  // submodule forks first: the parent's .gitmodules only needs their repo names, order is for readability
  for (const entry of wanted) await pinOne(entry);
} else if (command === "check") {
  const failures: string[] = [];
  for (const { id, spec, submodules } of entries) {
    const refs = parseLsRemote(await git(["ls-remote", "--heads", forkCloneUrl(spec.repo), `refs/heads/${sfBranchName(spec.version)}`], { env: authEnv }));
    const tip = refs[0]?.sha;
    if (tip !== spec.sha) {
      failures.push(`${id}: ${sfBranchName(spec.version)} is ${tip ?? "missing"}, pin is ${spec.sha}`);
      continue;
    }
    if (submodules) {
      // the pinned tree's gitlinks are exactly the pinned submodule commits, fetched from the sibling forks
      const repoDir = path.join(cacheDir, `${spec.repo}.git`);
      mkdirSync(cacheDir, { recursive: true });
      await git(["init", "--bare", "-q", repoDir]);
      await git(["fetch", "--no-tags", "-q", "--depth", "1", forkCloneUrl(spec.repo), spec.sha], { cwd: repoDir, env: authEnv });
      const tree = await git(["ls-tree", "-r", spec.sha], { cwd: repoDir });
      const gitmodules = await git(["show", `${spec.sha}:.gitmodules`], { cwd: repoDir });
      failures.push(...gitlinkProblems(submodules, tree, gitmodules).map((problem) => `${id}/${problem}`));
    }
    console.info(`[forks] ${id} ${spec.repo}@${spec.sha.slice(0, 12)} ok${submodules ? ` (+${Object.keys(submodules).length} submodule gitlinks)` : ""}`);
  }
  if (failures.length > 0) throw new Error(`check_failed:\n${failures.join("\n")}`);
} else if (command === "new-tags") {
  const fromUpstream = args.upstream === true;
  const tagsByRepo = new Map<string, string[]>();
  for (const entry of forkRepos(entries)) {
    const { spec } = entry;
    try {
      if (spec.upstream.kind === "git") {
        const url = fromUpstream ? spec.upstream.url : forkCloneUrl(spec.repo);
        tagsByRepo.set(spec.repo, tagNames(await git(["ls-remote", "--tags", url], { env: fromUpstream ? {} : authEnv })));
      } else {
        // a release-tarballs upstream has no git tags: the importer tags each release `v<version>`, the RSS listing is the source
        const response = await fetch(spec.upstream.index, { headers: { "User-Agent": "spacefleet-media-deps (forks.ts new-tags)" } });
        if (!response.ok) throw new Error(`${spec.upstream.index}: HTTP ${response.status}`);
        tagsByRepo.set(spec.repo, listReleaseVersions(await response.text(), spec.upstream).map((version) => `v${version}`));
      }
      console.info(`[forks] new-tags ${spec.repo}: ${tagsByRepo.get(spec.repo)?.length ?? 0} tags listed (${fromUpstream ? "upstream" : "fork"})`);
    } catch (error) {
      console.error(`[forks] new-tags ${spec.repo}: could not list tags: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const result = findNewTags(entries, tagsByRepo);
  const byId = new Map(result.found.map((hit) => [hit.id, hit]));
  for (const { id, spec } of entries) {
    const hit = byId.get(id);
    if (hit) console.info(`[forks] new-tags ${id} ${spec.version} (${spec.upstreamRef}) -> ${hit.tag} (newer: ${hit.newer.join(" ")})`);
    else if (result.skipped.includes(id)) console.info(`[forks] new-tags ${id} skipped (commit pin ${spec.upstreamRef.slice(0, 12)})`);
    else if (result.missing.includes(spec.repo)) console.info(`[forks] new-tags ${id} UNKNOWN (tags of ${spec.repo} not listed)`);
    else console.info(`[forks] new-tags ${id} ${spec.version} (${spec.upstreamRef}) current`);
  }
  const key = newTagsKey(result.found);
  console.info(`[forks] new-tags: ${result.found.length} new, ${result.checked.length} current-or-new checked, ${result.skipped.length} skipped, ${result.missing.length} missing; key=${key || "(none)"}`);
  if (typeof args.out === "string") writeFileSync(args.out, `${JSON.stringify({ key, ...result }, null, 2)}\n`);
  if (result.missing.length > 0) process.exitCode = 1;
} else if (command === "advisories") {
  // REL-DEPS-15: report only; the one write is deleting the dependabot/* branches upstream's dependabot.yml keeps opening
  const cleanup: Record<string, string[]> = {};
  for (const repo of DEPENDABOT_FORKS) {
    cleanup[repo] = await deleteDependabotBranches(forge, repo);
    console.info(`[forks] advisories ${repo}: ${cleanup[repo]!.length} dependabot branches deleted`);
  }
  const report = advisoryReport(await pinAdvisories(forge, entries), cleanup);
  console.info(report);
  if (typeof args.out === "string") writeFileSync(args.out, report);
} else {
  throw new Error(`usage: forks.ts create|sync|pin|check|new-tags|advisories (got "${command}")`);
}
