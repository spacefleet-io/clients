/**
 * @test-id MOBILE-SELF-UPDATE-SOURCE-001
 * @level unit
 * @req REL-UPD-06
 * @why Chris 2026-11-18: a Badger or Parrot APK installed by hand offers its own updates, but only when no store or
 *   updater app manages the install. Who installed it decides: a store never competes, a hand install is offered, and an
 *   installer we don't know gets no prompt.
 */
import { describe, expect, it } from "vitest";
import { ADB_INSTALLERS, classifyInstallSource, HAND_INSTALL_INITIATORS, MANAGING_INSTALLERS, SYSTEM_INSTALLERS } from "../src/installSource";

const self = "com.spacebadger.mobile";
const classify = (installing: string | null, initiating: string | null) => classifyInstallSource({ installing, initiating }, self);

describe("who manages the install (REL-UPD-06)", () => {
  // @req REL-UPD-06
  describe("a store or updater app manages it: never a step", () => {
    const stores = [
      "com.android.vending",
      "org.fdroid.fdroid",
      "org.fdroid.fdroid.privileged",
      "org.fdroid.basic",
      "com.aurora.store",
      "com.looker.droidify",
      "com.machiav3lli.fdroid",
      "dev.imranr.obtainium",
      "dev.imranr.obtainium.fdroid",
      "com.amazon.venezia",
      "com.sec.android.app.samsungapps",
      "com.huawei.appmarket",
      "app.accrescent.client",
    ];
    it.each(stores)("%s", (store) => {
      expect(MANAGING_INSTALLERS[store]).toBe(true);
      expect(classify(store, store)).toBe("managed");
      expect(classify(store, null)).toBe("managed");
      // adb started it, the store committed it: still the store's.
      expect(classify(store, "com.android.shell")).toBe("managed");
      // Droid-ify's and F-Droid's legacy installers hand the APK to the system installer and only start the install.
      expect(classify("com.google.android.packageinstaller", store)).toBe("managed");
    });
  });

  // @req REL-UPD-06
  describe("installed by hand: the step is offered", () => {
    it("no installer recorded (null or empty): adb on most phones", () => {
      expect(classify(null, null)).toBe("unmanaged");
      expect(classify("", "")).toBe("unmanaged");
      expect(classify(null, "com.android.shell")).toBe("unmanaged");
    });

    it.each(["pc", "adb"])("adb recorded as %s (OnePlus writes pc)", (name) => {
      expect(ADB_INSTALLERS[name]).toBe(true);
      expect(classify(name, "com.android.shell")).toBe("unmanaged");
      expect(classify(name, null)).toBe("unmanaged");
    });

    it("adb recorded as the shell", () => {
      expect(SYSTEM_INSTALLERS["com.android.shell"]).toBe(true);
      expect(classify("com.android.shell", null)).toBe("unmanaged");
      expect(classify("com.android.shell", "com.android.shell")).toBe("unmanaged");
    });

    const systemInstallers = [
      "com.android.packageinstaller",
      "com.google.android.packageinstaller",
      "com.miui.packageinstaller",
      "com.oplus.packageinstaller",
      "com.coloros.packageinstaller",
      "com.samsung.android.packageinstaller",
      "com.huawei.packageinstaller",
      "com.amazon.tv.packageinstaller",
    ];
    it.each(systemInstallers)("system package installer %s", (installer) => {
      expect(SYSTEM_INSTALLERS[installer]).toBe(true);
      expect(classify(installer, null)).toBe("unmanaged");
      expect(classify(installer, installer)).toBe("unmanaged");
    });

    it("an OEM package installer missing from the list still counts by its name", () => {
      expect(classify("com.vendor.packageinstaller", null)).toBe("unmanaged");
    });

    const browsersAndFiles = [
      "com.android.chrome",
      "org.mozilla.firefox",
      "com.brave.browser",
      "com.sec.android.app.sbrowser",
      "com.android.providers.downloads",
      "com.google.android.documentsui",
      "com.google.android.apps.nbu.files",
      "com.oneplus.filemanager",
      "com.esaba.downloader",
    ];
    it.each(browsersAndFiles)("APK opened from %s through the system installer", (initiator) => {
      expect(HAND_INSTALL_INITIATORS[initiator]).toBe(true);
      expect(classify("com.google.android.packageinstaller", initiator)).toBe("unmanaged");
    });

    it("after its own self-update the app is still the one that updates it", () => {
      expect(classify(self, self)).toBe("unmanaged");
      expect(classify(self, null)).toBe("unmanaged");
      expect(classify("com.google.android.packageinstaller", self)).toBe("unmanaged");
    });
  });

  // @req REL-UPD-06
  it("any other installer or initiator is unknown: no step, even when adb started it", () => {
    expect(classify("com.example.someupdater", null)).toBe("unknown");
    expect(classify("com.example.someupdater", "com.example.someupdater")).toBe("unknown");
    expect(classify("com.example.someupdater", "com.android.shell")).toBe("unknown");
    expect(classify("com.google.android.packageinstaller", "com.example.someupdater")).toBe("unknown");
    expect(classify(null, "com.example.someupdater")).toBe("unknown");
    expect(classify("pc", "com.example.someupdater")).toBe("unknown");
  });

  // @req REL-UPD-06
  it("no app sits on two lists", () => {
    const managing = Object.keys(MANAGING_INSTALLERS);
    for (const name of [...Object.keys(SYSTEM_INSTALLERS), ...Object.keys(HAND_INSTALL_INITIATORS), ...Object.keys(ADB_INSTALLERS)]) {
      expect(managing, name).not.toContain(name);
    }
  });
});
