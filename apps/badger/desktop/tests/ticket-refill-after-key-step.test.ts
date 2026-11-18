// @vitest-environment jsdom
/**
 * META-ANON-11: the ticket refill starts only once the library key step is done. Release gate 34718 sat on
 * /onboarding/key "Loading key…" for 24 s right after sign-in while the refill signed and unblinded 600 tickets on
 * the renderer's thread. The real acknowledgement path of `lib/onboarding` drives the start here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SUITE = "ticket-refill-after-key-step";

const idbStore = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../src/renderer/src/lib/idb", () => ({
  idbGet: async (key: string) => idbStore.get(key),
  idbSet: async (key: string, value: unknown) => void idbStore.set(key, value),
  idbDel: async (key: string) => void idbStore.delete(key),
}));

import { acknowledgeLibraryKey, isLibraryKeyAcknowledged, onLibraryKeyAcknowledged } from "../src/renderer/src/lib/onboarding";
import { startMetadataTicketsAfterKeyStep } from "../src/renderer/src/lib/metadataTickets";

const watch = { isAcknowledged: isLibraryKeyAcknowledged, onAcknowledged: onLibraryKeyAcknowledged };
// Past the IndexedDB read bound of isLibraryKeyAcknowledged (IDB_ACK_READ_TIMEOUT_MS), on the fake clock.
const settle = () => vi.advanceTimersByTimeAsync(1_000);

describe("ticket refill after the library key step (META-ANON-11)", () => {
  beforeEach(() => {
    localStorage.clear();
    idbStore.clear();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    localStorage.setItem("sf_client_user", JSON.stringify({ id: "u1", email: "a@b.c" }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // @req META-ANON-11[badger-desktop]
  it("a fresh sign-in waits on the key page and starts the refill once the key is acknowledged, once", async () => {
    const start = vi.fn();
    startMetadataTicketsAfterKeyStep(watch, start);
    await settle();
    console.info(`[${SUITE}:fresh] startsBeforeAck=${start.mock.calls.length}`);
    expect(start).not.toHaveBeenCalled();

    await acknowledgeLibraryKey();
    await acknowledgeLibraryKey();
    console.info(`[${SUITE}:fresh] startsAfterAck=${start.mock.calls.length}`);
    expect(start).toHaveBeenCalledTimes(1);
  });

  // @req META-ANON-11[badger-desktop]
  it("an app start with the key already acknowledged starts the refill at once", async () => {
    await acknowledgeLibraryKey();
    const start = vi.fn();
    startMetadataTicketsAfterKeyStep(watch, start);
    await settle();
    console.info(`[${SUITE}:restart] starts=${start.mock.calls.length}`);
    expect(start).toHaveBeenCalledTimes(1);
  });

  // @req META-ANON-11[badger-desktop]
  it("a sign-out before the key step cancels the wait: no refill starts", async () => {
    const start = vi.fn();
    const cancel = startMetadataTicketsAfterKeyStep(watch, start);
    cancel();
    await acknowledgeLibraryKey();
    await settle();
    console.info(`[${SUITE}:cancel] starts=${start.mock.calls.length}`);
    expect(start).not.toHaveBeenCalled();
  });
});
