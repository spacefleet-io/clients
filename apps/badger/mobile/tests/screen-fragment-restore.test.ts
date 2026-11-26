/**
 * Field bug this guards (OnePlus 9, Badger and Parrot): when Android recreated the app's activity (font size or language
 * changed in Settings, or "Don't keep activities" / the system reclaiming the app in the background), the app crashed
 * with react-native-screens' "Screen fragments should never be restored". The fragment manager restores the screen
 * fragments it saved, and those refuse to be built without a screen. react-native-screens' fix is its fragment factory,
 * set in MainActivity before `super.onCreate` (where the restore happens). Both apps pin it here; the native side is not
 * unit-runnable from a JS test (same approach as player-orientation-restore.test.ts), and the on-device proof is in the PR.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ACTIVITIES = {
  badger: resolve(__dirname, "../android/app/src/main/java/com/spacebadger/mobile/MainActivity.kt"),
  parrot: resolve(__dirname, "../../../parrot/mobile/android/app/src/main/java/io/spacefleet/parrot/MainActivity.kt"),
};

describe("activity recreation keeps react-native-screens from crashing (Android)", () => {
  it.each(Object.entries(ACTIVITIES))(
    "@bugfix @regression-proof %s MainActivity sets RNScreensFragmentFactory before super.onCreate",
    (app, file) => {
      const source = readFileSync(file, "utf8");
      // Up to the call itself: the comment above it also names super.onCreate.
      const start = source.indexOf("override fun onCreate");
      const onCreate = source.slice(start, source.indexOf("super.onCreate(savedInstanceState)", start));
      console.info(`[screen-fragment-restore] ${app} MainActivity.onCreate before super:\n${onCreate}`);
      expect(source).toContain("import com.swmansion.rnscreens.fragment.restoration.RNScreensFragmentFactory");
      expect(onCreate).toContain("supportFragmentManager.fragmentFactory = RNScreensFragmentFactory()");
      // The other documented fix, dropping all saved state with super.onCreate(null), would also drop the state other
      // libraries keep; the factory only replaces the screen fragments.
      expect(source).not.toContain("super.onCreate(null)");
    },
  );
});
