import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string) =>
  readFileSync(resolve(process.cwd(), relativePath), "utf8");

describe("@bugfix @regression-proof MediaDetailsDialog jobs tab stays open when queue is empty", () => {
  it("does not redirect detailTab='processing' to 'details' when jobsForMedia is empty", () => {
    const source = readSource("src/renderer/src/components/MediaDetailsDialog.tsx");
    expect(source).not.toMatch(/detailTab\s*===\s*"processing"\s*\)\s*\{\s*setDetailTab\(\s*"details"\s*\)/);
  });

  it("does not redirect movieTab='processing' to 'details' when jobsForMedia is empty", () => {
    const source = readSource("src/renderer/src/components/MediaDetailsDialog.tsx");
    expect(source).not.toMatch(/movieTab\s*===\s*"processing"\s*\)\s*\{\s*setMovieTab\(\s*"details"\s*\)/);
  });

  it("does not contain an effect that triggers on jobsForMedia.length === 0 and calls setDetailTab/setMovieTab", () => {
    const source = readSource("src/renderer/src/components/MediaDetailsDialog.tsx");
    const redirectEffectPattern = /jobsForMedia\.length\s*>\s*0\s*\|\|\s*sharedIngestJobsForMedia\.length\s*>\s*0/;
    expect(source).not.toMatch(redirectEffectPattern);
  });
});
