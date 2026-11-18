import { describe, expect, it } from "vitest";
import { noticeSurfaceToneClass } from "../src/components";

describe("notice surface tone mapping", () => {
  console.info("[notice-surface:suite] starting notice surface tone class mapping tests");

  it("maps tones to deterministic class fragments", () => {
    console.info("[notice-surface:test] checking tone-class fragments for neutral/info/error");
    const neutral = noticeSurfaceToneClass("neutral");
    const info = noticeSurfaceToneClass("info");
    const error = noticeSurfaceToneClass("error");
    console.info(`[notice-surface:test] resolved fragments neutral=${neutral} info=${info} error=${error}`);
    expect(neutral).toContain("border-border");
    expect(info).toContain("border-primary/30");
    expect(error).toContain("border-destructive/40");
  });
});
