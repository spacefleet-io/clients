/**
 * RT-SEC-05: Badger's access to the runtime's owner secret. The runtime
 * publishes it as `owner.secret` in its data dir (owner-only); every main
 * process login to the runtime sends it, and the renderer gets it over IPC
 * (`sf-runtime-owner-secret-get`, registered in index.ts). Read fresh on every
 * call: a restarted runtime issues a new one. Electron-free so the modules that
 * log in stay unit-testable.
 */
import { getDesktopPlatform } from "@space/desktop-platform";
import { ownerSecretFileProvider, readOwnerSecretFile } from "@space/runtime-client/ownerSecretFile";

/** Same dir the runtime resolves from the same env (SPACEFLEET_RUNTIME_DATA_DIR wins). */
const runtimeDataDir = (): string => getDesktopPlatform().paths.runtimeDataDir(process.env);

export const readRuntimeOwnerSecret = (): string | null => readOwnerSecretFile(runtimeDataDir());

/** For `createRuntimeSession({ ownerSecret })` in the main process. */
export const runtimeOwnerSecretProvider = ownerSecretFileProvider(runtimeDataDir);
