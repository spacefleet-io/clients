/**
 * DEV-LIB-01: the desktop's side of tool access grants. Third-party tools ask the
 * local runtime for access; the runtime publishes the pending request (and the
 * current grants) as `runtime.access.updated` frames to app sessions only. This
 * bridge holds Badger's runtime session, forwards those snapshots to the
 * renderer, and relays the user's decision (approve / deny / revoke) back with
 * that session. The renderer never talks to the runtime's grant routes itself.
 * Electron is imported as types only so the bridge stays unit-testable.
 */
import type { BrowserWindow, IpcMain } from "electron";
import {
  TOOL_ACCESS_EVENT,
  TOOL_ACCESS_CHANNEL,
  toolAccessDecisionSchema,
  toolAccessSnapshotSchema,
  type ToolAccessMode,
  type ToolAccessSnapshot,
} from "@space/tool-access/contracts";
import { createRuntimeSession, type RuntimeSessionHandle } from "@space/runtime-client/session";
import { createRuntimeEventStream, type RuntimeEventStreamHandle } from "@space/runtime-client/events";
import { runtimeOwnerSecretProvider } from "./runtimeOwnerSecret";

const DEFAULT_RUNTIME_BASE_URL = "http://127.0.0.1:3020";

export const TOOL_ACCESS_IPC = {
  snapshot: "sf-tool-access-snapshot",
  decide: "sf-tool-access-decide",
  revoke: "sf-tool-access-revoke",
  update: "sf-tool-access-update",
} as const;

const EMPTY_SNAPSHOT: ToolAccessSnapshot = { pending: [], grants: [] };

export type ToolAccessBridgeDeps = {
  getWindow: () => BrowserWindow | null;
  runtimeBaseUrl?: string;
  fetchImpl?: typeof fetch;
  createSession?: typeof createRuntimeSession;
  createStream?: typeof createRuntimeEventStream;
};

export class ToolAccessRuntimeBridge {
  private readonly runtimeBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly createSession: typeof createRuntimeSession;
  private readonly createStream: typeof createRuntimeEventStream;
  private session: RuntimeSessionHandle | null = null;
  private eventStream: RuntimeEventStreamHandle | null = null;
  private backendToken: string | null = null;

  constructor(private readonly deps: ToolAccessBridgeDeps) {
    this.runtimeBaseUrl = (deps.runtimeBaseUrl ?? process.env.SF_RUNTIME_BASE_URL ?? DEFAULT_RUNTIME_BASE_URL)
      .trim()
      .replace(/\/+$/, "");
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.createSession = deps.createSession ?? createRuntimeSession;
    this.createStream = deps.createStream ?? createRuntimeEventStream;
  }

  setAuthToken(token: string | null) {
    this.backendToken = token?.trim() || null;
    if (!this.backendToken) {
      // Signed out: what was granted to tools while this user was signed in ends with the session.
      const ending = this.session;
      this.stop();
      this.session = null;
      void this.call("DELETE", "/runtime/access/grants", undefined, ending);
      return;
    }
    if (this.session) {
      this.session.setBackendToken(this.backendToken);
    } else {
      this.session = this.createSession({
        runtimeBaseUrl: this.runtimeBaseUrl,
        backendToken: this.backendToken,
        apps: ["badger"],
        ownerSecret: runtimeOwnerSecretProvider,
      });
    }
    this.ensureEventStream();
  }

  stop() {
    this.eventStream?.stop();
    this.eventStream = null;
  }

  /** What is waiting for the user and what is granted. Empty when the runtime is not reachable or no one is signed in. */
  async getSnapshot(): Promise<ToolAccessSnapshot> {
    const response = await this.call("GET", "/runtime/access/snapshot");
    if (!response?.ok) return EMPTY_SNAPSHOT;
    const parsed = toolAccessSnapshotSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data : EMPTY_SNAPSHOT;
  }

  async decide(requestId: string, decision: "approve" | "deny", mode?: ToolAccessMode): Promise<{ ok: boolean }> {
    const response = await this.call(
      "POST",
      `/runtime/access/requests/${encodeURIComponent(requestId)}/decide`,
      mode ? { decision, mode } : { decision },
    );
    return { ok: Boolean(response?.ok) };
  }

  async revoke(grantId: string): Promise<{ ok: boolean }> {
    const response = await this.call("DELETE", `/runtime/access/grants/${encodeURIComponent(grantId)}`);
    return { ok: Boolean(response?.ok) };
  }

  private async call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    session: RuntimeSessionHandle | null = this.session,
  ): Promise<Response | null> {
    if (!session) return null;
    const send = async () =>
      this.fetchImpl(`${this.runtimeBaseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${await session.getToken()}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    try {
      let response = await send();
      if (response.status === 401) {
        // The runtime ended this session (restart, expiry): log in again once.
        session.invalidate();
        response = await send();
      }
      return response;
    } catch {
      return null;
    }
  }

  private ensureEventStream() {
    if (this.eventStream || !this.session) return;
    this.eventStream = this.createStream({
      session: this.session,
      runtimeBaseUrl: this.runtimeBaseUrl,
      apps: ["badger"],
      channels: [TOOL_ACCESS_CHANNEL],
    });
    this.eventStream.subscribe((frame) => {
      if (frame.event !== TOOL_ACCESS_EVENT) return;
      const parsed = toolAccessSnapshotSchema.safeParse(frame.payload);
      if (!parsed.success) return;
      const win = this.deps.getWindow();
      if (!win || win.isDestroyed()) return;
      win.webContents.send(TOOL_ACCESS_IPC.update, parsed.data);
    });
    void this.eventStream.start();
  }
}

const fieldOf = (payload: unknown, key: string): unknown =>
  typeof payload === "object" && payload !== null && key in payload ? Reflect.get(payload, key) : undefined;

export const registerToolAccessIpc = (ipc: IpcMain, getWindow: () => BrowserWindow | null) => {
  const bridge = new ToolAccessRuntimeBridge({ getWindow });
  ipc.handle(TOOL_ACCESS_IPC.snapshot, () => bridge.getSnapshot());
  ipc.handle(TOOL_ACCESS_IPC.decide, (_event, payload: unknown) => {
    const requestId = fieldOf(payload, "requestId");
    const decision = toolAccessDecisionSchema.safeParse({
      decision: fieldOf(payload, "decision"),
      mode: fieldOf(payload, "mode"),
    });
    if (typeof requestId !== "string" || !requestId || !decision.success) return { ok: false };
    return bridge.decide(requestId, decision.data.decision, decision.data.mode);
  });
  ipc.handle(TOOL_ACCESS_IPC.revoke, (_event, payload: unknown) => {
    const grantId = fieldOf(payload, "grantId");
    return typeof grantId === "string" && grantId ? bridge.revoke(grantId) : { ok: false };
  });
  return bridge;
};
