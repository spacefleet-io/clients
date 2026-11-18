/**
 * ACCT-SIGNIN-05: the channels between main and the window for a Google, Apple or Microsoft sign-in coming back through
 * `badger://auth/provider`. Main nudges the window on `returned` (no payload); the window pulls the outcome through
 * `pending` (main/protocolLink.ts `createProviderReturnMailbox`), so each outcome is handed over once.
 */
export const PROVIDER_RETURN_IPC = { returned: "sf-provider-sign-in-return", pending: "sf-provider-sign-in-pending" } as const;
