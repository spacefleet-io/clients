import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import type { ClientReadyStatus } from "./client-ready";

export const resolveClientReadyRedirect = (input: {
  status: ClientReadyStatus;
  loginRedirectTo: string;
  keyRedirectTo: string;
}): string | null => {
  if (input.status === "needs_login") return input.loginRedirectTo;
  if (input.status === "needs_key") return input.keyRedirectTo;
  return null;
};

type RequireClientReadyGuardProps = {
  status: ClientReadyStatus;
  loadingFallback: ReactNode;
  loginRedirectTo: string;
  keyRedirectTo: string;
  children: ReactNode;
};

export const RequireClientReadyGuard = ({
  status,
  loadingFallback,
  loginRedirectTo,
  keyRedirectTo,
  children,
}: RequireClientReadyGuardProps) => {
  if (status === "checking") return <>{loadingFallback}</>;
  const redirect = resolveClientReadyRedirect({ status, loginRedirectTo, keyRedirectTo });
  if (redirect) return <Navigate to={redirect} replace />;
  return <>{children}</>;
};
