/**
 * Badger phone's media library key change (ACCT-KEYCHG-01): the shared flow (`createKeyChange`) with this phone's
 * library sealed from its rotation snapshot, Parrot's re-encrypted with this phone's current key (PRIV-KEY-06), and each
 * file held while the phone is on mobile data unless the user allows it (ACCT-KEYCHG-05).
 */
import { createKeyChange, type KeyChange, type KeyChangeState } from "@space/media-reseal";
import type { RotationOwnLibrary } from "@space/shared/api";
import { encryptBytesToBase64 } from "./crypto";
import { getStoredLibraryKey } from "./onboarding";
import type { ResealNetworkGate } from "./resealNetwork";
import { reencryptParrotLibrary } from "./rotationCopies";

export type BadgerPhoneKeyChangeOptions = {
  token: string;
  newKeyBase64: string;
  /** The open library's rotation seal (`useLibrary().sealForRotation`); null when no library is open. */
  sealForRotation(newKeyBase64: string, copies: ReadonlyMap<string, string>): Promise<RotationOwnLibrary | null>;
  network: Pick<ResealNetworkGate, "beforeFile">;
  onState(state: KeyChangeState): void;
};

/** The account's key probe for the new key: 32 random bytes sealed under it. */
const keyProbe = async (newKeyBase64: string): Promise<string> => {
  const probeBytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(probeBytes);
  return await encryptBytesToBase64(newKeyBase64, probeBytes);
};

export const createBadgerPhoneKeyChange = (options: BadgerPhoneKeyChangeOptions): KeyChange => {
  const { token, newKeyBase64, sealForRotation, network, onState } = options;
  return createKeyChange({
    token,
    newKeyBase64,
    app: {
      appId: "badger",
      oldKey: getStoredLibraryKey,
      // PRIV-KEY-13: this library as a snapshot under the new key (chunks uploaded), declaring its formats.
      sealOwnLibrary: async (newKey, copies) => {
        const library = await sealForRotation(newKey, copies);
        if (!library) throw new Error("LIBRARY_NOT_OPEN");
        return library;
      },
      // PRIV-KEY-06: Parrot's library is re-encrypted with this phone's current key, never emptied.
      reencryptOtherLibraries: (oldKey, newKey, copies) => reencryptParrotLibrary(token, oldKey, newKey, copies),
      keyProbe,
    },
    onState,
    beforeFile: (signal) => network.beforeFile(signal),
  });
};
