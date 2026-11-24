/**
 * REL-UPD-07: the Flatpak copy of Badger or Parrot updates itself through `org.freedesktop.portal.Flatpak`
 * (packages/desktop-shell/src/updater/flatpakPortal.ts). The session bus is faked through `DBusConnection`, except for
 * the relaunch script, which runs for real in `sh` against a temporary lock symlink.
 *
 * Diagnostic logging: every test prints `[flatpak-portal:<phase>]` lines with the calls the fake bus received.
 */
// @req REL-UPD-07[badger-desktop,parrot]
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DBusError, MESSAGE_TYPE, type DBusCall, type DBusConnection, type DBusMessage } from "../src/updater/dbus";
import {
  createFlatpakPortal,
  FLATPAK_PORTAL,
  FLATPAK_RELAUNCH_WAIT_S,
  FLATPAK_SPAWN_LATEST_VERSION,
  flatpakCommand,
  flatpakFailure,
  flatpakRelaunchArgv,
  flatpakUpdatePercent,
} from "../src/updater/flatpakPortal";

const SUITE = "flatpak-portal";
const MONITOR = "/org/freedesktop/portal/Flatpak/update_monitor/1_42/sf1";

type Answer = unknown[] | Error | ((bus: FakeBus) => unknown[]);

type FakeBus = DBusConnection & {
  calls: DBusCall[];
  closed: number;
  signal: (body: Record<string, unknown>, path?: string) => void;
  drop: (reason: Error | null) => void;
};

/** A fake session bus: `answers[member]` is the reply body, an error to reject with, or a function of the bus. */
const fakeBus = (answers: Record<string, Answer>): FakeBus => {
  const signalListeners = new Set<(message: DBusMessage) => void>();
  const closeListeners: ((reason: Error | null) => void)[] = [];
  const bus: FakeBus = {
    uniqueName: ":1.42",
    calls: [],
    closed: 0,
    call: async (call) => {
      bus.calls.push(call);
      const answer = answers[call.member] ?? [];
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(bus) : answer;
    },
    onSignal: (listener) => {
      signalListeners.add(listener);
      return () => signalListeners.delete(listener);
    },
    onClose: (listener) => closeListeners.push(listener),
    close: () => {
      bus.closed += 1;
    },
    signal: (body, path = MONITOR) => {
      const message: DBusMessage = {
        type: MESSAGE_TYPE.signal,
        flags: 0,
        serial: 1,
        path,
        interface: FLATPAK_PORTAL.monitorInterface,
        member: "Progress",
        signature: "a{sv}",
        body: [body],
      };
      for (const listener of signalListeners) listener(message);
    },
    drop: (reason) => {
      for (const listener of closeListeners) listener(reason);
    },
  };
  return bus;
};

const portalOn = (bus: FakeBus) => {
  const log = vi.fn((_fields: Record<string, unknown>, _message: string) => undefined);
  return { portal: createFlatpakPortal({ log, connect: async () => bus }), log };
};

/** Update answers that send `signals` (as `[path, body]` or a body of our monitor) right after Update replies. */
const updateSending = (...signals: (Record<string, unknown> | [string, Record<string, unknown>])[]): Record<string, Answer> => ({
  CreateUpdateMonitor: [MONITOR],
  Update: (bus) => {
    queueMicrotask(() => {
      for (const signal of signals) {
        if (Array.isArray(signal)) bus.signal(signal[1], signal[0]);
        else bus.signal(signal);
      }
    });
    return [];
  },
});

const members = (bus: FakeBus): string[] => bus.calls.map((c) => `${c.path === MONITOR ? "monitor." : ""}${c.member}`);

describe("Flatpak portal update (REL-UPD-07)", () => {
  it("creates a monitor, updates, reports each running step, ends updated and closes the monitor", async () => {
    const bus = fakeBus(
      updateSending(
        { op: 0, n_ops: 2, progress: 30, status: 0 },
        { op: 1, n_ops: 2, progress: 100, status: 0 },
        { op: 1, n_ops: 2, progress: 100, status: 2 },
      ),
    );
    const { portal } = portalOn(bus);
    const steps: unknown[] = [];
    const outcome = await portal.update((p) => steps.push(p));
    console.info(`[${SUITE}:update] ${JSON.stringify({ outcome, steps, calls: members(bus) })}`);
    expect(outcome).toEqual({ result: "updated", before: null, after: null });
    expect(steps).toEqual([
      { op: 0, nOps: 2, progress: 30, status: 0 },
      { op: 1, nOps: 2, progress: 100, status: 0 },
    ]);
    expect(members(bus)).toEqual(["CreateUpdateMonitor", "monitor.Update", "monitor.Close"]);
    const [create, update] = bus.calls;
    expect(create).toMatchObject({ destination: FLATPAK_PORTAL.name, path: FLATPAK_PORTAL.path, interface: FLATPAK_PORTAL.interface, signature: "a{sv}" });
    expect((create!.body![0] as Record<string, { signature: string; value: string }>).handle_token).toMatchObject({ signature: "s" });
    expect(update).toMatchObject({ interface: FLATPAK_PORTAL.monitorInterface, signature: "sa{sv}", body: ["", {}] });
    expect(bus.closed).toBe(1);
  });

  it("ignores Progress signals of other monitors", async () => {
    const bus = fakeBus(
      updateSending(
        ["/org/freedesktop/portal/Flatpak/update_monitor/1_42/other", { op: 0, n_ops: 1, progress: 99, status: 0 }],
        ["/org/freedesktop/portal/Flatpak/update_monitor/1_42/other", { status: 2 }],
        { op: 0, n_ops: 1, progress: 50, status: 0 },
        { status: 2 },
      ),
    );
    const steps: unknown[] = [];
    expect(await portalOn(bus).portal.update((p) => steps.push(p))).toMatchObject({ result: "updated" });
    expect(steps).toEqual([{ op: 0, nOps: 1, progress: 50, status: 0 }]);
  });

  it.each([
    ["nothing newer on the remote", { status: 1 }, { result: "failed", failure: "notNewer", detail: "" }],
    [
      "a network failure",
      { status: 3, error: "org.freedesktop.Flatpak.Error.Failed", error_message: "While pulling app/io.spacefleet.Badger: Could not resolve host" },
      { result: "failed", failure: "network" },
    ],
    [
      "new permissions",
      { status: 3, error: "org.freedesktop.portal.Error.NotAllowed", error_message: "Self update not supported, new version requires new permissions" },
      { result: "failed", failure: "other", detail: "org.freedesktop.portal.Error.NotAllowed: Self update not supported, new version requires new permissions" },
    ],
  ])("ends on %s", async (label, signal, expected) => {
    const bus = fakeBus(updateSending(signal));
    const { portal } = portalOn(bus);
    const outcome = await portal.update(() => undefined);
    console.info(`[${SUITE}:end:${label}] ${JSON.stringify(outcome)}`);
    expect(outcome).toMatchObject(expected);
    expect(members(bus).at(-1)).toBe("monitor.Close");
  });

  it("the user tapping Deny in Flatpak's question is a dismissal, not a failure", async () => {
    const bus = fakeBus({
      CreateUpdateMonitor: [MONITOR],
      Update: new DBusError("org.freedesktop.DBus.Error.AccessDenied", "Application update not allowed"),
    });
    const { portal } = portalOn(bus);
    const outcome = await portal.update(() => undefined);
    console.info(`[${SUITE}:deny] ${JSON.stringify({ outcome, calls: members(bus) })}`);
    expect(outcome).toEqual({ result: "dismissed" });
    expect(members(bus)).toEqual(["CreateUpdateMonitor", "monitor.Update", "monitor.Close"]);
    expect(bus.closed).toBe(1);
  });

  it("the bus going away mid-update is a failure with the reason", async () => {
    const bus = fakeBus({
      CreateUpdateMonitor: [MONITOR],
      Update: (b) => {
        queueMicrotask(() => b.drop(new Error("socket hang up")));
        return [];
      },
      Close: new Error("D-Bus connection closed"),
    });
    const { portal, log } = portalOn(bus);
    const outcome = await portal.update(() => undefined);
    console.info(`[${SUITE}:dropped] ${JSON.stringify(outcome)}`);
    expect(outcome).toEqual({ result: "failed", failure: "other", detail: "the session bus closed during the update: socket hang up" });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ handle: MONITOR }), "flatpak portal: monitor close failed");
  });

  it("no session bus: a failure, no monitor", async () => {
    const log = vi.fn();
    const portal = createFlatpakPortal({ log, connect: async () => Promise.reject(new Error("DBUS_SESSION_BUS_ADDRESS is not set")) });
    expect(await portal.update(() => undefined)).toEqual({ result: "failed", failure: "other", detail: "DBUS_SESSION_BUS_ADDRESS is not set" });
    expect(await portal.version()).toBe(0);
  });

  it("version reads the portal's version property, 0 when the portal is missing", async () => {
    const present = fakeBus({ Get: [8] });
    expect(await portalOn(present).portal.version()).toBe(8);
    expect(present.calls[0]).toMatchObject({ interface: "org.freedesktop.DBus.Properties", member: "Get", signature: "ss", body: [FLATPAK_PORTAL.interface, "version"] });
    expect(present.closed).toBe(1);
    const missing = fakeBus({ Get: new DBusError("org.freedesktop.DBus.Error.ServiceUnknown", "The name is not activatable") });
    expect(await portalOn(missing).portal.version()).toBe(0);
    expect(missing.closed).toBe(1);
  });

  it("spawnLatest starts the argv on the newest commit (NUL-terminated bytes, flag 2) and returns its pid", async () => {
    const bus = fakeBus({ Spawn: [4242] });
    const pid = await portalOn(bus).portal.spawnLatest(["sh", "-c", "true"]);
    const [call] = bus.calls;
    console.info(`[${SUITE}:spawn] ${JSON.stringify({ pid, signature: call?.signature, flags: call?.body?.[4] })}`);
    expect(pid).toBe(4242);
    expect(call).toMatchObject({ member: "Spawn", signature: "ayaaya{uh}a{ss}ua{sv}", path: FLATPAK_PORTAL.path });
    const [cwd, argv, fds, env, flags, options] = call!.body!;
    expect(cwd).toEqual(Buffer.from("/\0"));
    expect(argv).toEqual([Buffer.from("sh\0"), Buffer.from("-c\0"), Buffer.from("true\0")]);
    expect([fds, env, options]).toEqual([{}, {}, {}]);
    expect(flags).toBe(FLATPAK_SPAWN_LATEST_VERSION);
    expect(FLATPAK_SPAWN_LATEST_VERSION).toBe(2);
    expect(bus.closed).toBe(1);
    const failing = fakeBus({ Spawn: new DBusError("org.freedesktop.DBus.Error.Failed", "no") });
    await expect(portalOn(failing).portal.spawnLatest(["x"])).rejects.toThrow("no");
    expect(failing.closed).toBe(1);
  });
});

describe("Flatpak portal helpers (REL-UPD-07)", () => {
  it("percent of the whole update across operations", () => {
    const cases = [
      flatpakUpdatePercent({ op: 0, nOps: 1, progress: 0, status: 0 }),
      flatpakUpdatePercent({ op: 0, nOps: 1, progress: 55, status: 0 }),
      flatpakUpdatePercent({ op: 0, nOps: 2, progress: 50, status: 0 }),
      flatpakUpdatePercent({ op: 1, nOps: 2, progress: 100, status: 0 }),
      flatpakUpdatePercent({ op: 5, nOps: 2, progress: 100, status: 0 }),
      flatpakUpdatePercent({ op: 0, nOps: 0, progress: 50, status: 0 }),
    ];
    expect(cases).toEqual([0, 55, 25, 100, 100, 0]);
  });

  it("failure names: Deny dismisses; a network message is network; anything else is other", () => {
    expect(flatpakFailure("org.freedesktop.DBus.Error.AccessDenied", "Application update not allowed")).toEqual({ result: "dismissed" });
    expect(flatpakFailure("org.freedesktop.Flatpak.Error.Failed", "Could not resolve host: dl.flathub.org")).toMatchObject({ failure: "network" });
    expect(flatpakFailure("org.freedesktop.Flatpak.Error.AlreadyInstalling", "")).toEqual({
      result: "failed",
      failure: "other",
      detail: "org.freedesktop.Flatpak.Error.AlreadyInstalling",
    });
  });

  it("the command is the one each Flatpak manifest declares", () => {
    const root = resolve(__dirname, "../../../packaging/flatpak");
    for (const id of ["io.spacefleet.Badger", "io.spacefleet.Parrot"]) {
      const manifest = readFileSync(join(root, id, `${id}.yml`), "utf8");
      const declared = /^command:\s*(\S+)\s*$/m.exec(manifest)?.[1];
      console.info(`[${SUITE}:manifest] ${id} command=${declared} derived=${flatpakCommand(id)}`);
      expect(declared).toBe(flatpakCommand(id));
    }
  });

  it("the relaunch waits for the single-instance lock to go, then starts the command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-flatpak-relaunch-"));
    try {
      const lock = join(dir, "SingletonLock");
      const marker = join(dir, "started");
      symlinkSync("host-1234", lock);
      writeFileSync(join(dir, "badger"), `#!/bin/sh\necho "started $*" > "${marker}"\n`, { mode: 0o755 });
      const argv = flatpakRelaunchArgv("badger", lock);
      expect(argv[0]).toBe("sh");
      expect(argv.slice(3)).toEqual(["sf-relaunch", lock, "badger"]);
      expect(argv[2]).toContain('exec "/app/bin/$2"');
      expect(argv[2]).toContain(`-lt ${FLATPAK_RELAUNCH_WAIT_S * 10} ]`);
      // Run the real script with /app/bin pointed at the temporary folder.
      const script = argv[2]!.replace('"/app/bin/$2"', `"${dir}/$2"`);
      const child = spawn(argv[0]!, [argv[1]!, script, ...argv.slice(3)], { stdio: "ignore" });
      const exited = new Promise<number | null>((r) => child.on("exit", r));
      // A real delay on purpose: the script polls the real filesystem every 0.1 s, which fake timers can't drive.
      await new Promise((r) => setTimeout(r, 300));
      const startedWhileLocked = existsSync(marker);
      unlinkSync(lock);
      const code = await exited;
      const started = readFileSync(marker, "utf8").trim();
      console.info(`[${SUITE}:relaunch] ${JSON.stringify({ startedWhileLocked, code, started })}`);
      expect(startedWhileLocked).toBe(false);
      expect(code).toBe(0);
      expect(started).toBe("started");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
