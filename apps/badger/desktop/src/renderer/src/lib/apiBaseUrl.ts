import { PRODUCTION_API_BASE_URL } from "@space/shared/productionApi";

export type RendererApiEnv = {
  VITE_API_BASE_URL?: string;
  DEV?: boolean;
};

export const resolveInitialApiBaseUrl = (env: RendererApiEnv): string => {
  const fromEnv = env.VITE_API_BASE_URL?.trim();
  if (fromEnv) return fromEnv;
  if (env.DEV) return "/api";
  return PRODUCTION_API_BASE_URL;
};
