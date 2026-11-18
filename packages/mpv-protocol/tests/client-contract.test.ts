/**
 * Runs the shared `runClientContractSuite` against a minimal stub MpvClient
 * built on top of the shared helpers (`getProperty`, `setProperty`,
 * `isExternalMpvResponseError`, etc.). This validates:
 *
 *   1. The contract suite itself is well-formed and runnable.
 *   2. The shared helpers (which every concrete client delegates to)
 *      satisfy the contract.
 *
 * Per-implementation tests (e.g. `mpv-socket-client.test.ts` for
 * UnixSocketMpvClient) should also call `runClientContractSuite` with
 * their own factory + transport mock. Tier-3 ships only the stub
 * invocation; Tier-4 may add per-implementation suite calls once the
 * observe() machinery is real.
 */

import { describe } from "vitest";

import type {
  MpvClient,
  MpvClientState,
  MpvObserveCallback,
  MpvObserveOptions,
  MpvObserveUnsubscribe,
  SubscribeLifecycleCallback,
  SubscribeLifecycleUnsubscribe,
} from "../src/client";
import type { MpvCommand, MpvResponse } from "../src/bridge";
import {
  getProperty,
  setProperty,
  type MpvProperty,
  type MpvPropertyValue,
} from "../src/properties";
import { isExternalMpvResponseReady } from "../src/responseError";
import {
  runClientContractSuite,
  type ClientContractOptions,
  type ObserveTestHarness,
} from "./client-contract";

/**
 * Minimal MpvClient implementation backed by a stub transport function.
 * Validates the SHARED helpers; concrete transports (Unix socket,
 * preload) have their own per-implementation suites.
 */
class StubMpvClient implements MpvClient {
  protected _state: MpvClientState = "idle";
  protected readonly send: (cmd: MpvCommand) => Promise<MpvResponse>;
  protected readyPromise: Promise<boolean> | null = null;

  constructor(send: (cmd: MpvCommand) => Promise<MpvResponse>) {
    this.send = send;
  }

  get state(): MpvClientState {
    return this._state;
  }

  async command(cmd: MpvCommand): Promise<MpvResponse> {
    if (this._state === "disposed") return { error: "disposed" };
    return this.send(cmd);
  }

  async request(cmd: MpvCommand): Promise<MpvResponse> {
    if (this._state === "disposed") return { error: "disposed" };
    return this.send(cmd);
  }

  async getProperty<P extends MpvProperty>(
    p: P,
    _signal?: AbortSignal,
  ): Promise<MpvPropertyValue<P> | null> {
    return getProperty(this.request.bind(this), p);
  }

  async setProperty<P extends MpvProperty>(
    p: P,
    v: MpvPropertyValue<P>,
    _signal?: AbortSignal,
  ): Promise<boolean> {
    return setProperty(this.request.bind(this), p, v);
  }

  observe<P extends MpvProperty>(
    _p: P,
    _cb: (value: MpvPropertyValue<P> | null) => void,
    _options?: { throttleMs?: number },
  ): () => void {
    throw new Error(
      "observe_not_implemented:tier_4_fills_this_in",
    );
  }

  subscribeLifecycle(_callback: SubscribeLifecycleCallback): SubscribeLifecycleUnsubscribe {
    throw new Error("subscribeLifecycle_not_implemented:stub_has_no_lifecycle_machine");
  }

  async waitForReady(timeoutMs: number): Promise<boolean> {
    if (this.readyPromise) return this.readyPromise;
    if (this._state === "disposed") return false;
    this._state = "connecting";
    const startedAt = Date.now();
    console.info(`[client-contract:waitForReady] begin poll timeoutMs=${timeoutMs}`);
    this.readyPromise = (async () => {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const elapsed = Date.now() - startedAt;
        if (elapsed >= timeoutMs) {
          console.error(
            `[client-contract:waitForReady] TIMEOUT predicate=isExternalMpvResponseReady attempt=${attempt} elapsed=${elapsed}ms timeoutMs=${timeoutMs} state=${this._state}`,
          );
          this.readyPromise = null;
          return false;
        }
        try {
          const result = await this.send({
            command: ["get_property", "time-pos"],
          });
          const ready = isExternalMpvResponseReady(result);
          console.info(
            `[client-contract:waitForReady] attempt=${attempt} elapsed=${elapsed}ms ready=${ready} result=${JSON.stringify(result)}`,
          );
          if (ready) {
            this._state = "ready";
            return true;
          }
        } catch (err) {
          console.info(
            `[client-contract:waitForReady] attempt=${attempt} elapsed=${elapsed}ms send threw: ${err instanceof Error ? err.message : String(err)} (retry)`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      console.error(
        `[client-contract:waitForReady] exhausted 12 attempts without ready elapsed=${Date.now() - startedAt}ms`,
      );
      this.readyPromise = null;
      return false;
    })();
    const ok = await this.readyPromise;
    this.readyPromise = null;
    return ok;
  }

  async dispose(): Promise<void> {
    this._state = "disposed";
  }
}

/**
 * Stub client that DOES support observe(). Used to drive the suite's
 * Tier-4 subscribe/unsubscribe/multi-subscriber assertions. The
 * push-source is a simple in-memory Map<MpvProperty, Set<callback>>
 * that the harness exposes via `pushPropertyChange`.
 */
class ObservableStubMpvClient extends StubMpvClient {
  private subs = new Map<MpvProperty, Set<(value: unknown) => void>>();

  observe<P extends MpvProperty>(
    property: P,
    callback: MpvObserveCallback<P>,
    _options?: MpvObserveOptions,
  ): MpvObserveUnsubscribe {
    const cb = callback as (value: unknown) => void;
    let set = this.subs.get(property);
    if (!set) {
      set = new Set();
      this.subs.set(property, set);
    }
    set.add(cb);
    return () => {
      const current = this.subs.get(property);
      if (!current) return;
      current.delete(cb);
      if (current.size === 0) this.subs.delete(property);
    };
  }

  /** Synchronously fan a value out to every callback registered for `property`. */
  push(property: MpvProperty, value: unknown): void {
    const current = this.subs.get(property);
    if (!current) return;
    console.info(
      `[client-contract:observe] push property=${String(property)} subscribers=${current.size} value=${JSON.stringify(value)}`,
    );
    for (const cb of current) cb(value);
  }

  /** Dump the live subscription map on demand (failure-context). */
  dumpSubs(label: string): void {
    try {
      const rows = Array.from(this.subs.entries()).map(([prop, set]) => ({
        property: String(prop),
        subscribers: set.size,
      }));
      console.error(`=== [client-contract:${label}] observe subs snapshot ===`);
      console.error(`state=${this._state} subs=${JSON.stringify(rows)}`);
    } catch (err) {
      console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
    }
  }
}

describe("MpvClient shared-helper contract", () => {
  console.info(`[client-contract:suite] running StubMpvClient (observe unsupported)`);
  runClientContractSuite(
    "StubMpvClient (observe unsupported)",
    async ({ stubTransport }: ClientContractOptions) => {
      console.info(`[client-contract:factory] constructing StubMpvClient`);
      return new StubMpvClient(stubTransport.onRequest);
    },
  );
});

describe("MpvClient shared-helper contract (observable stub)", () => {
  console.info(`[client-contract:suite] running ObservableStubMpvClient (supportsObserve=true)`);
  runClientContractSuite(
    "ObservableStubMpvClient",
    async ({ stubTransport }: ClientContractOptions) => {
      console.info(`[client-contract:factory] constructing ObservableStubMpvClient`);
      const client = new ObservableStubMpvClient(stubTransport.onRequest);
      const observeHarness: ObserveTestHarness = {
        pushPropertyChange: (property, value) =>
          (client as ObservableStubMpvClient).push(property, value),
      };
      return { client, observeHarness };
    },
    { supportsObserve: true },
  );
});
