import { describe, expect, it } from "vitest";
import { resolveInitialApiBaseUrl } from "../src/renderer/src/lib/apiBaseUrl";

describe("renderer api base url", () => {
  it("uses the local vite proxy in dev mode", () => {
    expect(resolveInitialApiBaseUrl({ DEV: true })).toBe("/api");
  });

  it("prefers explicit vite override", () => {
    expect(
      resolveInitialApiBaseUrl({
        DEV: true,
        VITE_API_BASE_URL: "https://api.override.spacefleet.io",
      })
    ).toBe("https://api.override.spacefleet.io");
  });

  it("uses the production host outside dev mode", () => {
    expect(resolveInitialApiBaseUrl({ DEV: false })).toBe("https://api.spacefleet.io");
  });
});
