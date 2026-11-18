// Where ticket blinding and unblinding run (META-ANON-12). One RSA-2048 blind or unblind costs ~40 ms in the desktop
// renderer and ~70 ms on Hermes, so a 600-ticket refill is tens of seconds of CPU. In-thread, that time is spent
// between the app's own frames (one ticket per event-loop turn); with a worker it leaves the UI thread entirely.
// The worker side and the app side speak a small id-tagged message protocol; every payload is plain JSON data.

import {
  createTicketRequests,
  createTicketRequestsAsync,
  finishTickets,
  finishTicketsAsync,
  type FinishedTickets,
  type FinishTicketOptions,
  type PendingTicket,
  type TicketRequestOptions,
  type TicketRequests,
} from "./client";
import type { PinnedTicketKey } from "./pinnedKey";

/** Blinds a batch and unblinds the answer. Same results as `createTicketRequests` / `finishTickets`. */
export interface TicketCrypto {
  /** `options.getRandomBytes` is honoured in-thread only: a worker draws from its own `crypto.getRandomValues`. */
  createTicketRequests(count: number, pinnedKey: PinnedTicketKey, options?: TicketRequestOptions): Promise<TicketRequests>;
  finishTickets(pending: readonly PendingTicket[], signed: readonly string[], pinnedKey: PinnedTicketKey, options?: FinishTicketOptions): Promise<FinishedTickets>;
}

/**
 * The work on the calling thread, one ticket per event-loop turn (`yieldToEventLoop`, default one `setTimeout(0)`).
 * What Hermes (no Web Worker) and Node hosts use.
 */
export const createInThreadTicketCrypto = (yieldToEventLoop?: () => Promise<void>): TicketCrypto => {
  const yieldOption = yieldToEventLoop ? { yieldToEventLoop } : {};
  return {
    createTicketRequests: (count, pinnedKey, options = {}) => createTicketRequestsAsync(count, pinnedKey, { ...options, ...yieldOption }),
    finishTickets: (pending, signed, pinnedKey, options = {}) => finishTicketsAsync(pending, signed, pinnedKey, { ...options, ...yieldOption }),
  };
};

export type TicketCryptoRequest =
  | { id: number; op: "create"; count: number; pinnedKey: PinnedTicketKey }
  | { id: number; op: "finish"; pending: PendingTicket[]; signed: unknown; pinnedKey: PinnedTicketKey; responseKeyId?: unknown };

export type TicketCryptoReply =
  | { id: number; ok: true; result: TicketRequests | FinishedTickets }
  | { id: number; ok: false; error: string };

/** The worker's global scope, as far as the protocol needs it. */
export interface TicketCryptoScope {
  postMessage(message: TicketCryptoReply): void;
  addEventListener(type: "message", listener: (event: { data: TicketCryptoRequest }) => void): void;
}

/** The app's handle on the worker, as far as the protocol needs it (a DOM `Worker` fits). */
export interface TicketCryptoWorker {
  postMessage(message: TicketCryptoRequest): void;
  addEventListener(type: "message", listener: (event: { data: TicketCryptoReply }) => void): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
}

/** Answers one request. Synchronous on purpose: it runs off the UI thread, so there is nothing to yield to. */
export function answerTicketCryptoRequest(request: TicketCryptoRequest): TicketCryptoReply {
  try {
    if (request.op === "create") return { id: request.id, ok: true, result: createTicketRequests(request.count, request.pinnedKey) };
    // `signed` and `responseKeyId` are the server's untrusted answer: finishTickets validates their shape.
    const options = request.responseKeyId === undefined ? {} : { responseKeyId: request.responseKeyId as string };
    return { id: request.id, ok: true, result: finishTickets(request.pending, request.signed as string[], request.pinnedKey, options) };
  } catch (error) {
    return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Call once in the worker module: answers every request posted to it. */
export function serveTicketCrypto(scope: TicketCryptoScope): void {
  scope.addEventListener("message", (event) => scope.postMessage(answerTicketCryptoRequest(event.data)));
}

/**
 * The app side: every call is posted to `worker` and resolves with its answer. A worker that fails (a load error, an
 * uncaught throw) rejects the calls in flight with that error; the reserve then ends the run like any other failure.
 */
export function createWorkerTicketCrypto(worker: TicketCryptoWorker): TicketCrypto {
  let nextId = 1;
  const inFlight = new Map<number, PromiseWithResolvers<TicketRequests | FinishedTickets>>();
  worker.addEventListener("message", (event) => {
    const reply = event.data;
    const call = inFlight.get(reply.id);
    if (!call) return;
    inFlight.delete(reply.id);
    if (reply.ok) call.resolve(reply.result);
    else call.reject(new Error(`ticket worker: ${reply.error}`));
  });
  worker.addEventListener("error", (event) => {
    const error = new Error(`ticket worker failed: ${event.message ?? "unknown error"}`);
    for (const call of inFlight.values()) call.reject(error);
    inFlight.clear();
  });
  const send = (request: TicketCryptoRequest): Promise<TicketRequests | FinishedTickets> => {
    const call = Promise.withResolvers<TicketRequests | FinishedTickets>();
    inFlight.set(request.id, call);
    worker.postMessage(request);
    return call.promise;
  };
  return {
    createTicketRequests: (count, pinnedKey) => send({ id: nextId++, op: "create", count, pinnedKey }) as Promise<TicketRequests>,
    finishTickets: (pending, signed, pinnedKey, options = {}) =>
      send({
        id: nextId++,
        op: "finish",
        pending: [...pending],
        signed,
        pinnedKey,
        ...(options.responseKeyId === undefined ? {} : { responseKeyId: options.responseKeyId }),
      }) as Promise<FinishedTickets>,
  };
}
