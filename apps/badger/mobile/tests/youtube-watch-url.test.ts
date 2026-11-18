import { describe, expect, it } from "vitest";
import { youtubeWatchUrl } from "../src/lib/youtubeWatchUrl";

/** @req META-TRAILER-01 */
describe("youtubeWatchUrl (META-TRAILER-01)", () => {
  it("builds YouTube's public watch page for a trailer key, trimmed and encoded", () => {
    const urls = [youtubeWatchUrl("abcDEF12345"), youtubeWatchUrl("  xyzUVW67890 \n"), youtubeWatchUrl("a&b")];
    console.info("[META-TRAILER-01] watch urls", JSON.stringify(urls));
    expect(urls).toEqual([
      "https://www.youtube.com/watch?v=abcDEF12345",
      "https://www.youtube.com/watch?v=xyzUVW67890",
      "https://www.youtube.com/watch?v=a%26b",
    ]);
  });
});
