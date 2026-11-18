export type AuthGuardStatus = "loading" | "unauthenticated" | "blocked" | "ready";

export const resolveAuthGuardStatus = (input: {
  loading: boolean;
  isAuthenticated: boolean;
  isBlocked?: boolean;
}): AuthGuardStatus => {
  if (input.loading) return "loading";
  if (!input.isAuthenticated) return "unauthenticated";
  if (input.isBlocked) return "blocked";
  return "ready";
};
