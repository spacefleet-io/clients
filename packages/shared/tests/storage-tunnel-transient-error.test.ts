import { describe, expect, it } from "vitest";
import { isTransientStorageTransportError, StorageTunnelError } from "../src/storageTunnel";

const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });

describe("isTransientStorageTransportError", () => {
  it.each([
    ["Bun connection refused", withCode("Unable to connect. Is the computer able to access the url?", "ConnectionRefused")],
    ["Bun socket closed", withCode("The socket connection was closed unexpectedly.", "ConnectionClosed")],
    ["Node ECONNRESET", withCode("read ECONNRESET", "ECONNRESET")],
    ["undici fetch failed (code on cause)", new Error("fetch failed", { cause: withCode("connect", "ECONNREFUSED") })],
    ["gateway 502", new StorageTunnelError(502, { error: "bad_gateway" })],
    ["gateway 503 while booting", new StorageTunnelError(503, { error: "no_storage_gateways_available" })],
    ["restarted gateway forgot the session", new StorageTunnelError(404, { error: "invalid_session" })],
  ])("@bugfix @regression-proof treats %s as transient", (_label, err) => {
    expect(isTransientStorageTransportError(err)).toBe(true);
  });

  it.each([
    ["GCM auth failure", new Error("Unsupported state or unable to authenticate data")],
    ["magic mismatch", new Error("MEDIA_OBJECT_MAGIC_MISMATCH")],
    ["403", new StorageTunnelError(403, { error: "forbidden" })],
    ["404 object missing", new StorageTunnelError(404, { error: "not_found" })],
    ["400 invalid_session", new StorageTunnelError(400, { error: "invalid_session" })],
    ["quota", new StorageTunnelError(413, { error: "upload_quota_exceeded" })],
    ["cancelled", new Error("CANCELLED")],
    ["non-error", "boom"],
  ])("@bugfix @regression-proof treats %s as permanent", (_label, err) => {
    expect(isTransientStorageTransportError(err)).toBe(false);
  });
});
