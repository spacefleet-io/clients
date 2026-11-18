/** How the user picked to delete a paid yearly account past its guarantee (ACCT-DEL-03). */
export type AccountDeletionMode = "end_of_period" | "now";

/**
 * ACCT-DEL-03: the date the delete screen's intro names because the deletion is booked and "Keep my account" still
 * undoes it — the deletion already booked (`scheduledFor`), else the end of the paid year while that option is picked.
 * Null: the deletion is immediate and permanent, so the intro keeps its "cannot be undone" wording.
 */
export const bookedDeletionDate = (
  scheduledFor: string | null,
  periodEndDeleteAt: string | null,
  mode: AccountDeletionMode
): string | null => scheduledFor ?? (periodEndDeleteAt && mode === "end_of_period" ? periodEndDeleteAt : null);
