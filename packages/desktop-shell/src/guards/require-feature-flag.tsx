import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";

export const resolveFeatureFlagRedirect = (enabled: boolean, redirectTo: string) => {
  return enabled ? null : redirectTo;
};

type RequireFeatureFlagGuardProps = {
  enabled: boolean;
  redirectTo: string;
  children: ReactNode;
};

export const RequireFeatureFlagGuard = ({ enabled, redirectTo, children }: RequireFeatureFlagGuardProps) => {
  const target = resolveFeatureFlagRedirect(enabled, redirectTo);
  if (target) return <Navigate to={target} replace />;
  return <>{children}</>;
};
