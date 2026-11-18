import type { LibraryMeta } from "@space/shared/api";
import { classifyLibraryMeta, type LibraryMetaState } from "@space/shared/libraryMetaState";

/**
 * Whether the ACCOUNT has a library key, from the meta Badger reads: `present` as soon as any app (Badger or Parrot)
 * holds a key probe, even with no Badger library yet (PRIV-KEY-01, one key per account; the API returns the account's
 * newest probe since 791aa12f8), otherwise Badger's own library state. A probe means a key exists, so the key step
 * asks for it and never generates a new one; no probe anywhere and no library means a new key is made here.
 */
export const accountKeyState = (meta: Pick<LibraryMeta, "exists" | "bootstrapRequired" | "keyProbe">): LibraryMetaState =>
  meta.keyProbe ? "present" : classifyLibraryMeta(meta);

/**
 * Key screen entry mode. A fresh key is generated only when the server
 * confirms no library was ever created; a failed check (`null`), an
 * unavailable snapshot or an existing library all ask for the existing key,
 * because a generated key would replace the user's real one.
 */
export const keyOnboardingStart = (state: LibraryMetaState | null): "enter" | "generate" =>
  state === "absent" ? "generate" : "enter";

/**
 * What "Continue" may do with a generated key, re-checked at tap time:
 * create the library only while it is still absent; switch to entering the
 * existing key if one appeared; otherwise keep nothing and let the user retry.
 */
export const generatedKeyAction = (state: LibraryMetaState | null): "create" | "enterExisting" | "retry" => {
  if (state === "absent") return "create";
  return state === "present" ? "enterExisting" : "retry";
};
