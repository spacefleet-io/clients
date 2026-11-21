/** Types for `system-update.mjs` (REL-UPD-07), which the build scripts load as plain ESM. */
export declare const SYSTEM_UPDATE_EXIT: {
  readonly updated: 0;
  readonly notNewer: 10;
  readonly repoMissing: 11;
  readonly needsSystemUpdate: 12;
  readonly packageManager: 13;
  readonly usage: 64;
  readonly notManaged: 69;
  readonly notRoot: 77;
};
export declare const systemUpdateHelperPath: (packageName: string) => string;
export declare const systemUpdateActionId: (packageName: string) => string;
export declare const systemUpdateHelperLines: (packageName: string) => string[];
export declare const systemUpdatePolicy: (packageName: string, productName: string) => string;
export declare const systemUpdateFpmFiles: (options: { appDir: string; packageName: string; productName: string }) => string[];
