/**
 * Phone unlock before approving a device (ACCT-PAIR-02).
 *
 * Uses the platform keystore through react-native-keychain, which the app already ships for the
 * library key: a small marker secret is stored behind an access-control policy of "biometrics or
 * the device PIN/pattern/password". Reading it back makes the OS show its own unlock prompt, so
 * the biometric/PIN check is done by Android BiometricPrompt / iOS LocalAuthentication and never
 * by app code. A phone with no screen lock cannot store such an item, so it is refused up front.
 */

import * as Keychain from "react-native-keychain";
import { translate } from "../i18n";
import { scopeLogger } from "../logger";
import { PairingFlowError } from "./pairingFlow";

const log = scopeLogger("pairing.unlock");

const UNLOCK_SERVICE = "sf_pairing_unlock";
const UNLOCK_MARKER = "unlock";

/** Built per call so the OS prompt follows the UI language. */
const unlockOptions = () =>
  ({
    service: UNLOCK_SERVICE,
    accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
    accessible: Keychain.ACCESSIBLE.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
    authenticationPrompt: {
      title: translate("pairing.unlock.title"),
      subtitle: translate("pairing.unlock.subtitle"),
      cancel: translate("pairing.unlock.cancel"),
    },
  }) satisfies Keychain.SetOptions;

/** Does this phone have a screen lock or biometrics the OS can ask for? */
export const deviceHasLock = async (): Promise<boolean> => {
  try {
    if (await Keychain.isPasscodeAuthAvailable()) return true;
    if ((await Keychain.getSupportedBiometryType()) !== null) return true;
    return await Keychain.canImplyAuthentication({
      authenticationType: Keychain.AUTHENTICATION_TYPE.DEVICE_PASSCODE_OR_BIOMETRICS,
    });
  } catch (error) {
    log.warn("lock_check.failed", { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
};

const isCancel = (error: unknown): boolean => {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const text = `${code} ${error instanceof Error ? error.message : String(error)}`.toLowerCase();
  return /cancel|user_cancel|negative button|dismiss|usercancel|too many attempts|lockout/.test(text);
};

/** Resolves when the user unlocked the phone; throws PairingFlowError otherwise. */
export const requireDeviceUnlock = async (): Promise<void> => {
  if (!(await deviceHasLock())) {
    log.warn("no_device_lock");
    throw new PairingFlowError("no_device_lock");
  }

  try {
    const options = unlockOptions();
    const existing = await Keychain.getGenericPassword(options);
    if (existing) {
      log.warn("unlocked", { via: "read" });
      return;
    }
    // First use on this phone (or the OS dropped the item because the lock changed): create the
    // marker. Creating it behind the policy is itself guarded by the unlock prompt on Android.
    const created = await Keychain.setGenericPassword("pairing", UNLOCK_MARKER, options);
    if (!created) throw new Error("keychain refused to store the unlock marker");
    const verified = await Keychain.getGenericPassword(options);
    if (!verified) throw new Error("unlock marker unreadable after creation");
    log.warn("unlocked", { via: "create" });
  } catch (error) {
    if (isCancel(error)) {
      log.warn("cancelled", { error: error instanceof Error ? error.message : String(error) });
      throw new PairingFlowError("unlock_cancelled");
    }
    log.warn("failed", { error: error instanceof Error ? error.message : String(error) });
    // A lock that was removed after the marker was created makes the stored item unusable: reset it
    // so the next attempt starts clean, and say the phone has no lock if that is the reason.
    await Keychain.resetGenericPassword({ service: UNLOCK_SERVICE }).catch(() => undefined);
    throw new PairingFlowError((await deviceHasLock()) ? "unlock_failed" : "no_device_lock");
  }
};
