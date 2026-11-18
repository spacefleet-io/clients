/**
 * DEV-LIB-01, tool side: ask the local runtime for library access and get a
 * token the user approved in a SpaceFleet app.
 *
 * For third-party tools (the `spacefleet` CLI in packages/cli, scripts), not for SpaceFleet's own
 * apps: it never reads or sends the owner secret and never logs in. The
 * request carries a self-declared tool name and a mode; the runtime shows
 * both, with a verification code, to the user, and answers the poll once they
 * decided. Show the code to the user (`onVerificationCode`) so they can match
 * it with the prompt: the name alone proves nothing.
 */
import {
  TOOL_ACCESS_ERRORS,
  toolAccessErrorSchema,
  toolAccessRequestResponseSchema,
  toolAccessTokenResponseSchema,
  type ToolAccessMode,
  type ToolAccessTokenResponse,
} from "@space/tool-access/contracts";
import type { RuntimeFetch } from "./fetch";

export type ToolAccessFailureCode =
  | typeof TOOL_ACCESS_ERRORS.noAppConnected
  | typeof TOOL_ACCESS_ERRORS.denied
  | typeof TOOL_ACCESS_ERRORS.expired
  | typeof TOOL_ACCESS_ERRORS.rateLimited
  | typeof TOOL_ACCESS_ERRORS.tooManyPending
  | typeof TOOL_ACCESS_ERRORS.alreadyPending
  | typeof TOOL_ACCESS_ERRORS.invalidPayload
  | "aborted"
  | "request_failed";

/** Why access was not granted. `message` is safe to show to a person. */
export class ToolAccessError extends Error {
  readonly code: ToolAccessFailureCode;
  readonly httpStatus: number | null;

  constructor(code: ToolAccessFailureCode, message: string, httpStatus: number | null = null) {
    super(message);
    this.name = "ToolAccessError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export type RequestToolAccessOptions = {
  /** Runtime origin, e.g. `http://127.0.0.1:3020`. */
  baseUrl: string;
  /** Self-declared name the user sees (at most 64 characters). Not an identity. */
  toolName: string;
  mode: ToolAccessMode;
  /** Why the tool wants in (at most 200 characters), shown in the prompt. */
  reason?: string;
  /** Called once, as soon as the request exists: show the code to the user. */
  onVerificationCode: (code: string) => void;
  signal?: AbortSignal;
  fetchImpl?: RuntimeFetch;
  /** How often to ask whether the user decided. Default 1500 ms. */
  pollIntervalMs?: number;
  /** Clock seam, like `createRuntimeSession`. */
  clock?: () => number;
};

/** What the user granted: a token provider plus the terms of the grant. */
export type ToolTokenProvider = {
  /** The token, or a `ToolAccessError("expired")` once the grant ran out: request access again. */
  getToken(): Promise<string>;
  readonly grantId: string;
  readonly mode: ToolAccessMode;
  readonly allowedOps: readonly string[];
  /** Absolute end of the grant, in ms since the epoch (it also ends after 30 idle minutes, or on revoke). A web grant (PLAT-WEB-06) reports 9999-12-31: it ends on revoke or sign-out only. */
  readonly expiresAt: number;
};

const DEFAULT_POLL_INTERVAL_MS = 1500;

const jsonHeaders = { "content-type": "application/json" };

const sleep = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new ToolAccessError("aborted", "Access request cancelled."));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ToolAccessError("aborted", "Access request cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const FAILURE_CODES: Record<string, ToolAccessFailureCode> = {
  [TOOL_ACCESS_ERRORS.noAppConnected]: TOOL_ACCESS_ERRORS.noAppConnected,
  [TOOL_ACCESS_ERRORS.denied]: TOOL_ACCESS_ERRORS.denied,
  [TOOL_ACCESS_ERRORS.expired]: TOOL_ACCESS_ERRORS.expired,
  [TOOL_ACCESS_ERRORS.rateLimited]: TOOL_ACCESS_ERRORS.rateLimited,
  [TOOL_ACCESS_ERRORS.tooManyPending]: TOOL_ACCESS_ERRORS.tooManyPending,
  [TOOL_ACCESS_ERRORS.alreadyPending]: TOOL_ACCESS_ERRORS.alreadyPending,
  [TOOL_ACCESS_ERRORS.invalidPayload]: TOOL_ACCESS_ERRORS.invalidPayload,
};

const toFailure = async (res: Response): Promise<ToolAccessError> => {
  const parsed = toolAccessErrorSchema.safeParse(await res.json().catch(() => null));
  const body = parsed.success ? parsed.data : null;
  const message = body?.message || `The runtime refused the request (HTTP ${res.status}).`;
  return new ToolAccessError((body && FAILURE_CODES[body.error]) || "request_failed", message, res.status);
};

/**
 * Ask the user for library access and wait for their answer.
 *
 * Resolves with a token provider once approved; rejects with
 * `ToolAccessError` (`denied`, `expired`, `no_app_connected` when SpaceFleet is
 * not open, rate limits, `aborted`).
 */
export const requestToolAccess = async (options: RequestToolAccessOptions): Promise<ToolTokenProvider> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.clock ?? (() => Date.now());
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const call = async (path: string, body: unknown) => {
    try {
      return await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify(body),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted) throw new ToolAccessError("aborted", "Access request cancelled.");
      throw new ToolAccessError(
        "request_failed",
        `Could not reach the SpaceFleet runtime at ${baseUrl}: ${error instanceof Error ? error.message : "network error"}.`
      );
    }
  };

  const created = await call("/runtime/access/request", {
    toolName: options.toolName,
    mode: options.mode,
    ...(options.reason ? { reason: options.reason } : {}),
  });
  if (!created.ok) throw await toFailure(created);
  const request = toolAccessRequestResponseSchema.parse(await created.json());
  options.onVerificationCode(request.verificationCode);

  const deadline = Date.parse(request.expiresAt);
  for (;;) {
    const res = await call(`/runtime/access/requests/${encodeURIComponent(request.requestId)}/token`, {
      pollSecret: request.pollSecret,
    });
    if (res.status === 200) return providerFor(toolAccessTokenResponseSchema.parse(await res.json()), clock);
    if (res.status !== 202) throw await toFailure(res);
    if (Number.isFinite(deadline) && clock() >= deadline) {
      throw new ToolAccessError("expired", "Nobody approved the request in time.", 410);
    }
    await sleep(pollIntervalMs, options.signal);
  }
};

const providerFor = (granted: ToolAccessTokenResponse, clock: () => number): ToolTokenProvider => {
  const expiresAt = Date.parse(granted.expiresAt);
  return {
    grantId: granted.grantId,
    mode: granted.mode,
    allowedOps: granted.allowedOps,
    expiresAt,
    async getToken() {
      if (clock() >= expiresAt) throw new ToolAccessError("expired", "The tool grant expired: request access again.");
      return granted.token;
    },
  };
};
