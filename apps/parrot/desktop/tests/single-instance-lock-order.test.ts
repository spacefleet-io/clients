/**
 * Electron keys `requestSingleInstanceLock()` on the userData dir in effect at the call. Parrot must
 * set userData (SF_USER_DATA_PATH for lanes and e2e, else the per-OS default) before it takes the
 * lock, so a lane Parrot with its own data dir never hands over to the user's running Parrot.
 * Checked on the source order of src/main/index.ts (the module runs Electron at import).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const mains = { parrot: resolve(import.meta.dirname, "../src/main/index.ts") };

// @req PLAT-DESK-12 each userData dir has its own single-instance lock
describe("single-instance lock follows userData", () => {
  for (const [name, path] of Object.entries(mains)) {
    it(`${name} sets userData before requestSingleInstanceLock`, () => {
      const source = readFileSync(path, "utf8");
      const setUserData = source.indexOf('app.setPath("userData"');
      const lock = source.indexOf("app.requestSingleInstanceLock()");
      console.info(`[single-instance:${name}] setPath("userData") at ${setUserData}, requestSingleInstanceLock() at ${lock}`);
      expect(setUserData).toBeGreaterThan(-1);
      expect(lock).toBeGreaterThan(-1);
      expect(source.indexOf('app.setPath("userData"', setUserData + 1)).toBe(-1);
      expect(setUserData).toBeLessThan(lock);
    });
  }
});
