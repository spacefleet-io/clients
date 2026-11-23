export type ApiHostState = {
  apiBaseUrl: string;
  customApiBaseUrl: string | null;
  defaultApiBaseUrl: string;
};

export type DesktopBridgeListener = {
  onApiHostChange?: (state: ApiHostState) => void;
};

export type DesktopPlatformBridge = {
  apiHost: {
    get: () => Promise<ApiHostState>;
    set: (input: { apiBaseUrl?: string | null }) => Promise<ApiHostState>;
    subscribe?: (listener: (state: ApiHostState) => void) => () => void;
  };
  app: {
    getName: () => Promise<string>;
    getVersion: () => Promise<string>;
  };
};

const normalize = (value: string) => value.trim().replace(/\/+$/, "");

export const createInMemoryPlatformBridge = (input?: {
  appName?: string;
  appVersion?: string;
  defaultApiBaseUrl?: string;
}): DesktopPlatformBridge => {
  const apiDefault = normalize(input?.defaultApiBaseUrl ?? "https://api.spacebadger.io");

  const apiListeners = new Set<(state: ApiHostState) => void>();

  let apiCustom: string | null = null;

  const getApiState = (): ApiHostState => ({
    apiBaseUrl: apiCustom ?? apiDefault,
    customApiBaseUrl: apiCustom,
    defaultApiBaseUrl: apiDefault,
  });

  return {
    apiHost: {
      get: async () => getApiState(),
      set: async ({ apiBaseUrl }) => {
        const next = typeof apiBaseUrl === "string" ? normalize(apiBaseUrl) : "";
        apiCustom = next.length > 0 ? next : null;
        const state = getApiState();
        for (const listener of apiListeners) listener(state);
        return state;
      },
      subscribe: (listener) => {
        apiListeners.add(listener);
        return () => apiListeners.delete(listener);
      },
    },
    app: {
      getName: async () => input?.appName?.trim() || "SpaceFleet Desktop",
      getVersion: async () => input?.appVersion?.trim() || "0.0.0-dev",
    },
  };
};
