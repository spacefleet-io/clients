import { describe, expect, it } from "vitest";
import { resolveAssetObjectKeyCandidates } from "../src/renderer/src/lib/assets";

describe("asset legacy key compatibility", () => {
  it("[@bugfix][@regression-proof] expands legacy uuid keys to modern asset object key candidates", () => {
    const uuid = "06639ed5-cfa6-4407-b2f6-8e861f960cdf";
    expect(resolveAssetObjectKeyCandidates(uuid)).toEqual([
      uuid,
      `assets/${uuid}.txt`,
      `assets/${uuid}`,
    ]);
  });

  it("keeps modern asset keys unchanged", () => {
    expect(resolveAssetObjectKeyCandidates("assets/abc-123.txt")).toEqual(["assets/abc-123.txt"]);
  });
});
