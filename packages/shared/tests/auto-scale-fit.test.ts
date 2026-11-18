import { describe, expect, it } from "vitest";
import { cheapestFittingPlan, planMonthlyPrice, planStorageGb, type PlanChoice } from "../src/storagePlans";

const GIB = 1024 ** 3;
const LOG = "[ACCT-SCALE-01:fit]";

describe(`${LOG} auto-scale picks the cheapest plan-and-blocks mix that holds the usage`, () => {
  // @req ACCT-SCALE-01
  it("picks the smallest whole plan while usage fits one, free included", () => {
    const cases: [number, PlanChoice][] = [
      [0, { plan: "free", addonCount: 0 }],
      [20, { plan: "free", addonCount: 0 }],
      [20.5, { plan: "tier1", addonCount: 0 }],
      [100, { plan: "tier1", addonCount: 0 }],
      [101, { plan: "tier2", addonCount: 0 }],
      [400, { plan: "tier2", addonCount: 0 }],
      [401, { plan: "tier3", addonCount: 0 }],
      [1000, { plan: "tier3", addonCount: 0 }],
    ];
    for (const [gb, expected] of cases) {
      for (const period of ["monthly", "annual"] as const) {
        const picked = cheapestFittingPlan(gb * GIB, period);
        console.info(`${LOG} usage=${gb}GB period=${period} picked=${JSON.stringify(picked)}`);
        expect(picked).toEqual(expected);
      }
    }
  });

  // @req ACCT-SCALE-01
  it("above Scale's 1000 GB keeps Scale and adds the fewest 500 GB blocks that fit, and drops them as usage falls", () => {
    const cases: [number, number][] = [
      [1000.01, 1],
      [1500, 1],
      [1501, 2],
      [3200, 5],
      [2400, 3],
      [1200, 1],
    ];
    for (const [gb, blocks] of cases) {
      const picked = cheapestFittingPlan(gb * GIB, "monthly");
      console.info(`${LOG} usage=${gb}GB picked=${JSON.stringify(picked)} size=${planStorageGb(picked)}GB price=${planMonthlyPrice(picked, "monthly")}`);
      expect(picked).toEqual({ plan: "tier3", addonCount: blocks });
      expect(planStorageGb(picked)).toBeGreaterThanOrEqual(gb);
      // one block fewer would not hold it
      expect(planStorageGb({ plan: "tier3", addonCount: blocks - 1 })).toBeLessThan(gb);
    }
  });

  // @req ACCT-SCALE-01
  it("has no block cap: very large usage is Scale with as many blocks as it needs", () => {
    const picked = cheapestFittingPlan(50_000 * GIB, "annual");
    console.info(`${LOG} usage=50000GB picked=${JSON.stringify(picked)} size=${planStorageGb(picked)}GB`);
    expect(picked.plan).toBe("tier3");
    expect(planStorageGb(picked)).toBeGreaterThanOrEqual(50_000);
    expect(planStorageGb({ plan: "tier3", addonCount: picked.addonCount - 1 })).toBeLessThan(50_000);
  });
});
