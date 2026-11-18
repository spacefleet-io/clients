// Pre-flight check for integration / E2E tests.
//
// Verifies the host has everything the desktop test suites need:
//   1. Bundled binaries (ffmpeg, ffprobe, mpv) under vendor/deps/<os>-<arch>/
//      — gitignored, populated by `bun scripts/fetch-deps.ts`. Fresh
//      clones, git worktrees, and CI runners come up empty.
//   2. Docker daemon — E2E suites spin Compose stacks (Postgres, Redis,
//      Mailpit). If the daemon is down, every test fails late at
//      `docker compose up --wait` with a confusing exit-1 instead of the
//      true root cause.
//
// Without this check, the desktop main process would only log a "missing
// required bundled binaries" error (`src/main/missing-binaries.ts`) and keep
// starting, so playback tests would fail late, or the harness would burn 30+
// seconds before reporting Docker is down.
// This script makes both dependencies explicit and fails fast at the suite
// boundary instead of at downstream assertions.
//
// Set SF_SKIP_DOCKER_PREFLIGHT=1 if you have a custom Docker setup or are
// running only unit-level integration tests that don't touch Compose.

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..");

// The bundle is fetched for the host (vendor/deps/<os>-<arch>/, sha256-verified, cached in
// ~/.cache/spacefleet/deps). An already-fetched bundle is a no-network no-op.
const fetched = spawnSync("bun", [join(repoRoot, "scripts", "fetch-deps.ts")], { cwd: repoRoot, stdio: "inherit" });
if (fetched.status !== 0) {
  process.stderr.write(`[ensure-test-binaries] scripts/fetch-deps.ts exited ${fetched.status ?? "by signal"}\n`);
  process.exit(fetched.status ?? 1);
}
process.stdout.write("[ensure-test-binaries] bundled binaries ready\n");

// ---------------------------------------------------------------------------
// Docker daemon check
// ---------------------------------------------------------------------------

const skipDocker = String(process.env.SF_SKIP_DOCKER_PREFLIGHT ?? "").toLowerCase();
if (skipDocker === "1" || skipDocker === "true" || skipDocker === "yes") {
  process.stdout.write("[ensure-test-binaries] SF_SKIP_DOCKER_PREFLIGHT set — skipping Docker check\n");
  process.exit(0);
}

const dockerProbe = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
  stdio: ["ignore", "pipe", "pipe"],
  encoding: "utf8",
});

if (dockerProbe.error && dockerProbe.error.code === "ENOENT") {
  process.stderr.write(
    "[ensure-test-binaries] docker CLI not found in PATH. Install Docker or set SF_SKIP_DOCKER_PREFLIGHT=1 to bypass.\n"
  );
  process.exit(1);
}

if (dockerProbe.status !== 0) {
  process.stderr.write(
    "[ensure-test-binaries] docker daemon is not responding to `docker info`.\n" +
      "  - On Linux: systemctl --user start docker-desktop  OR  sudo systemctl start docker\n" +
      "  - On macOS/Windows: open Docker Desktop\n" +
      "  - To bypass for unit-level integration tests: SF_SKIP_DOCKER_PREFLIGHT=1\n"
  );
  if (dockerProbe.stderr) {
    process.stderr.write(`[ensure-test-binaries] docker stderr: ${dockerProbe.stderr.trim()}\n`);
  }
  process.exit(1);
}

const composeProbe = spawnSync("docker", ["compose", "version", "--short"], {
  stdio: ["ignore", "pipe", "pipe"],
  encoding: "utf8",
});

if (composeProbe.status !== 0) {
  process.stderr.write(
    "[ensure-test-binaries] docker compose plugin missing. Install via `apt install docker-compose-plugin` " +
      "or upgrade Docker Desktop. Set SF_SKIP_DOCKER_PREFLIGHT=1 to bypass.\n"
  );
  process.exit(1);
}

process.stdout.write(
  `[ensure-test-binaries] docker daemon ok (server ${dockerProbe.stdout.trim()}, compose ${composeProbe.stdout.trim()})\n`
);
