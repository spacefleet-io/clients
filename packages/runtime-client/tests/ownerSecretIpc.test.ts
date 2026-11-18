import { describe, expect, it, vi } from "vitest";
import {
  RUNTIME_OWNER_SECRET_IPC_CHANNEL,
  createOwnerSecretIpcHandler,
  isTrustedOwnerSecretSender,
  ownerSecretProviderFromBridge,
} from "../src/ownerSecretIpc";

const SUITE = "runtime-client-owner-secret-ipc";
const top = (url: string) => ({ senderFrame: { url, parent: null } });
const RENDERER = "file:///opt/app/resources/app.asar/out/renderer/index.html";

describe("owner secret IPC (RT-SEC-05)", () => {
  it("hands the secret to the app's own renderer entry, with a hash route or query @req RT-SEC-05[badger-desktop]", () => {
    const readSecret = vi.fn(() => "s".repeat(64));
    const handler = createOwnerSecretIpcHandler({ readSecret, rendererIndexFileUrl: RENDERER });
    expect(handler(top(RENDERER))).toBe("s".repeat(64));
    expect(handler(top(`${RENDERER}#/library`))).toBe("s".repeat(64));
    expect(handler(top(`${RENDERER}?x=1`))).toBe("s".repeat(64));
    console.info(`[${SUITE}:file-page] channel=${RUNTIME_OWNER_SECRET_IPC_CHANNEL}`);
  });

  it("reads the secret fresh on every call, so a restarted runtime is picked up @req RT-SEC-05[badger-desktop]", () => {
    let secret: string | null = "a".repeat(64);
    const handler = createOwnerSecretIpcHandler({ readSecret: () => secret, rendererIndexFileUrl: RENDERER });
    expect(handler(top(RENDERER))).toBe("a".repeat(64));
    secret = "b".repeat(64);
    expect(handler(top(RENDERER))).toBe("b".repeat(64));
    secret = null; // runtime not running: nothing to hand out
    expect(handler(top(RENDERER))).toBeNull();
  });

  it("allows the dev server origin only when the app configured it @req RT-SEC-05[badger-desktop]", () => {
    const dev = "http://localhost:5173";
    const policy = (allowedOrigins: string[]) => ({ rendererIndexFileUrl: RENDERER, allowedOrigins });
    expect(isTrustedOwnerSecretSender(top("http://localhost:5173/#/library"), policy([dev]))).toBe(true);
    expect(isTrustedOwnerSecretSender(top("http://localhost:5173/"), policy([]))).toBe(false);
    expect(isTrustedOwnerSecretSender(top("http://localhost:5174/"), policy([dev]))).toBe(false);
    expect(isTrustedOwnerSecretSender(top("http://localhost.evil.example/"), policy([dev]))).toBe(false);
  });

  it("refuses any other file: page, even next to the renderer entry or on another host @req RT-SEC-05[badger-desktop]", () => {
    const readSecret = vi.fn(() => "s".repeat(64));
    const handler = createOwnerSecretIpcHandler({ readSecret, rendererIndexFileUrl: RENDERER });
    for (const url of [
      "file:///opt/app/resources/app.asar/out/renderer/other.html",
      "file:///opt/app/resources/app.asar/out/renderer/index.html.evil/x",
      "file:///opt/app/resources/app.asar/out/renderer/../../../../../tmp/evil.html",
      "file:///home/user/Downloads/malicious.html",
      "file:///index.html",
      "file://attacker-host/opt/app/resources/app.asar/out/renderer/index.html",
    ]) {
      expect(() => handler(top(url))).toThrow("owner_secret_untrusted_sender");
    }
    expect(readSecret).not.toHaveBeenCalled();
  });

  it("refuses a foreign page, an embedded frame and a missing sender frame @req RT-SEC-05[badger-desktop]", () => {
    const readSecret = vi.fn(() => "s".repeat(64));
    const handler = createOwnerSecretIpcHandler({ readSecret, rendererIndexFileUrl: RENDERER, allowedOrigins: ["http://localhost:5173"] });
    expect(() => handler(top("https://evil.example/"))).toThrow("owner_secret_untrusted_sender");
    expect(() => handler({ senderFrame: { url: RENDERER, parent: {} } })).toThrow("owner_secret_untrusted_sender");
    expect(() => handler({ senderFrame: null })).toThrow("owner_secret_untrusted_sender");
    expect(() => handler({})).toThrow("owner_secret_untrusted_sender");
    expect(() => handler(top("not a url"))).toThrow("owner_secret_untrusted_sender");
    expect(readSecret).not.toHaveBeenCalled();
  });

  it("adapts the preload bridge into a session provider, and none into no secret @req RT-SEC-05[badger-desktop]", async () => {
    const bridge = vi.fn(async () => "x".repeat(64));
    expect(await ownerSecretProviderFromBridge(bridge)()).toBe("x".repeat(64));
    expect(await ownerSecretProviderFromBridge(undefined)()).toBeNull();
  });
});
