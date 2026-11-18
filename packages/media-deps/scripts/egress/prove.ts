import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBuildPlan, forgeAuthFromEnv, getPackageRoot, loadTarget } from "../../src/index";
import { parseArgs } from "../_args";

/**
 * Egress-blocked build proof. Builds run in a BuildKit container on a docker `--internal` network (no route
 * out); its only way out is an allowlist proxy that logs every host a build step tries to reach. Prints:
 *   1. negative controls (a direct connection and a non-allowlisted host from inside a build step both fail),
 *   2. one `docker buildx build` per target through that sandbox (the real recipe, the real createBuildPlan args),
 *   3. the proxy's per-host ALLOW/DENY tally: everything the recipes reach, and nothing else.
 *
 * Env: MEDIA_DEPS_GH_TOKEN or GH_TOKEN while the forks are private. Heavy: wrap with the host's heavy-process lock.
 * Usage: bun scripts/egress/prove.ts [--target linux-x64,windows-x64] [--log <dir>]
 */
const ALLOW = [
  "github.com", "codeload.github.com", // the forks
  "archive.ubuntu.com", "security.ubuntu.com", "deb.debian.org", // distro packages (toolchain)
  "pypi.org", "files.pythonhosted.org", // meson (toolchain, linux-x64)
  "registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com", "production.cloudfront.docker.com", // base images (toolchain)
];
const args = parseArgs(process.argv.slice(2));
const targets = typeof args.target === "string" ? args.target.split(",") : ["linux-x64", "windows-x64"];
const logDir = typeof args.log === "string" ? path.resolve(args.log) : mkdtempSync(path.join(os.tmpdir(), "egress-"));
mkdirSync(logDir, { recursive: true });
const proxyLog = path.join(logDir, "proxy.log");
writeFileSync(proxyLog, "");
const auth = forgeAuthFromEnv();

const tag = `sf-egress-${process.pid}`;
const internal = `${tag}-int`;
const external = `${tag}-ext`;
const builder = `${tag}-builder`;
const proxyName = `${tag}-proxy`;
const docker = (dockerArgs: string[], options: { allowFailure?: boolean; env?: Record<string, string>; input?: string } = {}) => {
  const result = spawnSync("docker", dockerArgs, { encoding: "utf8", env: { ...process.env, ...options.env }, input: options.input, stdio: ["pipe", "pipe", "inherit"], maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0 && !options.allowFailure) throw new Error(`docker ${dockerArgs.slice(0, 2).join(" ")} failed (${result.status})`);
  return result;
};
const teardown = () => {
  docker(["buildx", "rm", "-f", builder], { allowFailure: true });
  docker(["rm", "-f", proxyName], { allowFailure: true });
  docker(["network", "rm", internal, external], { allowFailure: true });
};

try {
  docker(["network", "create", "--internal", internal]);
  docker(["network", "create", external]);
  docker([
    "run", "-d", "--name", proxyName, "--network", external, "-e", `ALLOW=${ALLOW.join(",")}`, "-e", "LOG=/logs/proxy.log",
    "-v", `${logDir}:/logs`, "-v", `${path.join(import.meta.dirname, "proxy.py")}:/proxy.py:ro`, "python:3.12-slim", "python3", "-u", "/proxy.py",
  ]);
  docker(["network", "connect", internal, proxyName]);
  const proxyIp = docker(["inspect", "-f", `{{(index .NetworkSettings.Networks "${internal}").IPAddress}}`, proxyName]).stdout.trim();
  const proxy = `http://${proxyIp}:3128`;
  console.info(`[egress] internal network ${internal} (no gateway), proxy ${proxy}, allowlist: ${ALLOW.join(", ")}`);
  docker(["buildx", "create", "--name", builder, "--driver", "docker-container", "--driver-opt", `network=${internal}`,
    "--driver-opt", `env.HTTP_PROXY=${proxy}`, "--driver-opt", `env.HTTPS_PROXY=${proxy}`, "--bootstrap"]);
  const proxyArgs = ["--build-arg", `http_proxy=${proxy}`, "--build-arg", `https_proxy=${proxy}`];

  // 1. negative controls: run with the SAME builder, so they prove what the recipes cannot reach
  const control = mkdtempSync(path.join(os.tmpdir(), "egress-control-"));
  writeFileSync(path.join(control, "Dockerfile"), `FROM debian:trixie
SHELL ["/bin/bash", "-c"]
ARG http_proxy
RUN echo "[control] direct TCP to 1.1.1.1:443 (no proxy)" && if timeout 10 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' 2>/dev/null; then echo "[control] FAIL: direct egress worked"; exit 1; else echo "[control] direct egress blocked, as required"; fi
RUN host="\${http_proxy#http://}" && echo "[control] CONNECT github.com:443 through the proxy" \\
 && exec 3<>"/dev/tcp/\${host%:*}/\${host#*:}" && printf 'CONNECT github.com:443 HTTP/1.0\\r\\n\\r\\n' >&3 && read -r status <&3 && echo "[control] proxy answered: $status" && case "$status" in *403*) ;; *) echo "[control] FAIL: github.com was not denied"; exit 1;; esac
`);
  console.info("[egress] negative controls");
  docker(["buildx", "--builder", builder, "build", "--progress=plain", "--no-cache", "--build-arg", `http_proxy=${proxy}`, control]);
  rmSync(control, { recursive: true, force: true });

  // 2. the real recipes
  for (const id of targets) {
    const target = await loadTarget(id);
    const out = mkdtempSync(path.join(os.tmpdir(), `egress-${id}-`));
    const plan = createBuildPlan(target, { outputDir: out, packageRoot: getPackageRoot(), forgeAuth: auth });
    const base = plan.args.slice(0, -1);
    const context = plan.args.at(-1) ?? "";
    console.info(`[egress] building ${id} through the sandbox`);
    const logFile = path.join(logDir, `build-${id}.log`);
    const result = spawnSync(plan.command, ["buildx", "--builder", builder, ...base.slice(1), "--no-cache", ...proxyArgs, context], {
      env: { ...process.env, ...plan.env },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 1024,
    });
    writeFileSync(logFile, `${result.stdout}\n${result.stderr}`);
    rmSync(out, { recursive: true, force: true });
    if (result.status !== 0) {
      console.error(`[egress] ${id} build FAILED (${result.status}); tail of ${logFile}:\n${result.stderr.split("\n").slice(-40).join("\n")}`);
      process.exitCode = 1;
    } else console.info(`[egress] ${id} build succeeded; log ${logFile}`);
  }

  // 3. the tally
  const tally: Record<string, number> = {};
  for (const line of readFileSync(proxyLog, "utf8").split("\n").filter(Boolean)) {
    const [, verdict, , hostPort] = line.split(" ");
    const key = `${verdict} ${hostPort}`;
    tally[key] = (tally[key] ?? 0) + 1;
  }
  console.info("[egress] proxy tally (verdict host:port, requests):");
  for (const [key, count] of Object.entries(tally).sort()) console.info(`  ${key}  x${count}`);
} finally {
  teardown();
}
