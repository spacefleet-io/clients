import { describe, expect, it } from "vitest";
import type { AccountAccess } from "../src/accountAccess";
import { formatAccessDate, isAccessUnpaid, resolveEffectiveAccess } from "../src/effectiveAccess";

const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const day = 24 * 60 * 60 * 1000;

const paid = (paidUntilMs: number): AccountAccess => ({
  state: "paid",
  paidUntil: new Date(paidUntilMs).toISOString(),
  billingPeriod: "monthly",
  wipeAt: null,
  qosTier: "paid",
});

describe("resolveEffectiveAccess", () => {
  it("returns null when the API did not send access (pre-#145 build)", () => {
    expect(resolveEffectiveAccess(undefined, NOW)).toBeNull();
    expect(resolveEffectiveAccess(null, NOW)).toBeNull();
  });

  it("passes free and still-paid access through unchanged", () => {
    const free: AccountAccess = { state: "free", paidUntil: null, billingPeriod: null, wipeAt: null, qosTier: "free" };
    expect(resolveEffectiveAccess(free, NOW)).toBe(free);
    const stillPaid = paid(NOW + day);
    expect(resolveEffectiveAccess(stillPaid, NOW)).toBe(stillPaid);
  });

  it("flips a stored paid access to unpaid once paidUntil passed, with a wipe date 60 days later", () => {
    const paidUntil = NOW - day;
    const effective = resolveEffectiveAccess(paid(paidUntil), NOW);
    console.info(`[effective-access] expired paid access → ${JSON.stringify(effective)}`);
    expect(effective?.state).toBe("unpaid");
    expect(effective?.qosTier).toBe("free");
    expect(effective?.wipeAt).toBe(new Date(paidUntil + 60 * day).toISOString());
  });

  it("keeps a paid access past paidUntil while a refused renewal is retried, and flips it when the grace ends (ACCT-PAY-03)", () => {
    const inGrace: AccountAccess = { ...paid(NOW - day), renewalGraceUntil: new Date(NOW + 6 * day).toISOString() };
    expect(resolveEffectiveAccess(inGrace, NOW)).toBe(inGrace);
    expect(isAccessUnpaid(inGrace, NOW)).toBe(false);
    const graceOver = resolveEffectiveAccess(inGrace, NOW + 6 * day);
    console.info(`[effective-access] grace over → ${JSON.stringify(graceOver)}`);
    expect(graceOver?.state).toBe("unpaid");
    expect(graceOver?.wipeAt).toBe(new Date(NOW - day + 60 * day).toISOString());
  });

  it("keeps the API's wipeAt when it already says unpaid", () => {
    const access: AccountAccess = {
      state: "unpaid",
      paidUntil: new Date(NOW - 5 * day).toISOString(),
      billingPeriod: "annual",
      wipeAt: "2026-12-01T00:00:00.000Z",
      qosTier: "free",
    };
    expect(resolveEffectiveAccess(access, NOW)).toBe(access);
    expect(isAccessUnpaid(access, NOW)).toBe(true);
  });

  it("isAccessUnpaid is false for free, paid and missing access", () => {
    expect(isAccessUnpaid(undefined, NOW)).toBe(false);
    expect(isAccessUnpaid(paid(NOW + day), NOW)).toBe(false);
  });
});

describe("formatAccessDate", () => {
  it("formats in the requested locale and tolerates bad input", () => {
    expect(formatAccessDate("2026-12-12T12:00:00.000Z", "en")).toContain("2026");
    expect(formatAccessDate("2026-12-12T12:00:00.000Z", "fr")).toMatch(/décembre/);
    expect(formatAccessDate(null, "en")).toBe("");
    expect(formatAccessDate("garbage", "en")).toBe("");
  });
});
