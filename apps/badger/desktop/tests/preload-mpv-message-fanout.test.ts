// @bugfix @regression-proof: "MaxListenersExceededWarning: 11 sf-mpv-external-message listeners added"
// (Chris, 2026-11-09). The player stack legitimately holds up to ~11 subscribers; each one used to
// add its own ipcRenderer listener. They now share one through createIpcFanout.
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { createIpcFanout } from "../src/preload/ipcFanout";

const TID = "DESKTOP-PRELOAD-MPV-FANOUT-001";
const CHANNEL = "sf-mpv-external-message";
const log = (...args: unknown[]) => console.log(`[${TID}]`, ...args);

describe(TID, () => {
  const warnings: Error[] = [];
  const onWarning = (w: Error) => warnings.push(w);
  afterEach(() => {
    process.off("warning", onWarning);
    warnings.length = 0;
  });

  it("keeps one ipc listener for 12 subscribers across repeated mount/unmount, and delivers to all", async () => {
    process.on("warning", onWarning);
    const ipc = new EventEmitter(); // default maxListeners = 10, like ipcRenderer
    const subscribe = createIpcFanout<{ type: string }>(ipc as never, CHANNEL);
    for (let round = 1; round <= 5; round++) {
      const got: string[] = [];
      const unsubs = Array.from({ length: 12 }, (_, i) => subscribe((m) => got.push(`${i}:${m.type}`)));
      log(`round ${round}: subscribers=12 ipcListeners=${ipc.listenerCount(CHANNEL)}`);
      expect(ipc.listenerCount(CHANNEL)).toBe(1);
      ipc.emit(CHANNEL, {}, { type: "exit" });
      expect(got).toHaveLength(12);
      unsubs.forEach((u) => u());
      unsubs.forEach((u) => u()); // double unsubscribe is harmless
      log(`round ${round}: after unmount ipcListeners=${ipc.listenerCount(CHANNEL)}`);
      expect(ipc.listenerCount(CHANNEL)).toBe(0);
    }
    await new Promise((r) => setImmediate(r)); // warnings are emitted on next tick
    log(`warnings=${JSON.stringify(warnings.map((w) => w.name))}`);
    expect(warnings.filter((w) => w.name === "MaxListenersExceededWarning")).toEqual([]);
  });

  it("isolates a throwing subscriber and tolerates unsubscribe during dispatch", () => {
    const ipc = new EventEmitter();
    const subscribe = createIpcFanout<{ type: string }>(ipc as never, CHANNEL);
    const got: string[] = [];
    const unsubA = subscribe(() => {
      unsubA();
      throw new Error("boom");
    });
    subscribe((m) => got.push(m.type));
    ipc.emit(CHANNEL, {}, { type: "osc_action" });
    ipc.emit(CHANNEL, {}, { type: "exit" });
    log(`delivered=${JSON.stringify(got)} ipcListeners=${ipc.listenerCount(CHANNEL)}`);
    expect(got).toEqual(["osc_action", "exit"]);
    expect(ipc.listenerCount(CHANNEL)).toBe(1);
  });
});
