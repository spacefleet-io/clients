/**
 * Electron main-process side of handing the runtime's owner secret (RT-SEC-05)
 * to the app's OWN renderer. Electron-free on purpose (the event is typed
 * structurally) so the check is unit-tested; the apps register it with
 * `ipcMain.handle(RUNTIME_OWNER_SECRET_IPC_CHANNEL, createOwnerSecretIpcHandler(...))`.
 *
 * Renderers cannot read the secret file, so they ask their main process. The
 * answer goes only to a top-level frame of our own UI (the app's own packaged
 * `renderer/index.html`, or the dev server's origin in development): any other
 * `file:` page, a page the window navigated to, or a frame embedded in ours, is
 * refused. The secret is returned per call, never
 * kept by the renderer beyond the login, never put in a URL, never stored.
 */
import type { OwnerSecretProvider } from "./session";

export const RUNTIME_OWNER_SECRET_IPC_CHANNEL = "sf-runtime-owner-secret-get";

export type OwnerSecretIpcEvent = {
  senderFrame?: { url: string; parent?: unknown } | null;
};

/** What identifies the app's own UI to {@link isTrustedOwnerSecretSender}. */
export type OwnerSecretSenderPolicy = {
  /** `file:` URL of the app's own renderer entry (`pathToFileURL(<dir>/renderer/index.html).href`). */
  rendererIndexFileUrl: string;
  /** Origins of dev servers that may ask in development, e.g. `http://localhost:5173`. */
  allowedOrigins?: readonly string[];
};

export type OwnerSecretIpcOptions = OwnerSecretSenderPolicy & {
  /** Current secret, read fresh (see `readOwnerSecretFile`). */
  readSecret: () => string | null;
};

const parseUrl = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

/**
 * True for a top-level frame of our own UI: the app's renderer entry (the path
 * only, so a `#/route` hash or query is fine, a sibling HTML file is not) or a
 * configured dev server origin. Anything unparseable is refused.
 */
export const isTrustedOwnerSecretSender = (event: OwnerSecretIpcEvent, policy: OwnerSecretSenderPolicy): boolean => {
  const frame = event.senderFrame;
  if (!frame || frame.parent) return false;
  const url = parseUrl(frame.url);
  if (!url) return false;
  if (url.protocol === "file:") {
    const index = parseUrl(policy.rendererIndexFileUrl);
    return index !== null && index.protocol === "file:" && url.host === index.host && url.pathname === index.pathname;
  }
  return url.origin !== "null" && (policy.allowedOrigins ?? []).some((allowed) => parseUrl(allowed)?.origin === url.origin);
};

export const createOwnerSecretIpcHandler = (options: OwnerSecretIpcOptions) => (event: OwnerSecretIpcEvent): string | null => {
  if (!isTrustedOwnerSecretSender(event, options)) throw new Error("owner_secret_untrusted_sender");
  return options.readSecret();
};

/**
 * Renderer side: a provider for `createRuntimeSession({ ownerSecret })` that
 * asks the main process through the preload bridge on every call.
 */
export const ownerSecretProviderFromBridge =
  (bridge: (() => Promise<string | null | undefined>) | null | undefined): OwnerSecretProvider =>
  async () => (bridge ? bridge() : null);
