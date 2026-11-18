export type RuntimeSession = {
  runtimeBaseUrl: string;
  runtimeToken: string;
  backendToken: string;
};

export type RuntimeSessionService = {
  createSession: (input: { runtimeBaseUrl: string; backendToken: string }) => Promise<RuntimeSession>;
  refreshSession?: (session: RuntimeSession) => Promise<RuntimeSession>;
  closeSession?: (session: RuntimeSession) => Promise<void>;
};

export type RuntimeSessionStore<T extends RuntimeSession = RuntimeSession> = {
  read: () => T | null;
  write: (session: T | null) => void;
};

export const createBrowserRuntimeSessionStore = <T extends RuntimeSession = RuntimeSession>(input?: {
  key?: string;
  validate?: (value: unknown) => value is T;
}): RuntimeSessionStore<T> => {
  const key = input?.key?.trim() || "spacefleet.desktop.runtime.session";

  return {
    read: () => {
      if (typeof localStorage === "undefined") return null;
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (input?.validate && !input.validate(parsed)) return null;
        if (!input?.validate) {
          const fallback = parsed as RuntimeSession;
          if (!fallback?.runtimeBaseUrl || !fallback?.runtimeToken || !fallback?.backendToken) return null;
        }
        return parsed as T;
      } catch {
        return null;
      }
    },
    write: (session) => {
      if (typeof localStorage === "undefined") return;
      if (!session) {
        localStorage.removeItem(key);
        return;
      }
      localStorage.setItem(key, JSON.stringify(session));
    },
  };
};
