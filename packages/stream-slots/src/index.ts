/**
 * @space/stream-slots: the per-profile stream limit every player obeys (ACCT-STREAM-01..04). Pure TypeScript, no
 * React / React Native / Electron imports: the desktop renderer, the phone and TV app, the website and Parrot use
 * it as is. Usage and the casting / offline rules: see `StreamSlot` in `streamSlot.ts`.
 */
export * from "./contract";
export * from "./client";
export * from "./streamSlot";
export * from "./strings";
export * from "./gate";
export * from "./alerts";
