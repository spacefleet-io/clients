/**
 * @test-id PARROT-CORE-TITLENUMBER-001
 * @level unit
 * @why PAR-META-21: a title tag that starts with a track number ("02. Wildfire") is imported as "Wildfire" with that
 *      track number when the track-number tag is missing; a tag that disagrees keeps its number; a number that is the
 *      title or part of it ("1999", "99 Luftballons") stays.
 * @covers packages/parrot-core/src/titleNumber.ts
 */
import { describe, expect, it } from "bun:test";
import { splitTitleTrackNumber } from "../src/titleNumber";

describe("splitTitleTrackNumber", () => {
  it.each([
    // [title tag, track-number tag, title, number]
    ["02. Wildfire", null, "Wildfire", 2],
    ["02 - Wildfire", 0, "Wildfire", 2],
    ["02 \u2013 Wildfire", undefined, "Wildfire", 2],
    ["002 Wildfire", null, "Wildfire", 2],
    ["002 - Chrome Horizon", null, "Chrome Horizon", 2],
    ["02-Wildfire", null, "Wildfire", 2],
    ["2) Wildfire", null, "Wildfire", 2],
    ["2. Wildfire", null, "Wildfire", 2],
    ["12.Wildfire", null, "Wildfire", 12],
    ["  07.   Wildfire  ", null, "Wildfire", 7],
    // The tag agrees, or disagrees: the tag's number stays, the prefix still goes.
    ["02. Wildfire", 2, "Wildfire", 2],
    ["02. Wildfire", 5, "Wildfire", 5],
    // 00 is no track number: the prefix goes, the number stays unknown.
    ["00. Hidden Track", null, "Hidden Track", null],
  ])("%p (tag %p) → %p, %p", (title, tag, expectedTitle, expectedNumber) => {
    const split = splitTitleTrackNumber(title, tag);
    expect(split).toEqual({ title: expectedTitle, number: expectedNumber });
  });

  it.each([
    ["1999", null],
    ["1999", 4],
    ["99 Luftballons", null],
    ["99 Luftballons", 1],
    ["7 Seconds", 7],
    ["2.0", null],
    ["3.14 Pi", null],
    ["3 - 2 - 1", null],
    ["2:00 AM", null],
    ["2-4-6-8 Motorway", null],
    ["1979", 1],
    ["Wildfire", null],
    ["Wildfire", 3],
  ])("keeps %p as it is (tag %p)", (title, tag) => {
    const split = splitTitleTrackNumber(title, tag);
    expect(split).toEqual({ title, number: tag && tag > 0 ? tag : null });
  });
});
