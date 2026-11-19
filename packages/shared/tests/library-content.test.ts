import { describe, expect, it } from "vitest";
import { libraryContent } from "../src/libraryContent";

const T = "[library-content]";

// @req UX-WAIT-04
describe("library content: loading, ready or empty", () => {
  it("is loading, never empty, while nothing is listed and the load has not finished", () => {
    const state = libraryContent({ itemCount: 0, settled: false });
    console.info(T, "unsettled, 0 items ->", state);
    expect(state).toBe("loading");
  });

  it("is empty only once the finished load lists nothing", () => {
    const state = libraryContent({ itemCount: 0, settled: true });
    console.info(T, "settled, 0 items ->", state);
    expect(state).toBe("empty");
  });

  it("shows a saved library at once, before the refresh behind it ends", () => {
    for (const settled of [false, true]) {
      const state = libraryContent({ itemCount: 3, settled });
      console.info(T, `settled=${settled}, 3 items ->`, state);
      expect(state).toBe("ready");
    }
  });
});
