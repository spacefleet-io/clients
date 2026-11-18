import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";

export type AuthGuardStatus = "loading" | "unauthenticated" | "ready";

export const resolveAuthGuardStatus = (input: { loading: boolean; isAuthenticated: boolean }): AuthGuardStatus => {
  if (input.loading) return "loading";
  if (!input.isAuthenticated) return "unauthenticated";
  return "ready";
};

type RequireAuthGuardProps = {
  loading: boolean;
  isAuthenticated: boolean;
  loadingFallback: ReactNode;
  unauthenticatedRedirectTo: string;
  children: ReactNode;
};

export const RequireAuthGuard = ({
  loading,
  isAuthenticated,
  loadingFallback,
  unauthenticatedRedirectTo,
  children,
}: RequireAuthGuardProps) => {
  const status = resolveAuthGuardStatus({ loading, isAuthenticated });
  if (status === "loading") return <>{loadingFallback}</>;
  if (status === "unauthenticated") return <Navigate to={unauthenticatedRedirectTo} replace />;
  return <>{children}</>;
};
