// @req STOR-USE-02
import { describe, expect, it } from "vitest";
import {
  apportionDeclaredBytes,
  countedObjectBytes,
  isStorageObjectRole,
  SOURCE_STORED_FLOOR_RATIO,
} from "../src/storageCounting";

const log = (id: string, phase: string, state?: unknown) =>
  console.log(`[${id}] ${phase}${state === undefined ? "" : ` ${JSON.stringify(state)}`}`);

describe("storage counting (STOR-USE-02)", () => {
  it("STOR-USE-02 a source piece counts its declared share, never below 90% of its stored bytes", () => {
    const id = "STOR-USE-02-source";
    log(id, "phase:start", { floor: SOURCE_STORED_FLOOR_RATIO });
    const declaredAbove = countedObjectBytes({ role: "source", storedBytes: 1_000_054, declaredBytes: 1_000_000 });
    const declaredBelow = countedObjectBytes({ role: "source", storedBytes: 1_000_054, declaredBytes: 10 });
    const noDeclared = countedObjectBytes({ role: "source", storedBytes: 1_000_054 });
    log(id, "phase:state", { declaredAbove, declaredBelow, noDeclared });
    expect(declaredAbove).toBe(1_000_000);
    expect(declaredBelow).toBe(Math.ceil(1_000_054 * 0.9));
    expect(noDeclared).toBe(1_000_054);
  });

  it("STOR-USE-02 every derived role counts its stored bytes and ignores a declared size", () => {
    const id = "STOR-USE-02-derived";
    const counted = (["quality_copy", "subtitle", "preview", "artwork", "other"] as const).map((role) => ({
      role,
      bytes: countedObjectBytes({ role, storedBytes: 4321, declaredBytes: 1 }),
    }));
    log(id, "phase:state", counted);
    for (const entry of counted) expect(entry.bytes).toBe(4321);
    expect(isStorageObjectRole("artwork")).toBe(true);
    expect(isStorageObjectRole("library_backup")).toBe(false);
  });

  it("STOR-USE-02 the shares of an original add up exactly to its size, even above 2^53 / 2^40", () => {
    const id = "STOR-USE-02-apportion";
    const cases: Array<[number, number[]]> = [
      [1_234_567_891, [800_000_054, 300_000_054, 54, 99_999_999]],
      [7, [3, 3, 3]],
      [2 ** 45 + 3, [2 ** 44, 2 ** 44 + 17, 5]],
      [10, [0, 0]],
    ];
    for (const [total, pieces] of cases) {
      const shares = apportionDeclaredBytes(total, pieces);
      const sum = shares.reduce((a, b) => a + b, 0);
      log(id, "phase:state", { total, pieces, shares, sum });
      if (pieces.every((p) => p === 0)) expect(sum).toBe(0);
      else expect(sum).toBe(total);
      for (const share of shares) expect(Number.isInteger(share) && share >= 0).toBe(true);
      expect(apportionDeclaredBytes(total, pieces)).toEqual(shares);
    }
  });
});
