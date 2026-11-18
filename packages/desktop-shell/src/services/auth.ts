export type ShellAuthUser = {
  id: string;
  email: string;
  emailVerified: boolean;
};

export type ShellAuthSession = {
  token: string;
  user: ShellAuthUser;
};

export type AuthService = {
  login: (input: { email: string; password: string; twoFactorCode?: string }) => Promise<ShellAuthSession>;
  signup?: (input: { email: string; password: string }) => Promise<void>;
  logout?: (token: string) => Promise<void>;
  verifyEmail?: (token: string) => Promise<ShellAuthSession>;
};

export type AuthSessionStore = {
  read: () => ShellAuthSession | null;
  write: (session: ShellAuthSession | null) => void;
};

export const createBrowserAuthSessionStore = (input?: { key?: string }): AuthSessionStore => {
  const key = input?.key?.trim() || "spacefleet.desktop.session";

  return {
    read: () => {
      if (typeof localStorage === "undefined") return null;
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as ShellAuthSession;
        if (!parsed?.token || !parsed?.user?.id || !parsed?.user?.email) return null;
        return parsed;
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
