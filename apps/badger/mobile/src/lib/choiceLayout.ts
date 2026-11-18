/**
 * UX-LIST-01: a choice shows inline only while it is a handful of fixed options; a longer one (a language picker) is one
 * row that opens its own scrolling window. Used by the phone's `ChoiceRow` (sheet); TV Settings follows the same rule with its own rows and `TvListDialog`.
 */

/** Most options a choice may show inline as chips ("a handful" read as at most 6, 2026-10-20). */
export const INLINE_CHOICE_LIMIT = 6;

/** True when a choice with this many options must open in its own window instead of showing inline. */
export const choiceOpensWindow = (optionCount: number): boolean => optionCount > INLINE_CHOICE_LIMIT;
