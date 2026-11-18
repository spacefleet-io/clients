/**
 * Shared contract test suite for every {@link MpvClient} implementation.
 *
 * The suite is a function so concrete-implementation test files can wire
 * their own `makeClient` factory and a stub transport:
 *
 *   import { runClientContractSuite } from "@space/mpv-protocol/tests/client-contract";
 *
 *   describe("UnixSocketMpvClient", () => {
 *     runClientContractSuite("UnixSocketMpvClient", async () => {
 *       const client = new UnixSocketMpvClient({ ... });
 *       return client;
 *     }, { stubTransport: { onRequest: async (cmd) => ({ data: 12 }) } });
 *   });
 *
 * The point of the suite is to lock the *observable* protocol behavior:
 *   - state transitions reflect lifecycle
 *   - getProperty / setProperty preserve the "null on failure" / "true on
 *     success" semantics from properties.ts
 *   - waitForReady polls successfully when the transport responds
 *   - dispose() is idempotent and flips state to "disposed"
 *   - observe() — if `supportsObserve` is set, the suite drives real
 *     subscribe/unsubscribe scenarios via a push-source the caller
 *     supplies; otherwise it asserts observe() throws.
 *
 * The suite stays focused on *behavior visible at the interface*. Internal
 * mechanisms (socket parsing, ref-counted subscriptions) are tested in
 * each implementation's own test file.
 */

import { describe, expect, it } from "vitest";

import type {
  MpvClient,
  MpvClientState,
  MpvObserveCallback,
} from "../src/client";
import type { MpvCommand, MpvResponse } from "../src/bridge";
import type { MpvProperty } from "../src/properties";

export type StubTransport = {
  /** Called for every `command()` and `request()` on the client under test. */
  onRequest: (cmd: MpvCommand) => Promise<MpvResponse>;
};

/**
 * Tier-4 — optional plumbing for testing `observe()` implementations.
 * The caller exposes a way to push a synthetic property-change event
 * into the same backing transport the client subscribes to. The suite
 * uses it to assert subscribe → deliver, unsubscribe → silence, and
 * multiple-subscribers-per-property dispatch.
 *
 * If `supportsObserve` is unset, the suite falls back to the Tier-3
 * `observe_not_implemented` assertion.
 */
export type ObserveTestHarness = {
  /**
   * Trigger a synthetic property-change for `property` with `value`.
   * Should fire (synchronously or via the next microtask) the
   * registered callbacks for that property.
   */
  pushPropertyChange: (property: MpvProperty, value: unknown) => void;
};

export type ClientContractOptions = {
  stubTransport: StubTransport;
  /** When the implementation supports observe(), the factory returns this harness alongside the client. */
  observeHarness?: ObserveTestHarness;
};

export type ClientFactoryResult = {
  client: MpvClient;
  /** Set when observe-suite assertions should run. */
  observeHarness?: ObserveTestHarness;
};

export type ClientFactory = (
  options: ClientContractOptions,
) =>
  | MpvClient
  | Promise<MpvClient>
  | ClientFactoryResult
  | Promise<ClientFactoryResult>;

export type RunClientContractSuiteOptions = {
  /**
   * When set, the suite assumes `observe()` is wired up and runs the
   * full subscribe/unsubscribe/multi-subscriber assertions. The factory
   * MUST return a `ClientFactoryResult` with an observeHarness on each
   * `makeClient` call when this option is true.
   *
   * When unset (Tier-3 / stub clients), the suite asserts observe()
   * throws `observe_not_implemented`.
   */
  supportsObserve?: boolean;
};

/**
 * Run the shared MpvClient contract suite under a describe block named
 * for the implementation under test. The factory is invoked once per
 * `it` block so each test gets a fresh client; the stub transport is
 * reusable across tests in the suite.
 */
export const runClientContractSuite = (
  implementationName: string,
  makeClient: ClientFactory,
  suiteOptions: RunClientContractSuiteOptions = {},
): void => {
  const resolveFactoryResult = async (
    options: ClientContractOptions,
  ): Promise<ClientFactoryResult> => {
    const raw = await makeClient(options);
    if (
      raw &&
      typeof raw === "object" &&
      "client" in raw &&
      typeof (raw as { client?: unknown }).client === "object"
    ) {
      return raw as ClientFactoryResult;
    }
    return { client: raw as MpvClient };
  };
  describe(`MpvClient contract — ${implementationName}`, () => {
    const expectState = (
      client: MpvClient,
      expected: ReadonlyArray<MpvClientState>,
    ): void => {
      expect(expected).toContain(client.state);
    };

    it("starts in idle or connecting state", async () => {
      const { client } = await resolveFactoryResult({
        stubTransport: { onRequest: async () => ({ data: 0 }) },
      });
      expectState(client, ["idle", "connecting", "ready"]);
      await client.dispose();
    });

    it("returns the typed value from getProperty on success", async () => {
      const { client } = await resolveFactoryResult({
        stubTransport: {
          onRequest: async () => ({ data: 12.5 }),
        },
      });
      const value = await client.getProperty("time-pos");
      expect(value).toBe(12.5);
      await client.dispose();
    });

    it("returns null from getProperty when mpv reports a real error", async () => {
      const { client } = await resolveFactoryResult({
        stubTransport: {
          onRequest: async () => ({ error: "property unavailable" }),
        },
      });
      const value = await client.getProperty("time-pos");
      expect(value).toBeNull();
      await client.dispose();
    });

    it('treats getProperty error="success" as ACK and surfaces the data field', async () => {
      const { client } = await resolveFactoryResult({
        stubTransport: {
          onRequest: async () => ({ error: "success", data: false }),
        },
      });
      const value = await client.getProperty("pause");
      expect(value).toBe(false);
      await client.dispose();
    });

    it('returns true from setProperty on error="success"', async () => {
      const { client } = await resolveFactoryResult({
        stubTransport: {
          onRequest: async () => ({ error: "success" }),
        },
      });
      expect(await client.setProperty("pause", true)).toBe(true);
      await client.dispose();
    });

    it("returns false from setProperty on real mpv error", async () => {
      const { client } = await resolveFactoryResult({
        stubTransport: {
          onRequest: async () => ({ error: "property unavailable" }),
        },
      });
      expect(await client.setProperty("sid", 1)).toBe(false);
      await client.dispose();
    });

    it("waitForReady returns true when the transport responds with a usable shape", async () => {
      const { client } = await resolveFactoryResult({
        stubTransport: {
          onRequest: async () => ({ data: 0 }),
        },
      });
      const ready = await client.waitForReady(2000);
      expect(ready).toBe(true);
      await client.dispose();
    });

    it("waitForReady returns false when the transport never responds usefully within the budget", async () => {
      const { client } = await resolveFactoryResult({
        stubTransport: {
          onRequest: async () => ({}),
        },
      });
      const ready = await client.waitForReady(50);
      expect(ready).toBe(false);
      await client.dispose();
    });

    it("dispose is idempotent and transitions state to disposed", async () => {
      const { client } = await resolveFactoryResult({
        stubTransport: { onRequest: async () => ({ data: 0 }) },
      });
      await client.dispose();
      expect(client.state).toBe("disposed");
      // Repeat dispose: must not throw and must remain disposed.
      await expect(client.dispose()).resolves.toBeUndefined();
      expect(client.state).toBe("disposed");
    });

    if (suiteOptions.supportsObserve) {
      it("observe() delivers events to a subscribed callback", async () => {
        const { client, observeHarness } = await resolveFactoryResult({
          stubTransport: { onRequest: async () => ({ data: 0 }) },
        });
        if (!observeHarness) {
          throw new Error(
            "supportsObserve=true but factory did not return observeHarness",
          );
        }
        const seen: unknown[] = [];
        const callback: MpvObserveCallback<"time-pos"> = (value) => {
          seen.push(value);
        };
        const unsubscribe = client.observe("time-pos", callback);
        observeHarness.pushPropertyChange("time-pos", 12);
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(seen).toEqual([12]);
        unsubscribe();
        await client.dispose();
      });

      it("observe() unsubscribe stops further deliveries", async () => {
        const { client, observeHarness } = await resolveFactoryResult({
          stubTransport: { onRequest: async () => ({ data: 0 }) },
        });
        if (!observeHarness) {
          throw new Error(
            "supportsObserve=true but factory did not return observeHarness",
          );
        }
        const seen: unknown[] = [];
        const unsubscribe = client.observe(
          "time-pos",
          (value: number | null) => {
            seen.push(value);
          },
        );
        observeHarness.pushPropertyChange("time-pos", 1);
        await new Promise((resolve) => setTimeout(resolve, 25));
        unsubscribe();
        observeHarness.pushPropertyChange("time-pos", 2);
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(seen).toEqual([1]);
        await client.dispose();
      });

      it("observe() dispatches to all subscribers for a property", async () => {
        const { client, observeHarness } = await resolveFactoryResult({
          stubTransport: { onRequest: async () => ({ data: 0 }) },
        });
        if (!observeHarness) {
          throw new Error(
            "supportsObserve=true but factory did not return observeHarness",
          );
        }
        const a: unknown[] = [];
        const b: unknown[] = [];
        const c: unknown[] = [];
        const unsubA = client.observe("pause", (value: boolean | null) => {
          a.push(value);
        });
        const unsubB = client.observe("pause", (value: boolean | null) => {
          b.push(value);
        });
        const unsubC = client.observe("pause", (value: boolean | null) => {
          c.push(value);
        });
        observeHarness.pushPropertyChange("pause", true);
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(a).toEqual([true]);
        expect(b).toEqual([true]);
        expect(c).toEqual([true]);
        unsubA();
        unsubB();
        unsubC();
        await client.dispose();
      });
    } else {
      it("observe() throws observe_not_implemented when push isn't wired", async () => {
        // Stub clients that don't plug in a push source still throw to
        // surface the gap loudly instead of silently dropping events.
        const { client } = await resolveFactoryResult({
          stubTransport: { onRequest: async () => ({ data: 0 }) },
        });
        expect(() =>
          client.observe("time-pos", () => {
            /* never called */
          }),
        ).toThrowError(/observe_not_implemented/);
        await client.dispose();
      });
    }
  });
};
