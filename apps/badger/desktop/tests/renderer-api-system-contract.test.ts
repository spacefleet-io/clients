import { describe, expect, it } from "vitest";
import * as rendererApi from "../src/renderer/src/api";

describe("renderer api exports", () => {
  it("re-exports system contract helpers for auth bootstrap", () => {
    expect(typeof rendererApi.getSystemContract).toBe("function");
    expect(typeof rendererApi.getSystemContractIssue).toBe("function");
  });
});
