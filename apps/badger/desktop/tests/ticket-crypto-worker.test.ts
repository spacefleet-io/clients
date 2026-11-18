// @vitest-environment jsdom
/**
 * META-ANON-12: the desktop's ticket reserve blinds in a Web Worker, never on the renderer's thread. Release gate 34718
 * showed the in-thread refill (~40 ms a ticket, 600 tickets) holding the renderer for tens of seconds after sign-in.
 * A stand-in Worker answers with the real crypto (`answerTicketCryptoRequest`), so the request the app sends is real.
 */
import { answerTicketCryptoRequest, type TicketCryptoReply, type TicketCryptoRequest } from "@space/privacy-pass";
import { afterEach, describe, expect, it, vi } from "vitest";

const SUITE = "ticket-crypto-worker";

class StandInWorker {
  static created: StandInWorker[] = [];
  readonly requests: TicketCryptoRequest[] = [];
  readonly #listeners: ((event: { data: TicketCryptoReply }) => void)[] = [];
  constructor(
    readonly url: URL | string,
    readonly options: { type?: string; name?: string } = {},
  ) {
    StandInWorker.created.push(this);
  }
  addEventListener(type: string, listener: (event: { data: TicketCryptoReply }) => void) {
    if (type === "message") this.#listeners.push(listener);
  }
  postMessage(request: TicketCryptoRequest) {
    this.requests.push(request);
    const reply = answerTicketCryptoRequest(request);
    setTimeout(() => this.#listeners.forEach((listener) => listener({ data: reply })), 0);
  }
}

describe("desktop ticket blinding in a worker (META-ANON-12)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  // @req META-ANON-12[badger-desktop]
  it("the reserve's refill posts its blinding to the sf-ticket-crypto worker, not the renderer's thread", async () => {
    vi.stubGlobal("Worker", StandInWorker);
    localStorage.setItem("sf_client_token", "session-token");
    // The API refuses the batch: blinding happened (in the worker) and nothing is kept.
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { getDesktopMetadata } = await import("../src/renderer/src/lib/metadataTickets");

    const result = await getDesktopMetadata().reserve.refill({ force: true });
    const [worker] = StandInWorker.created;
    console.log(`[${SUITE}] refill status=${result.status} workers=${StandInWorker.created.length} url=${String(worker?.url)} name=${worker?.options.name} ops=${worker?.requests.map((r) => `${r.op}${r.op === "create" ? `:${r.count}` : ""}`).join(",")} fetches=${fetchSpy.mock.calls.length}`);

    expect(StandInWorker.created).toHaveLength(1);
    // vitest serves the worker module with a `?worker_file` query; the build emits it as its own chunk.
    expect(String(worker!.url)).toMatch(/\/lib\/ticketCrypto\.worker\.ts(\?|$)/u);
    expect(worker!.options).toMatchObject({ type: "module", name: "sf-ticket-crypto" });
    expect(worker!.requests.map((request) => request.op)).toEqual(["create"]);
    expect(worker!.requests[0]).toMatchObject({ op: "create", count: 100 });
    expect(fetchSpy).toHaveBeenCalled();
    expect(result.status).toBe("signed_out");
  }, 60_000);
});
