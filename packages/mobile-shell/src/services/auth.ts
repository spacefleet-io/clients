export type ShellAuthUser = {
  id: string;
  email: string;
  emailVerified: boolean;
};

export type ShellAuthSession = {
  token: string;
  user: ShellAuthUser;
};

/** Phone and TV apps only sign in: no sign-up and no email verification here (ACCT-AUTH-10). */
export type AuthService = {
  login: (input: { email: string; password: string; twoFactorCode?: string }) => Promise<ShellAuthSession>;
  logout?: (token: string) => Promise<void>;
};

export type AuthSessionStore = {
  read: () => Promise<ShellAuthSession | null>;
  write: (session: ShellAuthSession | null) => Promise<void>;
};

type AsyncStorageApi = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

export const createAsyncStorageAuthSessionStore = (input: {
  asyncStorage: AsyncStorageApi;
  key?: string;
}): AuthSessionStore => {
  const key = input.key?.trim() || "spacefleet.mobile.session";

  return {
    read: async () => {
      const raw = await input.asyncStorage.getItem(key);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as ShellAuthSession;
        if (!parsed?.token || !parsed?.user?.id || !parsed?.user?.email) return null;
        return parsed;
      } catch {
        return null;
      }
    },
    write: async (session) => {
      if (!session) {
        await input.asyncStorage.removeItem(key);
        return;
      }
      await input.asyncStorage.setItem(key, JSON.stringify(session));
    },
  };
};
