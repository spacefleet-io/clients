import { describe, expect, it } from "vitest";
import { resolveRequireSessionRedirect } from "../src/guards";

describe("require-session guard helper", () => {
  console.info("[require-session-guard:suite] starting require-session redirect resolver tests");

  it("redirects when session is absent", () => {
    console.info("[require-session-guard:test] session=null fallback=/login → expects redirect");
    expect(resolveRequireSessionRedirect(null, "/login")).toBe("/login");
  });

  it("allows route when session exists", () => {
    console.info("[require-session-guard:test] session={id:s1} fallback=/login → expects null");
    expect(resolveRequireSessionRedirect({ id: "s1" }, "/login")).toBeNull();
  });
});
