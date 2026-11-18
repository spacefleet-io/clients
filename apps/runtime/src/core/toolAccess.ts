/**
 * DEV-LIB-01: per-tool library access, granted by the user.
 *
 * A tool asks (`request`), the user decides in a desktop app (`decide`), and
 * the tool collects a `tool` session token with the secret only it was given
 * (`poll`). The token is a runtime session without backend token or app scope;
 * `routes/toolAccess.ts` lets it call a fixed allowlist of operations and
 * nothing else. Revoking a grant ends its session at once.
 *
 * Security properties this class carries:
 *  - The tool name is self-declared and never an identity: the prompt shows it
 *    with a verification code that only the requester and the user can compare.
 *  - `pollSecret` (256 bit) exists in the requester's response and, hashed, in
 *    here. It is never published, listed or logged. Compared in constant time;
 *    five wrong guesses kill the request.
 *  - Nothing is granted without a decision from an app session: this class has
 *    no path from `request` to a token that skips `decide`.
 *  - Grants live in memory and die with the runtime, except a web grant
 *    (PLAT-WEB-06: bound to a browser origin). It has no time limit, ends only
 *    on revoke, sign-out or another user, and survives a restart: the store
 *    keeps the SHA-256 of its token (never the token), and the tool's next call
 *    with that token from that origin re-opens it.
 */
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import {
  TOOL_ACCESS_ERRORS,
  TOOL_NAME_MAX_LENGTH,
  TOOL_REASON_MAX_LENGTH,
  isToolWriteOperation,
  toolOperationsForMode,
  type ToolAccessError,
  type ToolAccessGrant,
  type ToolAccessMode,
  type ToolAccessPending,
  type ToolAccessSnapshot,
  type ToolAccessTokenResponse,
  type ToolOperation,
} from "@space/tool-access/contracts";
import type { RuntimeState } from "../state";
import type { PersistedToolGrant, ToolGrantStore } from "./toolGrantStore";

export const TOOL_ACCESS_LIMITS = {
  /** Open requests at once. */
  maxPending: 3,
  /** A request nobody decided on ends after this. */
  requestTtlMs: 2 * 60_000,
  /** An approved request must be collected within this window after the decision. */
  claimWindowMs: 60_000,
  /** Requests accepted per window, whoever sends them: the loopback gives no client identity. */
  rateLimitMax: 10,
  rateLimitWindowMs: 60_000,
  /** Wrong poll secrets tolerated before the request is dropped. */
  maxPollFailures: 5,
  /** Absolute life of a tool session (not a web grant: PLAT-WEB-06). */
  sessionTtlMs: 8 * 3_600_000,
  /** A tool session unused for this long ends (not a web grant: PLAT-WEB-06). */
  sessionIdleMs: 30 * 60_000,
  /** Finished requests stay (as tombstones, so a late poll gets 410 and not 404) this long past their end. */
  tombstoneMs: 5 * 60_000,
  /** How often grants/requests that ran out are swept and the apps told. */
  sweepIntervalMs: 30_000,
  /** `lastUsedAt` changes are pushed to the apps at most this often. */
  usePublishMinIntervalMs: 15_000,
  /** After a denial, the same tool name may not ask again for this long. */
  deniedNameCooldownMs: 5 * 60_000,
  /** After any denial, no tool may ask for this long. */
  deniedGlobalCooldownMs: 30_000,
} as const;

/**
 * PLAT-WEB-06: the `expiresAt` a web grant reports. It has no end; the
 * contract carries a date, so it gets the last one ISO 8601 writes in four digits.
 */
export const WEB_GRANT_EXPIRES_AT = Date.parse("9999-12-31T23:59:59.999Z");

export type ToolAccessFailure = {
  ok: false;
  status: 400 | 401 | 403 | 404 | 409 | 410 | 423 | 429;
  error: ToolAccessError;
  message: string;
  retryAfterSeconds?: number;
};
const fail = (
  status: ToolAccessFailure["status"],
  error: ToolAccessError,
  message: string,
  retryAfterSeconds?: number
): ToolAccessFailure => ({ ok: false, status, error, message, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) });

type RequestState = "pending" | "approved" | "denied" | "claimed";

type AccessRequest = {
  id: string;
  toolName: string;
  reason: string | null;
  mode: ToolAccessMode;
  verificationCode: string;
  pollSecretDigest: Buffer;
  requestedAt: number;
  /** End of the current phase: the decision deadline while pending, the claim deadline once approved. */
  expiresAt: number;
  state: RequestState;
  grantedMode: ToolAccessMode | null;
  approvedByUserId: string | null;
  pollFailures: number;
  /** Browser origin the request came from (PLAT-WEB-05), null for a non-browser tool. */
  origin: string | null;
};

type Grant = {
  id: string;
  toolName: string;
  mode: ToolAccessMode;
  /** The user who was active when the request was approved; the grant ends when another user is. */
  userId: string;
  grantedAt: number;
  lastUsedAt: number | null;
  /** Null while a stored web grant waits for its tool to come back after a restart (no session yet). */
  token: string | null;
  /** Hex SHA-256 of the token: how a stored web grant recognises its tool again. */
  tokenDigest: string;
  expiresAt: number;
  /** Browser origin the grant is bound to: the token works from that origin only (null: from no browser). */
  origin: string | null;
  /** PLAT-WEB-06: a web grant (origin set) has no time limit and is kept across restarts. */
  persistent: boolean;
};

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
const digestHex = (value: string): string => digest(value).toString("hex");

/**
 * A label the prompt will show: one line, normalised, no control, format
 * (bidi override, zero width) or separator characters, at most `max` characters.
 */
export const sanitizeToolLabel = (value: string, max: number): string =>
  value
    .normalize("NFKC")
    .replace(/[\p{C}\p{Z}]+/gu, " ")
    .trim()
    .slice(0, max)
    .trim();

export type ToolAccessManagerOptions = {
  state: Pick<RuntimeState, "createToolSession" | "touchSession" | "requireSession" | "logout">;
  /** The user whose library the runtime has open (null: nobody signed in). A grant binds to it at approval. */
  activeUserId: () => string | null;
  /** True when a first-party app is listening for the prompt (no listener: no request). */
  hasPromptReceiver: () => boolean;
  /** Push the full state to the apps. */
  publish: (snapshot: ToolAccessSnapshot) => void;
  clock?: () => number;
  /** A grant ended (revoked, expired, other user, reset): what hangs off it ends too. */
  onGrantEnded?: (grantId: string) => void;
  /** Where web grants are kept across restarts (PLAT-WEB-06); none: they die with the runtime too. */
  store?: ToolGrantStore;
};

/** Longest origin shown in the prompt's tool name; the name itself is trimmed so both fit. */
const ORIGIN_LABEL_MAX_LENGTH = 40;

/** `toolName (origin)` within {@link TOOL_NAME_MAX_LENGTH}: the user sees which site asks. */
const labelWithOrigin = (rawToolName: string, origin: string | null): string => {
  if (!origin) return sanitizeToolLabel(rawToolName, TOOL_NAME_MAX_LENGTH);
  const suffix = ` (${sanitizeToolLabel(origin, ORIGIN_LABEL_MAX_LENGTH)})`;
  const name = sanitizeToolLabel(rawToolName, TOOL_NAME_MAX_LENGTH - suffix.length);
  return name ? `${name}${suffix}` : "";
};

export class ToolAccessManager {
  private readonly requests = new Map<string, AccessRequest>();
  private readonly grants = new Map<string, Grant>();
  private requestTimes: number[] = [];
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private lastUsePublishAt = 0;
  private readonly deniedNames = new Map<string, number>();
  private denialCooldownUntil = 0;
  private lastPublished = "";
  private readonly clock: () => number;

  constructor(private readonly options: ToolAccessManagerOptions) {
    this.clock = options.clock ?? (() => Date.now());
    // PLAT-WEB-06: web grants from before the restart wait, without a session, for their tool's next call.
    for (const stored of options.store?.load() ?? []) {
      this.grants.set(stored.id, {
        id: stored.id,
        toolName: stored.toolName,
        mode: stored.mode,
        userId: stored.userId,
        grantedAt: stored.grantedAt,
        lastUsedAt: stored.lastUsedAt,
        token: null,
        tokenDigest: stored.tokenDigest,
        expiresAt: WEB_GRANT_EXPIRES_AT,
        origin: stored.origin,
        persistent: true,
      });
    }
  }

  /**
   * Tool side, step 1. `origin` is the browser origin the route allowed
   * (PLAT-WEB-05), null for a tool outside any browser.
   */
  request(
    input: {
      toolName: string;
      reason?: string | undefined;
      mode: ToolAccessMode;
    },
    origin: string | null
  ): { ok: true; requestId: string; pollSecret: string; verificationCode: string; expiresAt: string } | ToolAccessFailure {
    const now = this.clock();
    this.purge(now);
    const toolName = labelWithOrigin(input.toolName, origin);
    const reason = input.reason ? sanitizeToolLabel(input.reason, TOOL_REASON_MAX_LENGTH) : "";
    if (!toolName) return fail(400, TOOL_ACCESS_ERRORS.invalidPayload, "toolName has no printable characters");

    const deniedUntil = Math.max(this.deniedNames.get(toolName.toLowerCase()) ?? 0, this.denialCooldownUntil);
    if (deniedUntil > now) {
      return fail(
        429,
        TOOL_ACCESS_ERRORS.rateLimited,
        "An access request was denied recently; try again later.",
        Math.max(1, Math.ceil((deniedUntil - now) / 1000))
      );
    }
    this.requestTimes = this.requestTimes.filter((at) => now - at < TOOL_ACCESS_LIMITS.rateLimitWindowMs);
    if (this.requestTimes.length >= TOOL_ACCESS_LIMITS.rateLimitMax) {
      const retry = Math.max(1, Math.ceil((this.requestTimes[0]! + TOOL_ACCESS_LIMITS.rateLimitWindowMs - now) / 1000));
      return fail(429, TOOL_ACCESS_ERRORS.rateLimited, "Too many access requests; try again shortly.", retry);
    }
    this.requestTimes.push(now);

    if (!this.options.hasPromptReceiver()) {
      return fail(409, TOOL_ACCESS_ERRORS.noAppConnected, "Open SpaceFleet, then try again: the app asks you to approve this tool.");
    }
    const live = this.livePending(now);
    const key = toolName.toLowerCase();
    if (live.some((entry) => entry.toolName.toLowerCase() === key)) {
      return fail(409, TOOL_ACCESS_ERRORS.alreadyPending, "A request from this tool is already waiting for approval.");
    }
    if (live.length >= TOOL_ACCESS_LIMITS.maxPending) {
      return fail(429, TOOL_ACCESS_ERRORS.tooManyPending, "Too many access requests are waiting for approval.", 30);
    }

    const pollSecret = randomBytes(32).toString("base64url");
    const entry: AccessRequest = {
      id: `ar_${randomUUID()}`,
      toolName,
      reason: reason || null,
      mode: input.mode,
      verificationCode: String(randomInt(0, 1_000_000)).padStart(6, "0"),
      pollSecretDigest: digest(pollSecret),
      requestedAt: now,
      expiresAt: now + TOOL_ACCESS_LIMITS.requestTtlMs,
      state: "pending",
      grantedMode: null,
      approvedByUserId: null,
      pollFailures: 0,
      origin,
    };
    this.requests.set(entry.id, entry);
    this.ensureSweeper();
    this.publishState();
    return {
      ok: true,
      requestId: entry.id,
      pollSecret,
      verificationCode: entry.verificationCode,
      expiresAt: new Date(entry.expiresAt).toISOString(),
    };
  }

  /** App side: approve (optionally with less than asked) or deny a pending request. */
  decide(requestId: string, decision: "approve" | "deny", mode?: ToolAccessMode): { ok: true } | ToolAccessFailure {
    const now = this.clock();
    this.purge(now);
    const entry = this.requests.get(requestId);
    if (!entry) return fail(404, TOOL_ACCESS_ERRORS.notFound, "No such request.");
    if (entry.state !== "pending") return fail(409, TOOL_ACCESS_ERRORS.alreadyDecided, "This request was already decided.");
    if (entry.expiresAt <= now) return fail(410, TOOL_ACCESS_ERRORS.expired, "This request expired.");
    if (decision === "approve") {
      if (mode === "write" && entry.mode === "read") {
        return fail(400, TOOL_ACCESS_ERRORS.invalidPayload, "A request cannot be approved for more than it asked.");
      }
      // The grant is for the user whose library is open now.
      const userId = this.options.activeUserId();
      if (!userId) return fail(409, TOOL_ACCESS_ERRORS.libraryLocked, "Sign in on the desktop app first.");
      entry.state = "approved";
      entry.grantedMode = mode ?? entry.mode;
      entry.approvedByUserId = userId;
      entry.expiresAt = now + TOOL_ACCESS_LIMITS.claimWindowMs;
    } else {
      entry.state = "denied";
      entry.expiresAt = now + TOOL_ACCESS_LIMITS.claimWindowMs;
      // A denial costs the sender nothing, so make repeating it cost time: this name waits
      // minutes, and everyone waits a moment, so a flood cannot keep opening prompts.
      this.deniedNames.set(entry.toolName.toLowerCase(), now + TOOL_ACCESS_LIMITS.deniedNameCooldownMs);
      this.denialCooldownUntil = now + TOOL_ACCESS_LIMITS.deniedGlobalCooldownMs;
    }
    this.publishState();
    return { ok: true };
  }

  /**
   * Tool side, step 3: `pollSecret` is the only credential, and the token goes
   * only to the origin that asked (`origin` null: no browser).
   */
  poll(
    requestId: string,
    pollSecret: string,
    origin: string | null
  ):
    | { ok: true; status: 202 }
    | { ok: true; status: 200; body: ToolAccessTokenResponse }
    | ToolAccessFailure {
    const now = this.clock();
    this.purge(now);
    const entry = this.requests.get(requestId);
    if (!entry) return fail(404, TOOL_ACCESS_ERRORS.notFound, "No such request.");
    if (!timingSafeEqual(digest(pollSecret), entry.pollSecretDigest)) {
      entry.pollFailures += 1;
      if (entry.pollFailures >= TOOL_ACCESS_LIMITS.maxPollFailures) {
        this.requests.delete(entry.id);
        this.publishState();
      }
      return fail(401, TOOL_ACCESS_ERRORS.invalidPollSecret, "Wrong poll secret.");
    }
    if (entry.origin !== origin) {
      return fail(403, TOOL_ACCESS_ERRORS.forbiddenOrigin, "This request was made from another origin.");
    }
    if (entry.state === "claimed") return fail(410, TOOL_ACCESS_ERRORS.claimed, "The token of this request was already collected.");
    if (entry.expiresAt <= now) {
      if (entry.state === "pending") this.publishState();
      return fail(410, TOOL_ACCESS_ERRORS.expired, "This request expired.");
    }
    if (entry.state === "pending") return { ok: true, status: 202 };
    if (entry.state === "denied") return fail(403, TOOL_ACCESS_ERRORS.denied, "The user denied this request.");

    const mode = entry.grantedMode ?? entry.mode;
    const userId = entry.approvedByUserId;
    if (!userId) return fail(409, TOOL_ACCESS_ERRORS.libraryLocked, "Sign in on the desktop app first.");
    const grantId = `gr_${randomUUID()}`;
    // PLAT-WEB-06: a web grant lasts until revoke or sign-out; any other tool keeps the 8 h / 30 min limits.
    const persistent = entry.origin !== null;
    const session = persistent
      ? this.options.state.createToolSession(grantId, null, null)
      : this.options.state.createToolSession(grantId, TOOL_ACCESS_LIMITS.sessionTtlMs, TOOL_ACCESS_LIMITS.sessionIdleMs);
    this.grants.set(grantId, {
      id: grantId,
      toolName: entry.toolName,
      mode,
      userId,
      grantedAt: now,
      lastUsedAt: null,
      token: session.token,
      tokenDigest: digestHex(session.token),
      expiresAt: persistent ? WEB_GRANT_EXPIRES_AT : session.expiresAt,
      origin: entry.origin,
      persistent,
    });
    if (persistent) this.persist();
    entry.state = "claimed";
    entry.expiresAt = now;
    this.ensureSweeper();
    this.publishState();
    return {
      ok: true,
      status: 200,
      body: {
        token: session.token,
        expiresAt: new Date(persistent ? WEB_GRANT_EXPIRES_AT : session.expiresAt).toISOString(),
        grantId,
        mode,
        allowedOps: toolOperationsForMode(mode),
      },
    };
  }

  /**
   * Decide whether the bearer of `token` may call `operation` now, from
   * `origin` (the request's browser origin, null for none), and count the call
   * as use. The one gate of the tool routes: a grant that was revoked or ran
   * out has no live session and fails here; a grant made from one origin works
   * from that origin only.
   */
  authorize(
    token: string,
    operation: ToolOperation,
    origin: string | null
  ): { ok: true; grantId: string } | ToolAccessFailure {
    const session = this.options.state.requireSession(token);
    const live = session?.kind === "tool" && session.grantId ? this.grants.get(session.grantId) : undefined;
    const grant = live ?? (session ? undefined : this.storedGrantFor(token));
    if (!grant || (live && grant.token !== token)) {
      return fail(401, TOOL_ACCESS_ERRORS.unauthorized, "Unknown or expired tool token.");
    }
    if (grant.origin !== origin) {
      console.info("[handoff] tool token refused: origin differs from the grant's", {
        grantId: grant.id,
        grantOrigin: grant.origin,
        origin,
      });
      return fail(403, TOOL_ACCESS_ERRORS.forbiddenOrigin, "This token was granted to another origin.");
    }
    if (isToolWriteOperation(operation) && grant.mode !== "write") {
      return fail(403, TOOL_ACCESS_ERRORS.writeNotGranted, "This tool was granted read access only.");
    }
    // A grant belongs to the user who approved it: once another user (or nobody) is active, it ends.
    // A web grant waits out "nobody" instead (PLAT-WEB-06): after a restart the desktop app has not pushed its key yet.
    const activeUserId = this.options.activeUserId();
    if (grant.persistent && activeUserId === null) {
      return fail(423, TOOL_ACCESS_ERRORS.libraryLocked, "The library is locked. Open SpaceFleet and unlock your library, then try again.");
    }
    if (grant.userId !== activeUserId) {
      this.revoke(grant.id);
      return fail(401, TOOL_ACCESS_ERRORS.unauthorized, "The user who approved this tool is no longer signed in.");
    }
    if (grant.token === null) {
      // First call after a restart: re-open the stored web grant under the token its tool kept.
      this.options.state.createToolSession(grant.id, null, null, token);
      grant.token = token;
      console.info("[tool-access] web grant restored after a restart", { grantId: grant.id, origin: grant.origin });
    }
    const now = this.clock();
    this.options.state.touchSession(token);
    grant.lastUsedAt = now;
    if (now - this.lastUsePublishAt >= TOOL_ACCESS_LIMITS.usePublishMinIntervalMs) {
      this.lastUsePublishAt = now;
      if (grant.persistent) this.persist();
      this.publishState();
    }
    return { ok: true, grantId: grant.id };
  }

  /** Revoke a grant: its session ends this instant (HTTP, and any stream the token held). */
  revoke(grantId: string): boolean {
    const grant = this.grants.get(grantId);
    if (!grant) return false;
    this.grants.delete(grantId);
    if (grant.token) this.options.state.logout(grant.token);
    if (grant.persistent) this.persist();
    this.options.onGrantEnded?.(grantId);
    this.publishState();
    return true;
  }

  /** Pending requests and active grants; carries no secret. */
  snapshot(): ToolAccessSnapshot {
    const now = this.clock();
    this.purge(now);
    this.dropDeadGrants();
    return {
      pending: this.livePending(now).map(
        (entry): ToolAccessPending => ({
          requestId: entry.id,
          toolName: entry.toolName,
          reason: entry.reason,
          mode: entry.mode,
          verificationCode: entry.verificationCode,
          requestedAt: new Date(entry.requestedAt).toISOString(),
          expiresAt: new Date(entry.expiresAt).toISOString(),
        })
      ),
      grants: [...this.grants.values()].map(
        (grant): ToolAccessGrant => ({
          grantId: grant.id,
          toolName: grant.toolName,
          mode: grant.mode,
          grantedAt: new Date(grant.grantedAt).toISOString(),
          lastUsedAt: grant.lastUsedAt === null ? null : new Date(grant.lastUsedAt).toISOString(),
          expiresAt: new Date(grant.expiresAt).toISOString(),
        })
      ),
    };
  }

  /** Revoke every grant, stored ones included, and forget every request (tests). */
  reset() {
    for (const grant of this.grants.values()) if (grant.token) this.options.state.logout(grant.token);
    const hadStored = [...this.grants.values()].some((grant) => grant.persistent);
    this.grants.clear();
    this.requests.clear();
    this.requestTimes = [];
    this.deniedNames.clear();
    this.denialCooldownUntil = 0;
    this.lastUsePublishAt = 0;
    this.lastPublished = "";
    this.stopSweeper();
    if (hadStored) this.persist();
  }

  /** Revoke every grant, web grants included (desktop sign-out, library closed). Returns how many ended. */
  revokeAll(): number {
    return this.revokeWhere(() => true);
  }

  /**
   * Runtime shutdown: the time-limited grants end, web grants stay stored for
   * the next start (PLAT-WEB-06). Returns how many ended.
   */
  revokeTimeLimited(): number {
    return this.revokeWhere((grant) => !grant.persistent);
  }

  /** Revoke the grants approved for any user but `userId` (another account's key arrived). */
  revokeForOtherUsers(userId: string): number {
    return this.revokeWhere((grant) => grant.userId !== userId);
  }

  private revokeWhere(match: (grant: Grant) => boolean): number {
    let revoked = 0;
    let storedRevoked = false;
    for (const [id, grant] of this.grants) {
      if (!match(grant)) continue;
      this.grants.delete(id);
      if (grant.token) this.options.state.logout(grant.token);
      if (grant.persistent) storedRevoked = true;
      this.options.onGrantEnded?.(id);
      revoked += 1;
    }
    if (storedRevoked) this.persist();
    if (revoked > 0) this.publishState();
    return revoked;
  }

  /** Whether `token` opens a stored web grant that has no session since the restart (PLAT-WEB-06). */
  hasStoredGrant(token: string): boolean {
    return this.storedGrantFor(token) !== undefined;
  }

  /** The stored web grant (no session since the restart) whose token is `token`, if any. */
  private storedGrantFor(token: string): Grant | undefined {
    const wanted = digest(token);
    for (const grant of this.grants.values()) {
      if (grant.token === null && timingSafeEqual(Buffer.from(grant.tokenDigest, "hex"), wanted)) return grant;
    }
    return undefined;
  }

  /** Write the web grants to the store (PLAT-WEB-06): digests only, never a token. */
  private persist() {
    const store = this.options.store;
    if (!store) return;
    const stored: PersistedToolGrant[] = [];
    for (const grant of this.grants.values()) {
      if (!grant.persistent || grant.origin === null) continue;
      stored.push({
        id: grant.id,
        toolName: grant.toolName,
        mode: grant.mode,
        userId: grant.userId,
        origin: grant.origin,
        grantedAt: grant.grantedAt,
        lastUsedAt: grant.lastUsedAt,
        tokenDigest: grant.tokenDigest,
      });
    }
    store.save(stored);
  }

  private livePending(now: number): AccessRequest[] {
    return [...this.requests.values()].filter((entry) => entry.state === "pending" && entry.expiresAt > now);
  }

  /** Drop finished requests past their tombstone time. */
  private purge(now: number) {
    for (const [id, entry] of this.requests) {
      if (entry.expiresAt + TOOL_ACCESS_LIMITS.tombstoneMs <= now) this.requests.delete(id);
    }
  }

  /** Forget grants whose session ended on its own (absolute TTL or idle timeout). A web grant has neither. */
  private dropDeadGrants(): boolean {
    let dropped = false;
    for (const [id, grant] of this.grants) {
      if (grant.persistent || grant.token === null) continue;
      if (!this.options.state.requireSession(grant.token)) {
        this.grants.delete(id);
        this.options.onGrantEnded?.(id);
        dropped = true;
      }
    }
    return dropped;
  }

  private publishState() {
    const snapshot = this.snapshot();
    this.lastPublished = JSON.stringify(snapshot);
    this.options.publish(snapshot);
  }

  /** Tell the apps about whatever ran out on its own since the last push (a prompt that timed out, an idle grant). */
  private sweep() {
    if (JSON.stringify(this.snapshot()) !== this.lastPublished) this.publishState();
    if (this.requests.size === 0 && this.grants.size === 0) this.stopSweeper();
  }

  private ensureSweeper() {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), TOOL_ACCESS_LIMITS.sweepIntervalMs);
    // Never keep the runtime alive for a sweep.
    this.sweepTimer.unref?.();
  }

  private stopSweeper() {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}
