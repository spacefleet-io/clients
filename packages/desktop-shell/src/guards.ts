export type DesktopShellGuardBoundary = {
  id: string;
  description: string;
};

export const desktopShellGuards: DesktopShellGuardBoundary[] = [
  { id: "RequireSession", description: "Route guard requiring authenticated shell session." },
  { id: "RequireClientReady", description: "Route guard requiring app bootstrap readiness." },
];

export { RequireSession, resolveRequireSessionRedirect } from "./guards/require-session";
export {
  resolveClientReadyStatus,
  type ClientReadyDecisionInput,
  type ClientReadyStatus,
} from "./guards/client-ready";
export { RequireAuthGuard, resolveAuthGuardStatus, type AuthGuardStatus } from "./guards/require-auth";
export { RequireClientReadyGuard, resolveClientReadyRedirect } from "./guards/require-client-ready";
export { RequireFeatureFlagGuard, resolveFeatureFlagRedirect } from "./guards/require-feature-flag";
