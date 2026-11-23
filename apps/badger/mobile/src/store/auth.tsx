import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getMe, isSessionRejected, login as apiLogin, logout as apiLogout, type LoginDevice, User } from "@space/shared/api";
import { keyAfterSignedOut, type SignedOutReason } from "@space/shared/keptLibraryKey";
import { LibraryDb } from "../lib/libraryDb";
import { scopeLogger } from "@space/mobile-shell/logger";
import { forgetKnownSessions } from "../lib/pairing/deviceWatch";
import { clearPlayStartWarm } from "../lib/playback/playStartCache";
import { clearLibraryKey } from "../lib/onboarding";

const log = scopeLogger("auth");

const TOKEN_KEY = "sf_auth_token";
const USER_KEY = "sf_auth_user";

export type AuthContextValue = {
  user: User | null;
  token: string | null;
  loading: boolean;
  /** `device`: the name and type the account's device list shows for this session (ACCT-DEV-01). */
  login: (email: string, password: string, code?: string, device?: LoginDevice) => Promise<void>;
  /** Starts a session from a token the API already issued (device pairing), persisted exactly like `login`. */
  setSession: (token: string, user: User) => Promise<void>;
  /** The user's own Sign out forgets the library key; a session the server refused keeps it (#1361). */
  logout: (reason: SignedOutReason) => Promise<void>;
  refresh: () => Promise<void>;
  setUser: (user: User | null) => void;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const loadStoredUser = async () => {
  const raw = await AsyncStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
};

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUserState] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // The token the current session was started with; a late `/auth/me` answer for a token that has since been
  // replaced (login) or dropped (logout) must not resurrect the old session.
  const sessionTokenRef = useRef<string | null>(null);

  const persistUser = useCallback(async (next: User | null) => {
    if (!next) {
      await AsyncStorage.removeItem(USER_KEY);
      return;
    }
    await AsyncStorage.setItem(USER_KEY, JSON.stringify(next));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const storedToken = await AsyncStorage.getItem(TOKEN_KEY);
    const storedUser = await loadStoredUser();
    if (!storedToken) {
      sessionTokenRef.current = null;
      setUserState(null);
      setToken(null);
      setLoading(false);
      log.info("load.no_token");
      return;
    }
    sessionTokenRef.current = storedToken;
    setToken(storedToken);

    // The server check only confirms or rejects the saved session. With a saved user the app can render from
    // its local copy right away, so the check runs behind the first paint instead of holding it (and, with
    // the API unreachable, holding it for as long as the request stalls).
    const validate = async () => {
      try {
        const res = await getMe(storedToken);
        if (sessionTokenRef.current !== storedToken) return;
        setUserState(res.user);
        await persistUser(res.user);
      } catch (err) {
        log.error("load.failed", { error: err instanceof Error ? err.message : String(err) });
        if (sessionTokenRef.current !== storedToken) return;
        if (isSessionRejected(err)) {
          sessionTokenRef.current = null;
          setToken(null);
          setUserState(null);
          await AsyncStorage.removeItem(TOKEN_KEY);
          await AsyncStorage.removeItem(USER_KEY);
        } else {
          // Offline / server down: keep the stored session so downloads stay playable.
          log.warn("load.offline_keep_session", { hasUser: Boolean(storedUser) });
        }
      }
    };

    if (storedUser) {
      setUserState(storedUser);
      setLoading(false);
      await validate();
      return;
    }
    try {
      await validate();
    } finally {
      setLoading(false);
    }
  }, [persistUser]);

  useEffect(() => {
    void load();
  }, [load]);

  const login = useCallback(
    async (email: string, password: string, code?: string, device?: LoginDevice) => {
      log.info("login.start");
      const response = await apiLogin(email, password, code, undefined, device);
      sessionTokenRef.current = response.token;
      setToken(response.token);
      setUserState(response.user);
      await AsyncStorage.setItem(TOKEN_KEY, response.token);
      await persistUser(response.user);
      log.info("login.success", { userId: response.user?.id ?? null });
    },
    [persistUser]
  );

  const setSession = useCallback(
    async (nextToken: string, nextUser: User) => {
      log.info("setSession.start");
      sessionTokenRef.current = nextToken;
      setToken(nextToken);
      setUserState(nextUser);
      await AsyncStorage.setItem(TOKEN_KEY, nextToken);
      await persistUser(nextUser);
      log.info("setSession.success", { userId: nextUser.id ?? null });
    },
    [persistUser]
  );

  const logout = useCallback(async (reason: SignedOutReason) => {
    const key = keyAfterSignedOut(reason);
    log.info("logout", { reason, key });
    if (token) {
      await apiLogout(token).catch(() => undefined);
    }
    sessionTokenRef.current = null;
    setToken(null);
    setUserState(null);
    await AsyncStorage.removeItem(TOKEN_KEY);
    await AsyncStorage.removeItem(USER_KEY);
    await forgetKnownSessions().catch(() => undefined);
    await LibraryDb.clearLocalCache().catch(() => undefined);
    if (key === "clear") await clearLibraryKey().catch(() => undefined);
    clearPlayStartWarm();
  }, [token]);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const res = await getMe(token);
      setUserState(res.user);
      await persistUser(res.user);
    } catch (error) {
      log.warn("refresh.failed", { status: error instanceof ApiError ? error.status : null, error: error instanceof Error ? error.message : String(error) });
      if (error instanceof ApiError && error.status === 401) {
        await logout("sessionRejected");
      }
    }
  }, [logout, persistUser, token]);

  const setUser = useCallback(
    (next: User | null) => {
      setUserState(next);
      void persistUser(next);
    },
    [persistUser]
  );

  const value = useMemo(
    () => ({ user, token, loading, login, setSession, logout, refresh, setUser }),
    [user, token, loading, login, setSession, logout, refresh, setUser]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("AUTH_CONTEXT_MISSING");
  }
  return value;
};
