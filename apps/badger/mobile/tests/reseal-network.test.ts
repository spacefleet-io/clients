/**
 * @test-id MOBILE-RESEAL-NETWORK-001
 * @level unit
 * @req ACCT-KEYCHG-05[badger-mobile]
 * @why A key change downloads and uploads every media file again: on mobile data that can be a whole data plan. The
 *   phone's copying waits on mobile data (the screen shows it paused) and carries on by itself on Wi-Fi, or at once
 *   when the user turns on "Use mobile data"; leaving the screen (abort) never leaves it hanging.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkType } from "@space/mobile-media-proxy/downloads";
import { createResealNetworkGate, RESEAL_NETWORK_POLL_MS } from "../src/lib/resealNetwork";

vi.mock("@space/mobile-media-proxy/downloads", () => ({ downloadsNativeAvailable: () => false, nativeGetStatus: vi.fn() }));

let network: NetworkType | null = "cellular";
const read = async () => network;
const settled = (p: Promise<void>) => {
  let done = false;
  void p.then(() => (done = true));
  return () => done;
};

beforeEach(() => {
  vi.useFakeTimers();
  network = "cellular";
});
afterEach(() => vi.useRealTimers());

describe("createResealNetworkGate (ACCT-KEYCHG-05)", () => {
  it("lets a file go at once on Wi-Fi, and without the download engine", async () => {
    network = "wifi";
    const gate = createResealNetworkGate(read);
    await gate.beforeFile(new AbortController().signal);
    expect(gate.paused()).toBe(false);
    await createResealNetworkGate().beforeFile(new AbortController().signal);
  });

  it("pauses on mobile data and carries on when the phone is on Wi-Fi", async () => {
    const gate = createResealNetworkGate(read);
    const seen: boolean[] = [];
    gate.subscribe(() => seen.push(gate.paused()));
    const done = settled(gate.beforeFile(new AbortController().signal));
    await vi.advanceTimersByTimeAsync(RESEAL_NETWORK_POLL_MS * 3);
    expect(done()).toBe(false);
    expect(gate.paused()).toBe(true);
    network = "wifi";
    await vi.advanceTimersByTimeAsync(RESEAL_NETWORK_POLL_MS);
    expect(done()).toBe(true);
    expect(seen).toEqual([true, false]);
  });

  it("carries on at once on mobile data when the user turns on Use mobile data", async () => {
    const gate = createResealNetworkGate(read);
    const done = settled(gate.beforeFile(new AbortController().signal));
    await vi.advanceTimersByTimeAsync(0);
    expect(gate.paused()).toBe(true);
    gate.setUseMobileData(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(done()).toBe(true);
    expect(gate.paused()).toBe(false);
    await gate.beforeFile(new AbortController().signal);
  });

  it("returns when the copying is stopped while paused", async () => {
    const gate = createResealNetworkGate(read);
    const controller = new AbortController();
    const done = settled(gate.beforeFile(controller.signal));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(done()).toBe(true);
    expect(gate.paused()).toBe(false);
  });
});
