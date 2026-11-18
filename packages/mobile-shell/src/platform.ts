import { PRODUCTION_API_BASE_URL } from "@space/shared/productionApi";

export type ApiHostState = {
  apiBaseUrl: string;
  customApiBaseUrl: string | null;
  defaultApiBaseUrl: string;
};

export type MobilePlatformBridge = {
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

export const createInMemoryMobilePlatformBridge = (input?: {
  appName?: string;
  appVersion?: string;
  defaultApiBaseUrl?: string;
}): MobilePlatformBridge => {
  const apiDefault = normalize(input?.defaultApiBaseUrl ?? PRODUCTION_API_BASE_URL);
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
      getName: async () => input?.appName?.trim() || "SpaceFleet Mobile",
      getVersion: async () => input?.appVersion?.trim() || "0.0.0-dev",
    },
  };
};

type AsyncStorageApi = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

export const createAsyncStoragePlatformBridge = (input: {
  asyncStorage: AsyncStorageApi;
  storageKey?: string;
  appName?: string;
  appVersion?: string;
  defaultApiBaseUrl?: string;
}): MobilePlatformBridge => {
  const { asyncStorage } = input;
  const storageKey = input.storageKey?.trim() || "spacefleet.mobile.apiHost";
  const apiDefault = normalize(input.defaultApiBaseUrl ?? PRODUCTION_API_BASE_URL);
  const apiListeners = new Set<(state: ApiHostState) => void>();
  let cachedCustom: string | null = null;
  let initialized = false;

  const getApiState = (): ApiHostState => ({
    apiBaseUrl: cachedCustom ?? apiDefault,
    customApiBaseUrl: cachedCustom,
    defaultApiBaseUrl: apiDefault,
  });

  const ensureLoaded = async () => {
    if (initialized) return;
    const stored = await asyncStorage.getItem(storageKey);
    if (stored) cachedCustom = normalize(stored);
    initialized = true;
  };

  return {
    apiHost: {
      get: async () => {
        await ensureLoaded();
        return getApiState();
      },
      set: async ({ apiBaseUrl }) => {
        await ensureLoaded();
        const next = typeof apiBaseUrl === "string" ? normalize(apiBaseUrl) : "";
        cachedCustom = next.length > 0 ? next : null;
        if (cachedCustom) {
          await asyncStorage.setItem(storageKey, cachedCustom);
        } else {
          await asyncStorage.removeItem(storageKey);
        }
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
      getName: async () => input.appName?.trim() || "SpaceFleet Mobile",
      getVersion: async () => input.appVersion?.trim() || "0.0.0-dev",
    },
  };
};
