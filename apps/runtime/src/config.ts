import { fileURLToPath } from "node:url";
import { join as joinPath } from "node:path";
import { getDesktopPlatform } from "@space/desktop-platform";

export const getRuntimeConfig = () => {
  const corsRaw = process.env.RUNTIME_ALLOWED_ORIGINS?.trim();
  const defaultSlicesRoot = fileURLToPath(new URL("../slices", import.meta.url));
  const runtimeDataDir = getDesktopPlatform().paths.runtimeDataDir(process.env);
  return {
    serviceName: "SpaceFleet Runtime",
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 3020),
    tokenTtlMs: Math.max(60_000, Number(process.env.RUNTIME_TOKEN_TTL_MS ?? 60 * 60 * 1000)),
    // Extra trusted browser origins, on top of the loopback and desktop-renderer
    // origins (requestGuard.ts). Empty by default; a bare "*" is never honoured.
    corsOrigins: (corsRaw?.split(",") ?? [])
      .map((entry) => entry.trim().replace(/\/+$/, ""))
      .filter((entry) => entry && entry !== "*"),
    eventRetention: Math.max(50, Number(process.env.RUNTIME_EVENT_RETENTION ?? 500)),
    runtimeApiVersion: process.env.RUNTIME_API_VERSION ?? "1",
    slicesRoot: process.env.RUNTIME_SLICES_DIR ?? defaultSlicesRoot,
    runtimeDataDir,
    runtimeEventsStorePath: joinPath(runtimeDataDir, "runtime_events.json"),
    runtimeJobsStorePath: joinPath(runtimeDataDir, "runtime_jobs.json"),
    // PLAT-WEB-06: web grants kept across restarts (token digests, no token, no key).
    runtimeToolGrantsStorePath: joinPath(runtimeDataDir, "runtime_tool_grants.json"),
    // Plaintext key file of builds before RT-SEC-05: read once, then shredded. Never written.
    legacyRuntimeKeysPath: joinPath(runtimeDataDir, "runtime_keys.json"),
    runtimeJobsWorkerIntervalMs: Math.max(250, Number(process.env.RUNTIME_JOBS_WORKER_INTERVAL_MS ?? 5_000)),
    shutdownGraceMs: Math.max(1_000, Number(process.env.RUNTIME_SHUTDOWN_GRACE_MS ?? 10_000)),
  };
};
