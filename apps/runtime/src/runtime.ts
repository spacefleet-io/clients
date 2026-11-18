import { getRuntimeConfig } from "./config";
import { RuntimeState } from "./state";
import { LifecycleManager } from "./lifecycle";
import { runtimeJobEngine } from "./core/jobs/engine";
import { runtimeJobsStore } from "./core/jobs/store";
import { runtimeJobWorker } from "./core/jobs/worker";
import { runtimeKeyStore } from "./core/keys/store";
import { getBadgerActiveUserId, onKeySet, reconcileActiveRuntimeJobsFromModules, setBadgerLibraryClosedListener } from "./modules";
import { OwnerLoginGate } from "./core/ownerSecret";
import { ToolAccessManager } from "./core/toolAccess";
import { fileToolGrantStore } from "./core/toolGrantStore";
import { DesktopHandoffManager } from "./core/desktopHandoff";
import {
  DESKTOP_HANDOFF_CHANNEL,
  DESKTOP_HANDOFF_PLAY_EVENT,
  TOOL_ACCESS_CHANNEL,
  TOOL_ACCESS_EVENT,
} from "@space/tool-access/contracts";

/**
 * Who may log in (RT-SEC-05). One secret per process, fresh at every start;
 * index.ts publishes it to `<data dir>/owner.secret` right after it binds the port.
 */
export const ownerLoginGate = new OwnerLoginGate();

const config = getRuntimeConfig();
runtimeJobsStore.configurePersistence(config.runtimeJobsStorePath);
// RT-SEC-05: keys live in memory only. A plaintext `runtime_keys.json` left by
// an older build is read once into memory and then overwritten and deleted; the
// apps push the key again whenever the runtime becomes ready.
const legacyKeys = runtimeKeyStore.migrateLegacyPlaintextFile(config.legacyRuntimeKeysPath);
if (legacyKeys.found) {
  const level = legacyKeys.removed ? "info" : "error";
  console[level](
    legacyKeys.removed
      ? `[runtime] moved ${legacyKeys.loaded} key(s) from the plaintext runtime_keys.json into memory and deleted the file`
      : "[runtime] plaintext runtime_keys.json could NOT be deleted; remove it by hand",
    { loaded: legacyKeys.loaded, overwritten: legacyKeys.overwritten, removed: legacyKeys.removed }
  );
}
// Re-apply the migrated keys (if any) to modules so they're initialized on
// startup (the store itself is memory-only; modules need explicit keying). Pass
// `source: "replay"` so onKeySet does NOT stamp `badgerModule.backendUserId`
// from the last persisted entry — the persisted store can hold multiple
// users (including leftover E2E fixtures), and the last-write-wins behaviour
// silently impersonated the wrong user for post-ingest fallbacks. See the
// `all-newly-added-jobs-cuddly-cookie` plan, Bug A.
for (const entry of runtimeKeyStore.entries()) {
  try {
    onKeySet(entry.userId, entry.masterKeyBase64, undefined, "replay");
  } catch (err) {
    console.warn("[runtime] startup key reapplication failed for user", entry.userId, err);
  }
}
export const runtimeState = new RuntimeState(
  config.tokenTtlMs,
  config.eventRetention,
  config.runtimeApiVersion,
  config.slicesRoot
);
runtimeState.configureEventPersistence(config.runtimeEventsStorePath);

/**
 * PLAT-WEB-04: playback the web player hands to the Badger desktop player. A
 * desktop player is there when a first-party app session (badger scope)
 * listens on `badger.handoff`, the way the desktop main process does.
 */
// `publish` scopes an app channel itself (`handoff` -> `badger.handoff`), so it gets the unscoped names.
const BADGER_SCOPE_PREFIX = "badger.";
export const desktopHandoff = new DesktopHandoffManager({
  hasDesktopPlayer: () => runtimeState.countAppSubscribers("badger", DESKTOP_HANDOFF_CHANNEL) > 0,
  publishPlay: (payload) => {
    runtimeState.publish(
      "badger",
      DESKTOP_HANDOFF_CHANNEL.slice(BADGER_SCOPE_PREFIX.length),
      DESKTOP_HANDOFF_PLAY_EVENT.slice(BADGER_SCOPE_PREFIX.length),
      payload
    );
  },
});
runtimeState.onResetForTests(() => desktopHandoff.reset());

/**
 * DEV-LIB-01: grants for third-party tools. A request needs an app that is
 * listening for the prompt: a first-party app session subscribed to the
 * `runtime.access` channel (the desktop main process forwards it to its UI).
 */
export const toolAccess = new ToolAccessManager({
  state: runtimeState,
  activeUserId: getBadgerActiveUserId,
  hasPromptReceiver: () => runtimeState.countAppSubscribers("badger", TOOL_ACCESS_CHANNEL) > 0,
  publish: (snapshot) => {
    runtimeState.publish("badger", TOOL_ACCESS_CHANNEL, TOOL_ACCESS_EVENT, snapshot);
  },
  // A grant that ends takes its unfinished desktop hand-offs with it.
  onGrantEnded: (grantId) => {
    desktopHandoff.closeForGrant(grantId);
  },
  // PLAT-WEB-06: web grants survive a restart.
  store: fileToolGrantStore(config.runtimeToolGrantsStorePath),
});
runtimeState.onResetForTests(() => toolAccess.reset());
// A grant is for one signed-in library: sign-out or a close ends every grant. The runtime stopping
// ends only the time-limited ones; web grants wait in the store for the next start (PLAT-WEB-06).
setBadgerLibraryClosedListener((reason) => {
  if (reason === "shutdown") toolAccess.revokeTimeLimited();
  else toolAccess.revokeAll();
});

// Shutdown is bound by index.ts (`lifecycleManager.bindShutdown`) so an
// orphaned runtime drains through the same path as SIGTERM (#25).
export const lifecycleManager = new LifecycleManager({
  shutdownGraceMs: config.shutdownGraceMs,
  publishEvent: (app, channel, event, payload) => {
    runtimeState.publish(app, channel, event, payload);
  },
});

lifecycleManager.startConnectionSweep(runtimeState);

runtimeJobEngine.setEventPublisher(({ app, channel, event, payload }) => {
  runtimeState.publish(app, channel, event, payload);
});

type BootstrapRuntimeJobsOptions = {
  startWorker?: boolean;
  startWorkerFn?: () => void;
  kickWorkerFn?: () => void | Promise<unknown>;
};

export const bootstrapRuntimeJobs = (options: BootstrapRuntimeJobsOptions = {}) => {
  const recovered = runtimeJobEngine.recoverInterruptedJobs();
  const hasQueuedJobs =
    runtimeJobsStore.list({
      includeCompleted: true,
      status: ["queued"],
    }).length > 0;
  const shouldKick = recovered.length > 0 || hasQueuedJobs;

  if (options.startWorker ?? !process.env.VITEST) {
    (options.startWorkerFn ?? (() => runtimeJobWorker.start()))();
  }
  if (shouldKick) {
    void (options.kickWorkerFn ?? (() => runtimeJobWorker.kick()))();
  }

  return {
    recovered,
    kicked: shouldKick,
  };
};

if (!process.env.VITEST) {
  runtimeJobWorker.setIntervalMs(config.runtimeJobsWorkerIntervalMs);
}
runtimeJobWorker.setBeforeDrain(() => reconcileActiveRuntimeJobsFromModules());
bootstrapRuntimeJobs();
