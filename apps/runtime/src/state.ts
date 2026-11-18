import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppId, RuntimeCommandResponse, RuntimeEventFrame, WsClientFrame } from "./types";
import { DESKTOP_HANDOFF_CHANNEL, TOOL_ACCESS_CHANNEL } from "@space/tool-access/contracts";
import { APP_IDS } from "./types";
import { discoverRuntimeModules, type RuntimeModuleRecord } from "./slices";
import { runtimeJobsStore } from "./core/jobs/store";

/**
 * `app`: a first-party app that logged in with the owner secret. `tool`: a
 * third-party tool the user approved (DEV-LIB-01); it holds no backend token,
 * no app scope and can reach nothing but the tool allowlist (`core/toolAccess.ts`).
 */
export type SessionKind = "app" | "tool";

type Session = {
  token: string;
  kind: SessionKind;
  /** The grant a `tool` session was issued for; null for apps. */
  grantId: string | null;
  backendToken: string;
  userId: string | null;
  scopes: Set<AppId>;
  /** Absolute end of life. */
  expiresAt: number;
  /** Sliding window: a `tool` session unused for this long ends. Null: no idle limit (apps). */
  idleTimeoutMs: number | null;
  lastActiveAt: number;
};

/** Past its absolute end of life, or (tool sessions) idle for longer than its sliding window. */
const isSessionDead = (session: Session, now: number) =>
  session.expiresAt <= now || (session.idleTimeoutMs !== null && now - session.lastActiveAt >= session.idleTimeoutMs);

type Subscriber = {
  token: string;
  apps: Set<AppId>;
  channels: Set<string>;
  send: (frame: RuntimeEventFrame) => void;
  /** Ends the transport; called when the subscriber is dropped for a dead session. */
  close?: () => void;
};

/** WebSocket close code for a subscriber whose session ended; clients re-login and reconnect. */
export const WS_CLOSE_SESSION_EXPIRED = 4401;

type AppConnection = {
  connectionId: string;
  appName: string;
  pid: number;
  connectedAt: string;
  token: string;
};

const channelKey = (app: AppId, channel: string) => `${app}:${channel}`;
const isGlobalRuntimeChannel = (value: string) => value.startsWith("runtime.");
const idempotencyKey = (token: string, requestId: string) => `${token}\u0000${requestId}`;
/**
 * Channels delivered live to first-party app sessions only, never kept in the
 * replay ring nor written to disk: tool-access frames carry verification codes,
 * and a desktop hand-off (`badger.handoff`, PLAT-WEB-04) replayed later would
 * start a movie nobody is waiting for.
 */
const LIVE_APP_ONLY_CHANNELS: ReadonlySet<string> = new Set([TOOL_ACCESS_CHANNEL, DESKTOP_HANDOFF_CHANNEL]);

type CachedCommandResult = {
  token: string;
  response: RuntimeCommandResponse;
  expiresAt: number;
};

const hasLibrarySnapshot = (frame: RuntimeEventFrame) =>
  frame.event === "badger.library.updated" &&
  frame.payload !== null &&
  typeof frame.payload === "object" &&
  "snapshot" in frame.payload;
const withoutLibrarySnapshot = (frame: RuntimeEventFrame): RuntimeEventFrame => {
  const { snapshot: _drop, ...rest } = frame.payload;
  return { ...frame, payload: rest };
};

/**
 * Build the on-disk form of the events ring. Only the `opened` frame of
 * `badger.library.updated` embeds the library snapshot (~1.1 MB); every
 * other frame carries `version`, `previousVersion` and `changedMediaIds`
 * (#671 R3). No consumer of the REPLAYED-FROM-DISK form reads
 * `payload.snapshot` (desktop's `handleLibraryEvent` re-fetches the snapshot
 * via `badger.db.snapshot` when it has no cache to merge into). Drop the
 * snapshot field at persistence time so the on-disk ring stays ~50 KB
 * instead of accumulating to ~11 MB.
 *
 * Pure + exported for unit tests; the function returns a shallow-copied
 * sequence and never mutates the live ring.
 */
export const stripSnapshotsForPersistence = (
  events: readonly RuntimeEventFrame[]
): RuntimeEventFrame[] => events.map((frame) => (hasLibrarySnapshot(frame) ? withoutLibrarySnapshot(frame) : frame));

export class RuntimeState {
  /**
   * Command idempotency cache bounds (#25). The cache only has to cover a
   * client retrying the SAME requestId moments later, but it used to keep
   * every response for the token's whole 1 h lifetime — including every
   * ~1 MB `badger.db.snapshot` result the desktop pulls after each library
   * write — which grew the runtime to several GB in stress runs. One map for
   * all tokens, insertion-ordered, so the oldest entry is evicted first.
   */
  static readonly IDEMPOTENCY_MAX_ENTRIES = 128;
  static readonly IDEMPOTENCY_TTL_MS = 30_000;

  private sessions = new Map<string, Session>();
  private idempotency = new Map<string, CachedCommandResult>();
  private modules = new Map<AppId, RuntimeModuleRecord>();
  private sequenceByChannel = new Map<string, number>();
  private events: RuntimeEventFrame[] = [];
  private subscribers = new Map<string, Subscriber>();
  private resetHooks: Array<() => void> = [];
  private connections = new Map<string, AppConnection>();
  private eventsPersistencePath: string | null = null;
  // Persistence is debounced + async: bursty publishes coalesce into a single
  // write, and the write itself never blocks the event loop. Without this,
  // every publish() ran a sync JSON.stringify + writeFileSync of the entire
  // 500-event ring (≈20 MB pretty-printed when library.updated payloads were
  // present), pinning the main thread at ~2 publishes/s.
  // Persisted form also drops the snapshot field from badger.library.updated
  // frames (see stripSnapshotsForPersistence) — the on-disk ring is for
  // replay only and no consumer reads the embedded snapshot.
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistInFlight: Promise<void> | null = null;
  private persistDirty = false;
  private static readonly PERSIST_DEBOUNCE_MS = 250;

  constructor(
    private readonly tokenTtlMs: number,
    private readonly eventRetention: number,
    private readonly runtimeApiVersion: string,
    private readonly slicesRoot: string
  ) {
    this.reloadModuleInstallState();
  }

  reloadModuleInstallState(options?: { slicesRoot?: string; runtimeApiVersion?: string }) {
    this.modules = discoverRuntimeModules({
      slicesRoot: options?.slicesRoot ?? this.slicesRoot,
      runtimeApiVersion: options?.runtimeApiVersion ?? this.runtimeApiVersion,
    });
  }

  login(backendToken: string, scopes: AppId[] | null, userId?: string | null) {
    const token = `rt_${crypto.randomUUID()}`;
    const allowed = new Set<AppId>((scopes?.length ? scopes : APP_IDS));
    const now = Date.now();
    // Sessions are only evicted when their token is presented again, so a
    // client that re-logs in (every desktop runtime client does after a
    // runtime restart / 401) would leave its old session behind forever.
    for (const [staleToken, session] of this.sessions) {
      if (isSessionDead(session, now)) this.logout(staleToken);
    }
    this.sessions.set(token, {
      token,
      kind: "app",
      grantId: null,
      backendToken,
      userId: userId?.trim() || null,
      scopes: allowed,
      expiresAt: now + this.tokenTtlMs,
      idleTimeoutMs: null,
      lastActiveAt: now,
    });
    return {
      token,
      expiresAt: new Date(now + this.tokenTtlMs).toISOString(),
      scopes: [...allowed],
    };
  }

  /**
   * Open the session of an approved tool (DEV-LIB-01). Only
   * `ToolAccessManager` calls this, never a route: it carries no backend
   * token, no user and no app scope, so nothing but the tool allowlist
   * can be done with it. Memory only, like every session.
   *
   * `ttlMs` null: no absolute end (PLAT-WEB-06 web grants end on revoke or
   * sign-out only). `token`: re-open a grant restored after a restart under the
   * token its tool still holds; otherwise a fresh one.
   */
  createToolSession(grantId: string, ttlMs: number | null, idleTimeoutMs: number | null, token = `rt_${crypto.randomUUID()}`) {
    const now = Date.now();
    const expiresAt = ttlMs === null ? Number.POSITIVE_INFINITY : now + ttlMs;
    this.sessions.set(token, {
      token,
      kind: "tool",
      grantId,
      backendToken: "",
      userId: null,
      scopes: new Set<AppId>(),
      expiresAt,
      idleTimeoutMs,
      lastActiveAt: now,
    });
    return { token, expiresAt };
  }

  /** A real request used the session: slide its idle window. */
  touchSession(token: string) {
    const session = this.sessions.get(token);
    if (session) session.lastActiveAt = Date.now();
  }

  /** Number of live subscribers of first-party app sessions that would receive `channel` of `app`. */
  countAppSubscribers(app: AppId, channel: string) {
    let count = 0;
    for (const sub of [...this.subscribers.values()]) {
      if (sub.apps.has(app) && sub.channels.has(channel) && this.requireSession(sub.token)?.kind === "app") count += 1;
    }
    return count;
  }

  /** Run `hook` whenever {@link resetForTests} wipes the state (stores that live next to it). */
  onResetForTests(hook: () => void) {
    this.resetHooks.push(hook);
  }

  refresh(token: string) {
    const session = this.requireSession(token);
    // A tool session is never renewed: it ends at its absolute TTL and the tool asks again.
    if (!session || session.kind !== "app") return null;

    const nextToken = `rt_${crypto.randomUUID()}`;
    const now = Date.now();
    this.sessions.delete(token);
    this.dropCachedResults(token);
    this.sessions.set(nextToken, {
      ...session,
      token: nextToken,
      expiresAt: now + this.tokenTtlMs,
    });
    for (const [id, sub] of [...this.subscribers.entries()]) {
      if (sub.token === token) this.dropSubscriber(id);
    }
    return {
      token: nextToken,
      expiresAt: new Date(now + this.tokenTtlMs).toISOString(),
      scopes: [...session.scopes],
    };
  }

  logout(token: string) {
    this.sessions.delete(token);
    this.dropCachedResults(token);
    for (const [id, sub] of [...this.subscribers.entries()]) {
      if (sub.token === token) this.dropSubscriber(id);
    }
  }

  requireSession(token: string) {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (isSessionDead(session, Date.now())) {
      this.logout(token);
      return null;
    }
    return session;
  }

  canAccess(token: string, app: AppId) {
    const session = this.requireSession(token);
    if (!session) return false;
    return session.scopes.has(app);
  }

  getModules() {
    return [...this.modules.values()].map((entry) => ({
      app: entry.app,
      installed: entry.installed,
      ready: entry.ready,
      status: entry.status,
      compatibility: entry.compatibility,
      sliceId: entry.sliceId,
      sliceVersion: entry.sliceVersion,
      loadError: entry.loadError,
    }));
  }

  getModule(app: AppId) {
    return this.modules.get(app) ?? null;
  }

  getCachedResult(token: string, requestId: string): RuntimeCommandResponse | null {
    const key = idempotencyKey(token, requestId);
    const entry = this.idempotency.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.idempotency.delete(key);
      return null;
    }
    return entry.response;
  }

  setCachedResult(token: string, requestId: string, response: RuntimeCommandResponse) {
    const now = Date.now();
    const key = idempotencyKey(token, requestId);
    // Re-insert so a re-cached key moves to the young end of the order.
    this.idempotency.delete(key);
    this.idempotency.set(key, { token, response, expiresAt: now + RuntimeState.IDEMPOTENCY_TTL_MS });
    // Map iteration is insertion order and every entry has the same TTL, so
    // the front of the map is always the oldest: evict expired entries, then
    // the oldest live ones until the cap holds.
    for (const [oldKey, entry] of this.idempotency) {
      if (entry.expiresAt > now && this.idempotency.size <= RuntimeState.IDEMPOTENCY_MAX_ENTRIES) break;
      this.idempotency.delete(oldKey);
    }
  }

  private dropCachedResults(token: string) {
    for (const [key, entry] of this.idempotency) {
      if (entry.token === token) this.idempotency.delete(key);
    }
  }

  /**
   * Sizes of every structure that grows with traffic, for the periodic
   * `[runtime] memory` log line and the bounded-memory regression tests (#25).
   */
  getMemoryStats() {
    let retainedLibrarySnapshots = 0;
    for (const frame of this.events) if (hasLibrarySnapshot(frame)) retainedLibrarySnapshots += 1;
    return {
      sessions: this.sessions.size,
      idempotencyEntries: this.idempotency.size,
      events: this.events.length,
      retainedLibrarySnapshots,
      subscribers: this.subscribers.size,
      connections: this.connections.size,
    };
  }

  connect(token: string, appName: string, pid: number) {
    const connectionId = `conn_${crypto.randomUUID()}`;
    const connection: AppConnection = {
      connectionId,
      appName,
      pid,
      connectedAt: new Date().toISOString(),
      token,
    };
    this.connections.set(connectionId, connection);
    return {
      connectionId,
      connectedApps: this.getConnections(),
    };
  }

  disconnect(connectionId: string): { found: boolean; remaining: number } {
    const found = this.connections.delete(connectionId);
    return { found, remaining: this.connections.size };
  }

  /**
   * Connections an app named in `scopes` owns (`appName` is the app id). Pass
   * the session's scopes on every request path (RT-SEC-03); omit them only for
   * the runtime's own lifecycle bookkeeping.
   */
  getConnections(scopes?: ReadonlySet<string>) {
    return [...this.connections.values()]
      .filter((c) => !scopes || scopes.has(c.appName))
      .map((c) => ({
        connectionId: c.connectionId,
        appName: c.appName,
        connectedAt: c.connectedAt,
      }));
  }

  /** The `appName` a connection was opened for, or `null` when unknown. */
  getConnectionApp(connectionId: string) {
    return this.connections.get(connectionId)?.appName ?? null;
  }

  getConnectionCount() {
    return this.connections.size;
  }

  getConnectionsWithPids() {
    return [...this.connections.values()].map((c) => ({
      connectionId: c.connectionId,
      pid: c.pid,
    }));
  }

  configureEventPersistence(filePath: string | null) {
    this.eventsPersistencePath = filePath;
    this.loadPersistedEvents();
  }

  publish(app: AppId, channel: string, event: string, payload: Record<string, unknown>) {
    const scopedChannel = isGlobalRuntimeChannel(channel) ? channel : `${app}.${channel}`;
    const scopedEvent = isGlobalRuntimeChannel(event) ? event : `${app}.${event}`;
    const key = channelKey(app, scopedChannel);
    const nextSequence = (this.sequenceByChannel.get(key) ?? 0) + 1;
    this.sequenceByChannel.set(key, nextSequence);
    const frame: RuntimeEventFrame = {
      eventId: crypto.randomUUID(),
      sequence: nextSequence,
      app,
      channel: scopedChannel,
      event: scopedEvent,
      ts: new Date().toISOString(),
      payload,
    };
    // Only the newest `badger.library.updated` frame in the ring keeps its
    // full library snapshot (~1 MB each, #25). Live subscribers get every
    // snapshot below; a replaying consumer re-fetches via badger.db.snapshot
    // like it already does for the disk-replayed ring. Frames are replaced,
    // never mutated, so a frame already handed to a subscriber is intact.
    if (hasLibrarySnapshot(frame)) {
      for (let i = 0; i < this.events.length; i += 1) {
        if (hasLibrarySnapshot(this.events[i]!)) this.events[i] = withoutLibrarySnapshot(this.events[i]!);
      }
    }
    // Live-only frames (tool access, desktop hand-off) skip the replay ring and
    // the disk (a reconnecting app reads `GET /runtime/access/snapshot` instead).
    const liveAppOnly = LIVE_APP_ONLY_CHANNELS.has(scopedChannel);
    if (!liveAppOnly) {
      this.events.push(frame);
      if (this.events.length > this.eventRetention) {
        this.events.splice(0, this.events.length - this.eventRetention);
      }
      this.persistEvents();
    }
    for (const [id, sub] of this.subscribers) {
      // Delivery re-checks the session on every frame (RT-SEC-03): a logged
      // out or expired session drops its subscriber, and a frame only goes to
      // an app the session is scoped to.
      const session = this.requireSession(sub.token);
      if (!session) {
        this.dropSubscriber(id);
        continue;
      }
      if (!sub.apps.has(app) || !session.scopes.has(app)) continue;
      if (!sub.channels.has(frame.channel)) continue;
      if (liveAppOnly && session.kind !== "app") continue;
      sub.send(frame);
    }
    return frame;
  }

  addSubscriber(id: string, token: string, send: (frame: RuntimeEventFrame) => void, close?: () => void) {
    this.subscribers.set(id, {
      token,
      apps: new Set<AppId>(),
      channels: new Set<string>(),
      send,
      ...(close ? { close } : {}),
    });
  }

  /** Forget a subscriber whose session is gone and end its transport. */
  private dropSubscriber(id: string) {
    const sub = this.subscribers.get(id);
    this.subscribers.delete(id);
    try {
      sub?.close?.();
    } catch {
      // transport already closed
    }
  }

  removeSubscriber(id: string) {
    this.subscribers.delete(id);
  }

  applyClientFrame(id: string, frame: WsClientFrame) {
    const sub = this.subscribers.get(id);
    if (!sub) return [];
    const session = this.requireSession(sub.token);
    if (!session) {
      this.dropSubscriber(id);
      return [];
    }
    if (frame.type === "subscribe") {
      // RT-SEC-03: a client chooses what it hears about, but only inside the
      // apps its session is scoped to; other apps in the frame are dropped.
      sub.apps = new Set(frame.apps.filter((app) => session.scopes.has(app)));
      sub.channels = new Set(frame.channels);
      return [];
    }
    const index = this.events.findIndex((entry) => entry.eventId === frame.lastEventId);
    const replay = index < 0 ? this.events : this.events.slice(index + 1);
    return replay.filter(
      (entry) => sub.apps.has(entry.app) && session.scopes.has(entry.app) && sub.channels.has(entry.channel)
    );
  }

  resetForTests() {
    this.sessions.clear();
    this.idempotency.clear();
    this.events = [];
    this.sequenceByChannel.clear();
    this.subscribers.clear();
    this.connections.clear();
    this.cancelPendingPersist();
    if (this.eventsPersistencePath) rmSync(this.eventsPersistencePath, { force: true });
    runtimeJobsStore.reset({ clearPersistence: true });
    this.reloadModuleInstallState();
    for (const hook of this.resetHooks) hook();
  }

  private loadPersistedEvents() {
    this.events = [];
    this.sequenceByChannel.clear();
    if (!this.eventsPersistencePath || !existsSync(this.eventsPersistencePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.eventsPersistencePath, "utf8")) as {
        events?: RuntimeEventFrame[];
      };
      const persisted = Array.isArray(raw.events) ? raw.events : [];
      this.events = persisted
        .filter((entry): entry is RuntimeEventFrame => {
          return (
            entry &&
            typeof entry === "object" &&
            typeof entry.eventId === "string" &&
            typeof entry.sequence === "number" &&
            typeof entry.app === "string" &&
            typeof entry.channel === "string" &&
            typeof entry.event === "string" &&
            typeof entry.ts === "string" &&
            entry.payload &&
            typeof entry.payload === "object"
          );
        })
        .slice(-this.eventRetention);
      for (const entry of this.events) {
        const current = this.sequenceByChannel.get(channelKey(entry.app, entry.channel)) ?? 0;
        if (entry.sequence > current) {
          this.sequenceByChannel.set(channelKey(entry.app, entry.channel), entry.sequence);
        }
      }
    } catch {
      this.events = [];
      this.sequenceByChannel.clear();
    }
  }

  private persistEvents() {
    if (!this.eventsPersistencePath) return;
    this.persistDirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flushPersistedEvents();
    }, RuntimeState.PERSIST_DEBOUNCE_MS);
    // Don't keep the event loop alive solely for a pending events flush —
    // the process should shut down cleanly even if a flush is queued.
    this.persistTimer.unref?.();
  }

  /**
   * Force the pending debounced flush to run now and resolve once on-disk
   * state is current. Used by tests that need to assert the persisted file
   * after a publish() and by graceful-shutdown paths.
   */
  async flushPersistedEventsForShutdown(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.flushPersistedEvents();
  }

  private async flushPersistedEvents(): Promise<void> {
    const target = this.eventsPersistencePath;
    if (!target) return;
    // Serialize against a write already in flight; mark dirty so the
    // current writer notices and re-runs after it finishes.
    if (this.persistInFlight) return;
    if (!this.persistDirty) return;
    this.persistDirty = false;
    const snapshot = JSON.stringify({
      events: stripSnapshotsForPersistence(this.events),
    });
    const tmpPath = `${target}.tmp`;
    this.persistInFlight = (async () => {
      try {
        mkdirSync(dirname(target), { recursive: true });
        await writeFile(tmpPath, snapshot);
        await rename(tmpPath, target);
      } catch {
        // Best-effort persistence; replay tolerates a missing/stale file.
      }
    })();
    try {
      await this.persistInFlight;
    } finally {
      this.persistInFlight = null;
      // If new events landed while we were writing, schedule another flush.
      if (this.persistDirty) {
        this.persistEvents();
      }
    }
  }

  /**
   * Cancel any pending debounced flush. Used by `resetForTests` so the
   * timer doesn't fire after the file has been unlinked.
   */
  private cancelPendingPersist() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistDirty = false;
  }
}
