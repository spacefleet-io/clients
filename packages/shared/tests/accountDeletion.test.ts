import { describe, expect, it } from "vitest";
import { bookedDeletionDate } from "../src/accountDeletion";

/**
 * @req ACCT-DEL-03
 * @level unit
 * @why The delete screens' intro said "permanently deletes … cannot be undone" even while the user was booking the
 *   end-of-year deletion, which "Keep my account" undoes; the intro must name the booked date whenever the deletion
 *   is (or is about to be) booked, and stay permanent only for an immediate deletion. Phone, web and desktop share it.
 */
describe("bookedDeletionDate (ACCT-DEL-03)", () => {
  it("names the booked date only when the deletion is or will be booked", () => {
    const end = "2027-03-01T00:00:00.000Z";
    const booked = "2027-02-01T00:00:00.000Z";
    const cases = [
      { scheduled: null, periodEnd: end, mode: "end_of_period" as const, want: end },
      { scheduled: null, periodEnd: end, mode: "now" as const, want: null },
      { scheduled: null, periodEnd: null, mode: "end_of_period" as const, want: null },
      { scheduled: booked, periodEnd: null, mode: "end_of_period" as const, want: booked },
    ];
    for (const c of cases) {
      const got = bookedDeletionDate(c.scheduled, c.periodEnd, c.mode);
      console.info(`[account-deletion:intro] scheduled=${c.scheduled} periodEnd=${c.periodEnd} mode=${c.mode} -> ${got}`);
      expect(got).toBe(c.want);
    }
  });
});
