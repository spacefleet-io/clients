/**
 * Browser / renderer-side logger. Zero Node deps — safe for Electron
 * renderer, the website, or any Vite-bundled surface.
 *
 * Mirrors the `@space/logger` (pino) shape so the mental model is identical
 * across processes. Structured-first: `log.info({ id }, "message")`.
 *
 * Level resolution order (highest priority first):
 *   1. `localStorage["sf:log-level"]` — runtime override; flip it from
 *      DevTools via `window.__sfLog.setLevel("trace")` and reload.
 *   2. `import.meta.env.VITE_SF_LOG_LEVEL` — baked at build via Vite's env
 *      inlining (`VITE_*` vars are the only ones exposed to the client).
 *   3. `import.meta.env.DEV ? "debug" : "info"` — fallback default.
 */

export type BrowserLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

const LEVEL_ORDER: Record<BrowserLogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const VALID_LEVELS = new Set<BrowserLogLevel>(["trace", "debug", "info", "warn", "error", "fatal"]);

const LOCAL_STORAGE_KEY = "sf:log-level";

export interface BrowserLogger {
  trace(obj: Record<string, unknown> | string, msg?: string): void;
  debug(obj: Record<string, unknown> | string, msg?: string): void;
  info(obj: Record<string, unknown> | string, msg?: string): void;
  warn(obj: Record<string, unknown> | string, msg?: string): void;
  error(obj: Record<string, unknown> | string, msg?: string): void;
  fatal(obj: Record<string, unknown> | string, msg?: string): void;
  child(bindings: Record<string, unknown>): BrowserLogger;
  readonly level: BrowserLogLevel;
  setLevel(level: BrowserLogLevel): void;
}

export type CreateBrowserLoggerOptions = {
  service: string;
  bindings?: Record<string, unknown>;
};

const isValidLevel = (value: unknown): value is BrowserLogLevel =>
  typeof value === "string" && VALID_LEVELS.has(value as BrowserLogLevel);

const safeLocalStorageGet = (key: string): string | null => {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const safeLocalStorageSet = (key: string, value: string): void => {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, value);
  } catch {
    // localStorage can throw (private mode, quota, disabled). Swallow.
  }
};

type ViteEnv = { DEV?: boolean; PROD?: boolean; VITE_SF_LOG_LEVEL?: string };

const readViteEnv = (): ViteEnv => {
  try {
    const metaEnv = (import.meta as unknown as { env?: ViteEnv }).env;
    return metaEnv ?? {};
  } catch {
    return {};
  }
};

const resolveInitialLevel = (): BrowserLogLevel => {
  const stored = safeLocalStorageGet(LOCAL_STORAGE_KEY);
  if (isValidLevel(stored)) return stored;
  const env = readViteEnv();
  if (isValidLevel(env.VITE_SF_LOG_LEVEL)) return env.VITE_SF_LOG_LEVEL;
  return env.DEV ? "debug" : "info";
};

const consoleFor = (level: BrowserLogLevel): ((...args: unknown[]) => void) => {
  if (typeof console === "undefined") return () => undefined;
  switch (level) {
    case "trace":
    case "debug":
      return console.debug?.bind(console) ?? console.log?.bind(console) ?? (() => undefined);
    case "info":
      return console.info?.bind(console) ?? console.log?.bind(console) ?? (() => undefined);
    case "warn":
      return console.warn?.bind(console) ?? console.log?.bind(console) ?? (() => undefined);
    case "error":
    case "fatal":
      return console.error?.bind(console) ?? console.log?.bind(console) ?? (() => undefined);
  }
};

type Shared = {
  service: string;
  level: BrowserLogLevel;
};

const makeLogger = (shared: Shared, bindings: Record<string, unknown>): BrowserLogger => {
  const emit = (level: BrowserLogLevel, objOrMsg: Record<string, unknown> | string, msg?: string) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[shared.level]) return;
    const [extra, text] =
      typeof objOrMsg === "string" ? [{}, objOrMsg] : [objOrMsg, msg ?? ""];
    const payload = { level, service: shared.service, ...bindings, ...extra };
    const write = consoleFor(level);
    if (text) {
      write(`[${shared.service}]`, text, payload);
    } else {
      write(`[${shared.service}]`, payload);
    }
  };

  return {
    trace: (obj, msg) => emit("trace", obj, msg),
    debug: (obj, msg) => emit("debug", obj, msg),
    info: (obj, msg) => emit("info", obj, msg),
    warn: (obj, msg) => emit("warn", obj, msg),
    error: (obj, msg) => emit("error", obj, msg),
    fatal: (obj, msg) => emit("fatal", obj, msg),
    child: (extra) => makeLogger(shared, { ...bindings, ...extra }),
    get level() {
      return shared.level;
    },
    setLevel: (level) => {
      if (!isValidLevel(level)) return;
      shared.level = level;
      safeLocalStorageSet(LOCAL_STORAGE_KEY, level);
    },
  };
};

export const createBrowserLogger = (options: CreateBrowserLoggerOptions): BrowserLogger => {
  const shared: Shared = {
    service: options.service,
    level: resolveInitialLevel(),
  };
  const logger = makeLogger(shared, options.bindings ?? {});

  // Expose a DevTools convenience on the window so a user can flip log level
  // from the console without rebuilding:
  //   __sfLog.setLevel("trace")
  //   __sfLog.getLevel()
  //   __sfLog.root
  //
  // Historically this was gated behind `env.DEV`, but a pure level-setter is a
  // harmless no-trust-required primitive — production renderers can expose it
  // too so E2E / on-site debugging can flip verbosity without a rebuild. The
  // `root` reference is kept minimal (just the public BrowserLogger surface).
  try {
    if (typeof window !== "undefined") {
      Object.assign(window, {
        __sfLog: {
          setLevel: (level: BrowserLogLevel) => logger.setLevel(level),
          getLevel: () => logger.level,
          root: logger,
        },
      });
    }
  } catch {
    // Non-browser or sandboxed environment — skip.
  }

  return logger;
};

export const BROWSER_LOG_LEVELS: readonly BrowserLogLevel[] = Object.freeze([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
]);
