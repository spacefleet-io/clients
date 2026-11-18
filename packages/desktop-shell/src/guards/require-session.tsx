import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";

export const resolveRequireSessionRedirect = <T,>(session: T | null | undefined, redirectTo: string) => {
  return session ? null : redirectTo;
};

type RequireSessionProps<T> = {
  session: T | null | undefined;
  redirectTo: string;
  children: ReactNode;
};

export const RequireSession = <T,>({ session, redirectTo, children }: RequireSessionProps<T>) => {
  const target = resolveRequireSessionRedirect(session, redirectTo);
  if (target) {
    return <Navigate to={target} replace />;
  }
  return <>{children}</>;
};
