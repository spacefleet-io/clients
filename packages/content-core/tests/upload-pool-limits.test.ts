import { describe, expect, it } from "vitest";
import { uploadPoolLimits } from "../src/storageTransport";

const GiB = 1024 ** 3;

// #928: the ingest upload pool ramps towards 16 objects in flight; a 4 GB host caps lower, 8 GB and up keep 8 -> 16.
describe("uploadPoolLimits", () => {
  it.each([
    [64 * GiB, 8, 16],
    [16 * GiB, 8, 16],
    [7.8 * GiB, 8, 16], // an "8 GB" machine as the OS reports it
    [3.8 * GiB, 8, 8], // the 4 GB Celeron test box
    [3 * GiB, 6, 6],
    [2 * GiB, 4, 4],
    [1 * GiB, 4, 4],
  ])("%d bytes of RAM -> start %i, ramp to %i", (total, initial, max) => {
    expect(uploadPoolLimits(total)).toEqual({ initialConcurrency: initial, maxConcurrency: max });
  });

  it("keeps the full pool when the RAM size is unknown", () => {
    for (const total of [0, Number.NaN, -1]) {
      expect(uploadPoolLimits(total)).toEqual({ initialConcurrency: 8, maxConcurrency: 16 });
    }
  });
});
