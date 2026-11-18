/**
 * @test-id MOBILE-SHELL-KEPT-LIBRARY-KEY-001
 * @level unit
 * @why Main 2026-11-12: "On start (and on foreground if cheap), the app checks that its kept key still matches the
 *   account's library/probe. A mismatch or a missing probe means: forget the key, clear the local library cache, go to
 *   the shared key step (enter if there's a probe, create if none). A network failure keeps the key. No publish/sync
 *   with a key that doesn't match the probe." Badger phone, Badger TV and Parrot phone share this verdict and watcher
 *   (`@space/mobile-shell/kept-library-key`). Detail (agent reading, approved by Main (2026-11-12)): a library that
 *   exists without any probe predates probes, so it is "unchecked" (its snapshot decrypt stays the check), never
 *   forgotten.
 * @req UX-KEY-01[badger-mobile,badger-tv,parrot]
 */
import { describe, expect, it } from "vitest";
import {
  checkKeptLibraryKey,
  keptLibraryKeyIsStale,
  keptLibraryKeyVerdict,
  watchKeptLibraryKey,
  type KeptLibraryKeyVerdict,
} from "../src/keptLibraryKey";

const SUITE = "[MOBILE-SHELL-KEPT-LIBRARY-KEY-001]";

// 32 bytes of base64: a well-formed key. The probe "decrypts" only with the key it was made for, as AES-GCM does.
const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");
const probeFor = (key: string) => `probe:${key}`;
const decrypt = async (key: string, probe: string) => {
  if (probe !== probeFor(key)) throw new Error("bad tag");
  return new Uint8Array();
};

const verdictOf = async (key: string, meta: { exists: boolean; keyProbe: string | null } | null) => {
  const verdict = await keptLibraryKeyVerdict(key, meta, decrypt);
  console.info(SUITE, "verdict", JSON.stringify({ meta, keyIsKept: key === KEY, verdict, stale: keptLibraryKeyIsStale(verdict) }));
  return verdict;
};

describe("kept library key verdict", () => {
  it("keeps a key that opens the account's probe", async () => {
    expect(await verdictOf(KEY, { exists: true, keyProbe: probeFor(KEY) })).toBe("matches");
  });

  it("forgets a key when the library was erased and remade with another key (the probe does not open)", async () => {
    const verdict = await verdictOf(KEY, { exists: true, keyProbe: probeFor(OTHER_KEY) });
    expect(verdict).toBe("mismatch");
    expect(keptLibraryKeyIsStale(verdict)).toBe(true);
  });

  it("forgets a key when the account has no key any more (erased: no probe, no library)", async () => {
    const verdict = await verdictOf(KEY, { exists: false, keyProbe: null });
    expect(verdict).toBe("noKey");
    expect(keptLibraryKeyIsStale(verdict)).toBe(true);
  });

  it("keeps the key when the meta could not be read (no connection)", async () => {
    const verdict = await verdictOf(KEY, null);
    expect(verdict).toBe("unchecked");
    expect(keptLibraryKeyIsStale(verdict)).toBe(false);
  });

  it("keeps the key of a library from before key probes (exists, no probe)", async () => {
    expect(await verdictOf(KEY, { exists: true, keyProbe: null })).toBe("unchecked");
  });

  it("treats a stored key that is not key-shaped as the wrong key", async () => {
    expect(await verdictOf("not-a-key", { exists: true, keyProbe: probeFor(KEY) })).toBe("mismatch");
  });
});

describe("checking the kept key against the account", () => {
  it("fetches the meta and judges the key against it, logging the verdict", async () => {
    const events: string[] = [];
    const verdict = await checkKeptLibraryKey(KEY, {
      fetchMeta: async () => ({ exists: true, keyProbe: probeFor(OTHER_KEY) }),
      decrypt,
      log: (event, details) => {
        events.push(event);
        console.info(SUITE, event, JSON.stringify(details));
      },
    });
    expect(verdict).toBe("mismatch");
    expect(events).toEqual(["kept_key.checked"]);
  });

  it("a failed meta request is no verdict: the key stays", async () => {
    const events: string[] = [];
    const verdict = await checkKeptLibraryKey(KEY, {
      fetchMeta: async () => {
        throw new Error("Network request failed");
      },
      decrypt,
      log: (event, details) => {
        events.push(event);
        console.info(SUITE, event, JSON.stringify(details));
      },
    });
    expect(verdict).toBe("unchecked");
    expect(events).toEqual(["kept_key.meta_failed", "kept_key.checked"]);
  });
});

/** An AppState stand-in: `emit("active")` is the app coming back to the front. */
const fakeAppState = () => {
  const listeners = new Set<(status: string) => void>();
  return {
    addEventListener: (_event: "change", listener: (status: string) => void) => {
      listeners.add(listener);
      return { remove: () => void listeners.delete(listener) };
    },
    emit: (status: string) => listeners.forEach((listener) => listener(status)),
    count: () => listeners.size,
  };
};
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe("watching the kept key on start and foreground", () => {
  it("checks at start and on each foreground, and forgets only on a stale verdict", async () => {
    const appState = fakeAppState();
    const verdicts: KeptLibraryKeyVerdict[] = ["matches", "unchecked", "noKey"];
    const stale: KeptLibraryKeyVerdict[] = [];
    let checks = 0;
    const stop = watchKeptLibraryKey({
      check: async () => verdicts[checks++]!,
      onStale: (verdict) => void stale.push(verdict),
      appState,
    });
    await settle();
    appState.emit("background");
    appState.emit("active");
    await settle();
    appState.emit("active");
    await settle();
    console.info(SUITE, "watch", JSON.stringify({ checks, stale }));
    expect(checks).toBe(3);
    expect(stale).toEqual(["noKey"]);
    stop();
  });

  it("skips the start check when asked, and a foreground while a check runs", async () => {
    const appState = fakeAppState();
    let checks = 0;
    let release: (verdict: KeptLibraryKeyVerdict) => void = () => undefined;
    const stop = watchKeptLibraryKey({
      check: () => {
        checks += 1;
        return new Promise<KeptLibraryKeyVerdict>((resolve) => (release = resolve));
      },
      onStale: () => undefined,
      appState,
      atStart: false,
    });
    await settle();
    expect(checks).toBe(0);
    appState.emit("active");
    appState.emit("active");
    await settle();
    console.info(SUITE, "one at a time", JSON.stringify({ checks }));
    expect(checks).toBe(1);
    release("matches");
    await settle();
    appState.emit("active");
    await settle();
    expect(checks).toBe(2);
    stop();
  });

  it("stops listening, and a verdict landing after the stop forgets nothing", async () => {
    const appState = fakeAppState();
    let release: (verdict: KeptLibraryKeyVerdict) => void = () => undefined;
    const stale: KeptLibraryKeyVerdict[] = [];
    const stop = watchKeptLibraryKey({
      check: () => new Promise<KeptLibraryKeyVerdict>((resolve) => (release = resolve)),
      onStale: (verdict) => void stale.push(verdict),
      appState,
    });
    await settle();
    stop();
    release("mismatch");
    await settle();
    console.info(SUITE, "stopped", JSON.stringify({ listeners: appState.count(), stale }));
    expect(appState.count()).toBe(0);
    expect(stale).toEqual([]);
  });

  it("logs a failed check and keeps the key", async () => {
    const appState = fakeAppState();
    const events: string[] = [];
    const stale: KeptLibraryKeyVerdict[] = [];
    const stop = watchKeptLibraryKey({
      check: async () => {
        throw new Error("boom");
      },
      onStale: (verdict) => void stale.push(verdict),
      appState,
      log: (event) => void events.push(event),
    });
    await settle();
    console.info(SUITE, "failed check", JSON.stringify({ events, stale }));
    expect(events).toEqual(["kept_key.check_failed"]);
    expect(stale).toEqual([]);
    stop();
  });
});
