import { describe, expect, it } from "vitest";
import { resolveClientReadyStatus } from "../src/guards";

describe("client-ready status resolver", () => {
  console.info("[client-ready-status:suite] starting client-ready status resolver tests");

  it("requires login when session is absent", () => {
    const input = {
      hasUser: false,
      keyAcknowledged: false,
      libraryLoading: false,
      libraryError: null,
      isKeyError: false,
    };
    console.info(`[client-ready-status:test] input=${JSON.stringify(input)} → expects "needs_login"`);
    expect(resolveClientReadyStatus(input)).toBe("needs_login");
  });

  it("requires key when user exists but key is missing", () => {
    const input = {
      hasUser: true,
      keyAcknowledged: false,
      libraryLoading: false,
      libraryError: null,
      isKeyError: false,
    };
    console.info(`[client-ready-status:test] input=${JSON.stringify(input)} → expects "needs_key"`);
    expect(resolveClientReadyStatus(input)).toBe("needs_key");
  });

  it("stays checking while library loads without error", () => {
    const input = {
      hasUser: true,
      keyAcknowledged: true,
      libraryLoading: true,
      libraryError: null,
      isKeyError: false,
    };
    console.info(`[client-ready-status:test] input=${JSON.stringify(input)} → expects "checking"`);
    expect(resolveClientReadyStatus(input)).toBe("checking");
  });

  it("becomes ready when user/key are valid and loading settled", () => {
    const input = {
      hasUser: true,
      keyAcknowledged: true,
      libraryLoading: false,
      libraryError: null,
      isKeyError: false,
    };
    console.info(`[client-ready-status:test] input=${JSON.stringify(input)} → expects "ready"`);
    expect(resolveClientReadyStatus(input)).toBe("ready");
  });
});
