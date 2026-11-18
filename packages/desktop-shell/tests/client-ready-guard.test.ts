import { describe, expect, it } from "vitest";
import { resolveClientReadyRedirect } from "../src/guards";

describe("client-ready guard redirect resolver", () => {
  console.info("[client-ready-guard:suite] starting client-ready guard redirect resolver tests");

  it("maps needs_login to login redirect", () => {
    const input = { status: "needs_login" as const, loginRedirectTo: "/login", keyRedirectTo: "/onboarding/key" };
    console.info(`[client-ready-guard:test] input=${JSON.stringify(input)} → expects "/login"`);
    expect(resolveClientReadyRedirect(input)).toBe("/login");
  });

  it("maps needs_key to key redirect", () => {
    const input = { status: "needs_key" as const, loginRedirectTo: "/login", keyRedirectTo: "/onboarding/key" };
    console.info(`[client-ready-guard:test] input=${JSON.stringify(input)} → expects "/onboarding/key"`);
    expect(resolveClientReadyRedirect(input)).toBe("/onboarding/key");
  });

  it("returns null for ready status", () => {
    const input = { status: "ready" as const, loginRedirectTo: "/login", keyRedirectTo: "/onboarding/key" };
    console.info(`[client-ready-guard:test] input=${JSON.stringify(input)} → expects null`);
    expect(resolveClientReadyRedirect(input)).toBeNull();
  });
});
