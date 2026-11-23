/**
 * @req PAR-PL-05[parrot] @bugfix @regression-proof
 * WinGate6 2026-11-13 (Parrot Windows 0.1.2 gate): playlists.e2e made 6 playlist edits then quit; the window showed
 * them at once, but main saves them one after another and `before-quit` never waited, so the edits still queued at
 * quit were dropped with no error (the like and the removal were gone after the relaunch, 6 of 7 runs on Windows).
 * The quit now holds while saves are queued (`createQuitGuard`), with a bounded wait.
 *
 * The guard runs against a fake Electron `app` that replays Electron's quit order: `quit()` emits `before-quit`, and
 * the process exits unless a listener called `preventDefault`. Each save is a fake slow save on the real chain: it
 * waits for the test to finish it, so no test depends on wall-clock time (the timeout test drives fake timers).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQuitGuard, createSaveChain, flushPendingWrites, QUIT_SAVE_TIMEOUT_MS, type SaveChain } from "../src/main/saveChain";

const TAG = "[quit-saves]";

type QuitEvent = { preventDefault(): void };

/** Electron's quit, as far as the guard sees it. `exited` resolves with what was saved when the process ended. */
const fakeElectron = (saved: string[]) => {
  const beforeQuit: ((event: QuitEvent) => void)[] = [];
  const history: string[] = [];
  const { promise: exited, resolve: exit } = Promise.withResolvers<string[]>();
  let exitedWith: string[] | null = null;
  const app = {
    on: (_event: "before-quit", listener: (event: QuitEvent) => void) => void beforeQuit.push(listener),
    quit: () => {
      if (exitedWith) return;
      let prevented = false;
      history.push(`quit() with saved=${JSON.stringify(saved)}`);
      for (const listener of beforeQuit) listener({ preventDefault: () => (prevented = true) });
      if (prevented) {
        history.push("before-quit prevented");
        return;
      }
      exitedWith = [...saved];
      history.push(`exited with saved=${JSON.stringify(exitedWith)}`);
      exit(exitedWith);
    },
  };
  return { app, history, exited, exitedWith: () => exitedWith };
};

const harness = (opts: { timeoutMs?: number } = {}) => {
  const saved: string[] = [];
  const lines: string[] = [];
  const library = createSaveChain();
  const settings = createSaveChain();
  const electron = fakeElectron(saved);
  const calls = { onWait: 0, onQuit: 0 };
  const guard = createQuitGuard({
    app: electron.app,
    writes: [
      { name: "library", chain: library },
      { name: "settings", chain: settings },
    ],
    timeoutMs: opts.timeoutMs ?? 5_000,
    onWait: () => {
      calls.onWait += 1;
    },
    onQuit: () => {
      calls.onQuit += 1;
    },
    log: (line) => lines.push(`log ${line}`),
    fail: (line) => lines.push(`fail ${line}`),
  });
  electron.app.on("before-quit", (event) => guard.beforeQuit(event));
  /** A slow save (one encrypted library publish): it ends when the test calls `finish`. */
  const slowSave = (chain: SaveChain, name: string, edits = 1) => {
    const { promise: gate, resolve: finish } = Promise.withResolvers<void>();
    const done = chain.run(async () => {
      lines.push(`save ${name} started`);
      await gate;
      saved.push(name);
      lines.push(`save ${name} done`);
      return name;
    }, edits);
    return { finish, done };
  };
  const dump = (label: string) =>
    console.info(
      `${TAG} ${label}\n${JSON.stringify({ saved, calls, pending: { library: library.pending(), settings: settings.pending() }, exited: electron.exitedWith() }, null, 2)}\n${TAG} history:\n  ${electron.history.join("\n  ")}\n${TAG} lines:\n  ${lines.join("\n  ")}`,
    );
  return { saved, lines, library, settings, electron, calls, guard, slowSave, dump };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("PAR-PL-05: a quit waits for the edits still being saved", () => {
  it("the chain runs saves one at a time in order and counts the edits not settled yet, failed saves included", async () => {
    const chain = createSaveChain();
    const order: string[] = [];
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();
    const first = chain.run(async () => {
      await gate;
      order.push("first");
      throw new Error("refused");
    }, 2);
    const second = chain.run(async () => {
      order.push("second");
      return "ok";
    }, 3);
    console.info(`${TAG} chain pending right after queuing: ${chain.pending()}`);
    expect(chain.pending()).toBe(5);
    expect(order).toEqual([]);
    open();
    await expect(first).rejects.toThrow("refused");
    await expect(second).resolves.toBe("ok");
    await chain.idle();
    console.info(`${TAG} chain order=${JSON.stringify(order)} pending=${chain.pending()}`);
    expect(order).toEqual(["first", "second"]);
    expect(chain.pending()).toBe(0);
  });

  it("6 playlist edits saved one after another: the quit holds until the last one is saved (the WinGate6 failure)", async () => {
    const h = harness();
    // The e2e's edits: create, add x3, like, remove; each one publish.
    const names = ["create", "add Lantern", "add Gale", "add Harbour", "like Harbour", "remove Gale"];
    const saves = names.map((name) => h.slowSave(h.library, name));
    console.info(`${TAG} quitting with ${h.library.pending()} edit(s) queued`);
    h.electron.app.quit();
    h.dump("right after quit()");
    // Before the fix the process ended here, with nothing saved.
    expect(h.electron.exitedWith()).toBeNull();
    // The first three are saved; the quit still holds for the like and the removal.
    for (const save of saves.slice(0, 3)) save.finish();
    await saves[2]!.done;
    h.dump("three saved");
    expect(h.saved).toEqual(names.slice(0, 3));
    expect(h.library.pending()).toBe(3);
    expect(h.electron.exitedWith()).toBeNull();
    for (const save of saves.slice(3)) save.finish();
    const exitedWith = await h.electron.exited;
    h.dump("after exit");
    expect(exitedWith).toEqual(names);
    expect(h.calls).toEqual({ onWait: 1, onQuit: 1 });
    expect(h.lines).toContain("log [quit] quit: waiting for 6 unsaved edit(s) (library: 6), up to 5 s");
    expect(h.lines.some((line) => /^log \[quit\] quit: every edit saved in \d+ ms$/.test(line))).toBe(true);
  });

  it("settings writes count too, and a save queued during the wait is waited for", async () => {
    const h = harness();
    const remove = h.slowSave(h.library, "remove Gale");
    const language = h.slowSave(h.settings, "language fr");
    h.electron.app.quit();
    // An edit the window sent just before it was hidden reaches main during the wait.
    const like = h.slowSave(h.library, "like Harbour");
    // Quit pressed again meanwhile (Cmd+Q twice): still one wait, one exit.
    h.electron.app.quit();
    remove.finish();
    language.finish();
    await remove.done;
    await language.done;
    h.dump("before the late like is saved");
    expect(h.electron.exitedWith()).toBeNull();
    like.finish();
    const exitedWith = await h.electron.exited;
    h.dump("after exit");
    expect([...exitedWith].sort()).toEqual(["language fr", "like Harbour", "remove Gale"]);
    expect(h.calls).toEqual({ onWait: 1, onQuit: 1 });
    expect(h.lines).toContain("log [quit] quit: waiting for 2 unsaved edit(s) (library: 1, settings: 1), up to 5 s");
  });

  it("nothing queued: the quit goes through at once with the usual cleanup", () => {
    const h = harness();
    h.electron.app.quit();
    h.dump("after quit()");
    expect(h.electron.exitedWith()).toEqual([]);
    expect(h.calls).toEqual({ onWait: 0, onQuit: 1 });
  });

  it("a save that never ends: the quit gives up after the timeout and logs how many edits were not saved", async () => {
    vi.useFakeTimers();
    const h = harness({ timeoutMs: 30_000 });
    h.slowSave(h.library, "hung publish", 4);
    h.electron.app.quit();
    await vi.advanceTimersByTimeAsync(29_999);
    h.dump("1 ms before the timeout");
    expect(h.electron.exitedWith()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    const exitedWith = await h.electron.exited;
    h.dump("after exit");
    expect(exitedWith).toEqual([]);
    expect(h.lines).toContain("fail [quit] quit: gave up after 30 s, 4 edit(s) not saved (library: 4)");
    expect(h.calls).toEqual({ onWait: 1, onQuit: 1 });
  });

  it("a session ending (Windows log-off, shutdown) is held while edits are queued, then Parrot quits", async () => {
    const h = harness();
    const like = h.slowSave(h.library, "like Harbour");
    let held = false;
    h.guard.sessionEnding({ preventDefault: () => (held = true) }, "Windows session end");
    h.dump("after query-session-end");
    expect(held).toBe(true);
    expect(h.electron.exitedWith()).toBeNull();
    like.finish();
    expect(await h.electron.exited).toEqual(["like Harbour"]);
    expect(h.lines).toContain("log [quit] Windows session end: waiting for 1 unsaved edit(s) (library: 1), up to 5 s");

    const idle = harness();
    let idleHeld = false;
    idle.guard.sessionEnding({ preventDefault: () => (idleHeld = true) }, "system shutdown");
    expect(idleHeld).toBe(false);
  });

  it("the update restart saves first and changes nothing else; its quit then goes through with the usual cleanup", async () => {
    const h = harness();
    const remove = h.slowSave(h.library, "remove Gale");
    const saving = h.guard.saveNow("restart to update");
    remove.finish();
    expect(await saving).toBe(true);
    expect(h.saved).toEqual(["remove Gale"]);
    // Nothing hidden, muted or stopped: the install has not started yet.
    expect(h.calls).toEqual({ onWait: 0, onQuit: 0 });
    h.electron.app.quit();
    h.dump("after the update's quit()");
    expect(h.electron.exitedWith()).toEqual(["remove Gale"]);
    expect(h.calls).toEqual({ onWait: 0, onQuit: 1 });
  });

  it("an update install that fails without quitting (cancelled pkexec, failed dpkg) leaves Parrot usable and a later quit still waits", async () => {
    const h = harness();
    const remove = h.slowSave(h.library, "remove Gale");
    const saving = h.guard.saveNow("restart to update");
    remove.finish();
    expect(await saving).toBe(true);
    // quitAndInstall returned without quitting: no quit() came. The window, tray and lookups were never touched.
    h.dump("after the failed install");
    expect(h.calls).toEqual({ onWait: 0, onQuit: 0 });
    expect(h.electron.exitedWith()).toBeNull();
    // The user keeps working, then quits right after a heart: that save is still waited for.
    const like = h.slowSave(h.library, "like Harbour");
    h.electron.app.quit();
    h.dump("quit after the failed install");
    expect(h.electron.exitedWith()).toBeNull();
    expect(h.calls).toEqual({ onWait: 1, onQuit: 0 });
    like.finish();
    expect(await h.electron.exited).toEqual(["remove Gale", "like Harbour"]);
    expect(h.calls).toEqual({ onWait: 1, onQuit: 1 });
    expect(h.lines).toContain("log [quit] quit: waiting for 1 unsaved edit(s) (library: 1), up to 5 s");
  });

  it("flushPendingWrites with nothing queued answers at once; the real timeout is 30 s", async () => {
    const lines: string[] = [];
    const done = await flushPendingWrites({ writes: [{ name: "library", chain: createSaveChain() }], timeoutMs: 10, reason: "quit", log: (l) => lines.push(l), fail: (l) => lines.push(l) });
    console.info(`${TAG} empty flush: ${done} ${JSON.stringify(lines)}`);
    expect(done).toBe(true);
    expect(lines).toEqual(["[quit] quit: no unsaved edits"]);
    expect(QUIT_SAVE_TIMEOUT_MS).toBe(30_000);
  });
});

describe("PAR-PL-05: Parrot main puts every queued write behind the quit guard (source read: the module runs Electron at import)", () => {
  const read = (rel: string) => {
    const source = readFileSync(resolve(import.meta.dirname, "../src/main", rel), "utf8");
    console.info(`${TAG} read src/main/${rel} (${source.length} chars)`);
    return source;
  };

  it("every library save goes through the one chain the guard waits for, and before-quit is the guard", () => {
    const source = read("index.ts");
    const runs = source.match(/librarySaves\.run\(/g) ?? [];
    const rawChains = source.match(/\.then\(run, run\)/g) ?? [];
    console.info(`${TAG} index.ts: ${runs.length} librarySaves.run, ${rawChains.length} raw .then(run, run)`);
    expect(rawChains).toEqual([]);
    // 11: the edits, the lookups' saves, the retry of unidentified songs, the lyrics, artist-photo and album-cover passes (PAR-META-20).
    expect(runs.length).toBe(11);
    expect(source).toContain('{ name: "library", chain: librarySaves }');
    expect(source).toContain('app.on("before-quit", (event) => quitGuard.beforeQuit(event));');
    expect(source).toContain('mainWindow.on("query-session-end", (event) => quitGuard.sessionEnding(event, "Windows session end"));');
    expect(source).toContain('quitGuard.sessionEnding(event, "system shutdown")');
    expect(source).toContain('await quitGuard.saveNow("restart to update");');
    expect((source.match(/app\.on\("before-quit"/g) ?? []).length).toBe(1);
  });

  it("parrot.json writes go through a chain the guard waits for", () => {
    const source = read("store.ts");
    expect(source).toContain("return writes.run(() => writeFileDurably(statePath, body));");
    expect(read("index.ts")).toContain('{ name: "settings", chain: { pending: () => store?.writes.pending() ?? 0');
  });
});
