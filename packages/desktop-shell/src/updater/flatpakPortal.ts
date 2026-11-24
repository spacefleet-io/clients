/**
 * REL-UPD-07: the Flatpak copy of Badger or Parrot updates itself through Flatpak's own portal
 * (`org.freedesktop.portal.Flatpak`, flatpak ≥ 1.5, portal version ≥ 2), then starts its new version.
 *
 *  - `CreateUpdateMonitor` gives a monitor object; its `Update` returns at once and the portal reports through the
 *    monitor's `Progress` signal (`status` 0 running, 1 nothing to update, 2 done, 3 failed with `error` and
 *    `error_message`). The signal goes to the connection that created the monitor only, and the portal closes the
 *    monitor when that connection leaves, so one connection (dbus.ts) is held for the whole update.
 *  - The portal asks the user first ("Update Badger?", "The application wants to update itself.") unless they already
 *    allowed it; a refusal comes back as `org.freedesktop.DBus.Error.AccessDenied`. A version that would need more
 *    permissions than the installed one is refused (`NotSupported`): the user updates by hand then.
 *  - The running app keeps its own files (its commit stays mounted), so the new version starts in a new sandbox:
 *    `Spawn` with `FLATPAK_SPAWN_FLAGS_LATEST_VERSION` runs the newly installed commit. The portal starts it outside
 *    this sandbox, so it outlives this process; it waits until Electron's single-instance lock (`SingletonLock` in
 *    userData) is gone before starting the app's command, or a second instance would find this one and quit.
 */
import { connectSessionBus, DBusError, variant, type DBusConnection } from "./dbus";
import { NETWORK_FAILURE, type SystemUpdateOutcome } from "./systemPackage";
import type { SystemUpdateFailure } from "./types";

export const FLATPAK_PORTAL = {
  name: "org.freedesktop.portal.Flatpak",
  path: "/org/freedesktop/portal/Flatpak",
  interface: "org.freedesktop.portal.Flatpak",
  monitorInterface: "org.freedesktop.portal.Flatpak.UpdateMonitor",
} as const;

/** The portal version that has `CreateUpdateMonitor` (flatpak 1.5). */
export const FLATPAK_PORTAL_MIN_VERSION = 2;

/** `FLATPAK_SPAWN_FLAGS_LATEST_VERSION`: run the newest installed commit, not the one this sandbox runs. */
export const FLATPAK_SPAWN_LATEST_VERSION = 2;

/** `status` of the `Progress` signal. */
export const FLATPAK_UPDATE_STATUS = { running: 0, empty: 1, done: 2, failed: 3 } as const;

/** How long the relaunched copy waits for this one's single-instance lock to go, at most. */
export const FLATPAK_RELAUNCH_WAIT_S = 30;

/** One `Progress` signal: operation `op` of `nOps` at `progress` percent. */
export type FlatpakUpdateProgress = { op: number; nOps: number; progress: number; status: number };

export type FlatpakPortal = {
  /** The portal's version, 0 when it is not there (no portal, or no session bus). */
  version: () => Promise<number>;
  /** Installs the newest version of this Flatpak; `onProgress` gets every running step. */
  update: (onProgress: (progress: FlatpakUpdateProgress) => void) => Promise<SystemUpdateOutcome>;
  /** Starts `argv` in a new sandbox on the newest installed commit; resolves the new process's pid (host pid). */
  spawnLatest: (argv: readonly string[]) => Promise<number>;
};

/** Percent of the whole update from one `Progress` signal (operations are counted from 0). */
export const flatpakUpdatePercent = ({ op, nOps, progress }: FlatpakUpdateProgress): number =>
  nOps > 0 ? Math.max(0, Math.min(100, Math.round(((Math.min(op, nOps - 1) + progress / 100) / nOps) * 100))) : 0;

/** The outcome of a failed update from the portal's error name and message. */
export const flatpakFailure = (errorName: string, message: string): SystemUpdateOutcome => {
  if (errorName === "org.freedesktop.DBus.Error.AccessDenied") return { result: "dismissed" };
  const failure: SystemUpdateFailure = NETWORK_FAILURE.test(message) ? "network" : "other";
  return { result: "failed", failure, detail: message ? `${errorName}: ${message}` : errorName };
};

/**
 * The relaunch command: `sh` waits (at most `FLATPAK_RELAUNCH_WAIT_S`) for `lockPath` to go, then runs the Flatpak's
 * own command (`/app/bin/<command>`, the wrapper that starts Electron under zypak).
 */
export const flatpakRelaunchArgv = (command: string, lockPath: string): string[] => [
  "sh",
  "-c",
  `i=0; while [ -L "$1" ] && [ "$i" -lt ${FLATPAK_RELAUNCH_WAIT_S * 10} ]; do sleep 0.1; i=$((i + 1)); done; exec "/app/bin/$2"`,
  "sf-relaunch",
  lockPath,
  command,
];

/**
 * The Flatpak's command from its id: each manifest names its command after the last part of the id, lowercased
 * (`io.spacefleet.Badger` → `badger`, `io.spacefleet.Parrot` → `parrot`; a test reads both manifests).
 */
export const flatpakCommand = (flatpakId: string): string => flatpakId.slice(flatpakId.lastIndexOf(".") + 1).toLowerCase();

type Log = (fields: Record<string, unknown>, message: string) => void;

/** NUL-terminated bytes, as the portal reads its `ay` paths and arguments. */
const bytestring = (value: string): Buffer => Buffer.from(`${value}\0`, "utf8");

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const createFlatpakPortal = (deps: { log: Log; connect?: () => Promise<DBusConnection> }): FlatpakPortal => {
  const connect = deps.connect ?? (() => connectSessionBus());
  const { log } = deps;

  const version = async (): Promise<number> => {
    let bus: DBusConnection | null = null;
    try {
      bus = await connect();
      const [value] = await bus.call({
        destination: FLATPAK_PORTAL.name,
        path: FLATPAK_PORTAL.path,
        interface: "org.freedesktop.DBus.Properties",
        member: "Get",
        signature: "ss",
        body: [FLATPAK_PORTAL.interface, "version"],
      });
      return typeof value === "number" ? value : 0;
    } catch (err) {
      log({ message: errorText(err) }, "flatpak portal: version unreadable — no self update");
      return 0;
    } finally {
      bus?.close();
    }
  };

  const update = async (onProgress: (progress: FlatpakUpdateProgress) => void): Promise<SystemUpdateOutcome> => {
    let bus: DBusConnection;
    try {
      bus = await connect();
    } catch (err) {
      log({ message: errorText(err) }, "flatpak portal: session bus unreachable");
      return { result: "failed", failure: "other", detail: errorText(err) };
    }
    let handle: string | null = null;
    try {
      const token = `sf${process.pid}${Date.now().toString(36)}`;
      [handle] = (await bus.call({
        destination: FLATPAK_PORTAL.name,
        path: FLATPAK_PORTAL.path,
        interface: FLATPAK_PORTAL.interface,
        member: "CreateUpdateMonitor",
        signature: "a{sv}",
        body: [{ handle_token: variant("s", token) }],
      })) as [string];
      log({ handle, sender: bus.uniqueName }, "flatpak portal: update monitor created");
      const finished = Promise.withResolvers<SystemUpdateOutcome>();
      const monitorPath = handle;
      bus.onSignal((message) => {
        if (message.path !== monitorPath || message.interface !== FLATPAK_PORTAL.monitorInterface || message.member !== "Progress") return;
        const info = (message.body[0] ?? {}) as Record<string, unknown>;
        const num = (key: string): number => (typeof info[key] === "number" ? info[key] : 0);
        const progress = { op: num("op"), nOps: num("n_ops"), progress: num("progress"), status: num("status") };
        log({ ...progress, error: info.error ?? null }, "flatpak portal: progress");
        if (progress.status === FLATPAK_UPDATE_STATUS.running) onProgress(progress);
        else if (progress.status === FLATPAK_UPDATE_STATUS.done) finished.resolve({ result: "updated", before: null, after: null });
        else if (progress.status === FLATPAK_UPDATE_STATUS.empty) finished.resolve({ result: "failed", failure: "notNewer", detail: "" });
        else finished.resolve(flatpakFailure(String(info.error ?? "org.freedesktop.DBus.Error.Failed"), String(info.error_message ?? "")));
      });
      bus.onClose((reason) =>
        finished.resolve({ result: "failed", failure: "other", detail: `the session bus closed during the update${reason ? `: ${reason.message}` : ""}` }),
      );
      await bus.call({ destination: FLATPAK_PORTAL.name, path: handle, interface: FLATPAK_PORTAL.monitorInterface, member: "Update", signature: "sa{sv}", body: ["", {}] });
      log({ handle }, "flatpak portal: update started");
      return await finished.promise;
    } catch (err) {
      log({ message: errorText(err), handle }, "flatpak portal: update refused");
      return err instanceof DBusError ? flatpakFailure(err.dbusName, err.message) : { result: "failed", failure: "other", detail: errorText(err) };
    } finally {
      if (handle) {
        await bus
          .call({ destination: FLATPAK_PORTAL.name, path: handle, interface: FLATPAK_PORTAL.monitorInterface, member: "Close" })
          .catch((err: unknown) => log({ message: errorText(err), handle }, "flatpak portal: monitor close failed"));
      }
      bus.close();
    }
  };

  const spawnLatest = async (argv: readonly string[]): Promise<number> => {
    const bus = await connect();
    try {
      const [pid] = await bus.call({
        destination: FLATPAK_PORTAL.name,
        path: FLATPAK_PORTAL.path,
        interface: FLATPAK_PORTAL.interface,
        member: "Spawn",
        signature: "ayaaya{uh}a{ss}ua{sv}",
        body: [bytestring("/"), argv.map(bytestring), {}, {}, FLATPAK_SPAWN_LATEST_VERSION, {}],
      });
      log({ argv, pid }, "flatpak portal: newest version started");
      return Number(pid);
    } finally {
      bus.close();
    }
  };

  return { version, update, spawnLatest };
};
