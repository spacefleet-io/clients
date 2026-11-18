import { useSyncExternalStore } from "react";
import { getClientConfigSnapshot, subscribeClientConfig } from "./config";

export function useClientConfig() {
  return useSyncExternalStore(subscribeClientConfig, getClientConfigSnapshot, getClientConfigSnapshot);
}
