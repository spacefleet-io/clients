import type { AccountKeyCheckDeps } from "@space/desktop-shell/account-key-check";
import type { ParrotCreateKeyResult } from "../shared/ipc";
import { keyStepMetaErrorClass } from "@space/shared/keyStepMetaRead";

/** The library apps whose snapshot a key is tried on, Parrot's first. */
export const KEY_CHECK_APP_IDS = ["parrot", "badger"] as const;
type KeyCheckAppId = (typeof KEY_CHECK_APP_IDS)[number];

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The key step's first question (UX-KEY-01): an account with no library and no key probe gets a new key to show
 * (nothing stored until the user has written it down and it is checked in with `checkKeyAgainstAccount`); an account
 * that already has a key (a probe, or a library a fresh key cannot open) answers "hasLibrary" and the step asks for it.
 * When neither can be read (or not in time), nothing is decided: "network" with why, and the step offers Retry
 * (UX-KEY-02).
 */
export const makeAccountKey = async (
  newKey: { keyBase64: string; words: string[] },
  deps: Pick<AccountKeyCheckDeps<KeyCheckAppId>, "fetchSnapshot" | "fetchKeyProbe" | "log" | "fail">,
): Promise<ParrotCreateKeyResult> => {
  try {
    if (await deps.fetchKeyProbe()) {
      deps.log("[key] the account already has a key (its probe is on the server): asking for it");
      return { ok: false, error: "hasLibrary" };
    }
  } catch (error) {
    deps.fail(`[key] could not read the account's key probe: ${errorText(error)}`);
    return { ok: false, error: "network", message: errorText(error), errorClass: keyStepMetaErrorClass(error) };
  }
  for (const appId of KEY_CHECK_APP_IDS) {
    try {
      if (await deps.fetchSnapshot(appId)) return { ok: false, error: "hasLibrary" };
    } catch (error) {
      if (errorText(error) === "DECRYPT_FAILED") {
        deps.log(`[key] the account already has a ${appId} library: asking for its key`);
        return { ok: false, error: "hasLibrary" };
      }
      deps.fail(`[key] could not check for an existing ${appId} library: ${errorText(error)}`);
      return { ok: false, error: "network", message: errorText(error), errorClass: keyStepMetaErrorClass(error) };
    }
  }
  deps.log("[key] the account has no key yet: a new one is shown");
  return { ok: true, ...newKey };
};
