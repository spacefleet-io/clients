/**
 * The Badger Jellyfin sidecar: the local decrypting service the Jellyfin plugin supervises
 * (INTG-JF-04). Library sync, SFV1 decryption and HLS streaming live here; the plugin stays thin.
 *
 *   HEADLESS_API_URL=https://api.spacefleet.io HEADLESS_LIBRARY_KEY_FILE=/path/key \
 *   HEADLESS_EMAIL=.. HEADLESS_PASSWORD=.. bun run src/main.ts
 *
 * Listens on 127.0.0.1 only (INTG-JF-03). Routes: see server.ts (`/integration/v1/*`).
 */
import { setLibraryTunnelMode } from "@space/library-db-runtime/api";
import { registerBunSqlite } from "@space/library-db-runtime/bunSqlite";
import { childLogger, createLogger } from "@space/logger";
import { loadIntegrationConfig } from "./config";
import { IntegrationRuntime } from "./runtime";
import { handleIntegrationRequest } from "./server";

// `bun build --compile` cannot resolve the lazy sqlite requires; hand over the bundled bun:sqlite driver.
registerBunSqlite();
// This service runs on a server, not next to the gateway: try every shard address, then gatewayUrl (no API fallback).
setLibraryTunnelMode("waterfall");

const logger = childLogger(createLogger({ service: "headless-integration" }), { scope: "integration" });
const log = (message: string, meta?: Record<string, unknown>) => {
  if (meta) logger.info(meta, message);
  else logger.info(message);
};

const config = loadIntegrationConfig(process.env);
if (process.argv.includes("--version")) {
  // Used by the plugin and the release checks to prove a downloaded binary starts (INTG-JF-04).
  console.log(`badger-integration ${config.version} ${process.platform}-${process.arch}`);
  process.exit(0);
}
const runtime = new IntegrationRuntime(config, log);
const deps = runtime.buildDeps();

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  idleTimeout: 120,
  fetch: (req) => handleIntegrationRequest(req, deps),
});

log("integration service listening", {
  url: `http://${config.host}:${server.port}/integration/v1`,
  apiUrl: config.apiUrl,
  stateDir: config.stateDir,
  clientType: config.clientType,
  keyFile: config.libraryKeyFile,
  version: config.version,
});

// Opened before the runtime starts (#934): the first tick logs in, picks the profile and downloads + decrypts the
// library snapshot, which takes seconds on a low-end host. Meanwhile /status answers `starting` and the routes that
// need the session or the library answer 503 (server.ts). A start failure still ends the process, as before, so
// the plugin's supervisor restarts it with backoff.
const startedAt = Date.now();
runtime.start().then(
  () => log("integration runtime started", { ms: Date.now() - startedAt, state: runtime.status().state }),
  (error: unknown) => {
    logger.error({ error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null }, "integration runtime start failed");
    server.stop(true);
    process.exit(1);
  }
);

const shutdown = async (signal: string) => {
  log("integration service stopping", { signal });
  server.stop(true);
  await runtime.stop();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
