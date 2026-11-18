/**
 * Chapter-list parsing + matching helpers.
 *
 * sf.lua at packages/mpv/resources/osc/sf.lua:438-463 has a
 * `chapter_list_matches()` function that compares the desktop-side chapter
 * list against mpv's current `chapter-list` property by checking first/last
 * `time` within a 0.001s tolerance. Mirroring that logic here lets the
 * renderer make the same matching decision in JS without sending the same
 * chapter-list across the wire twice (one to apply, one to verify).
 *
 * The Zod parser is permissive — mpv's actual `chapter-list` shape is
 * `[{ time, title?, ... }]`, and we accept extra fields. The schema rejects
 * obviously-bad payloads (non-array, missing `time`) but doesn't enforce a
 * tight closed shape since mpv may add fields in future versions.
 */

import { z } from "zod";

export const chapterSchema = z
  .object({
    time: z.number(),
    title: z.string().optional(),
  })
  .passthrough();

export const chapterListSchema = z.array(chapterSchema);

/** A chapter as parsed off the wire from mpv. `title` is optional. */
export type ParsedChapter = z.infer<typeof chapterSchema>;
export type ParsedChapterList = z.infer<typeof chapterListSchema>;

/**
 * Defensive parser for an mpv `chapter-list` property value. Returns an
 * empty array on any invalid shape (rather than throwing) — callers
 * already handle "no chapters" the same way as "chapter list not yet
 * available", so distinguishing the two has no downstream value.
 */
export const parseChapterList = (raw: unknown): ParsedChapterList => {
  const result = chapterListSchema.safeParse(raw);
  if (!result.success) return [];
  return result.data;
};

/**
 * Mirrors `sf.lua` `chapter_list_matches` (line 438+): two chapter lists
 * are equivalent iff they have the same length AND the first and last
 * `time` values match within `toleranceSeconds`.
 *
 * The Lua side compares first/last only because mpv re-sorts/re-indexes
 * the array internally on `set_property_native`, and the boundary times
 * are the stable signal. We use the same shortcut to avoid spurious
 * "list changed" decisions when only ordering shifted.
 */
export const chapterListEquals = (
  a: ReadonlyArray<{ time?: number }>,
  b: ReadonlyArray<{ time?: number }>,
  toleranceSeconds = 0.001,
): boolean => {
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  const firstA = a[0]?.time;
  const firstB = b[0]?.time;
  const lastA = a[a.length - 1]?.time;
  const lastB = b[b.length - 1]?.time;
  if (
    typeof firstA !== "number" ||
    typeof firstB !== "number" ||
    typeof lastA !== "number" ||
    typeof lastB !== "number"
  ) {
    return false;
  }
  return (
    Math.abs(firstA - firstB) <= toleranceSeconds &&
    Math.abs(lastA - lastB) <= toleranceSeconds
  );
};
