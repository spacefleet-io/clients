/**
 * The phone apps' structured logger (Badger, Parrot: REL-FAM-03, one app basis).
 *
 * In dev builds all levels are emitted: debug/info via console.log, warn/error via console.warn, so the on-device
 * LogBox (yellow "Open debugger to view warnings" banner) only shows real warnings. In production builds, only warn
 * and error are emitted.
 *
 * Every warn/error line also goes to the app's error log (`readErrorLog`): the newest lines, scrubbed as they are
 * recorded, kept in memory only and sent solely with feedback the user chose to attach it to (UX-SUP-02, UX-SUP-05).
 *
 * Usage:
 *   const log = scopeLogger("auth");
 *   log.info("login.start", { email });
 *   log.error("login.failed", { status: 401 });
 */
import { createErrorLog } from "@space/error-report/error-log";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// React Native defines `__DEV__` as a global; a test runner without it gets production behaviour.
const minLevel: LogLevel = typeof __DEV__ !== "undefined" && __DEV__ ? "debug" : "warn";

const errorLog = createErrorLog();

export const readErrorLog = (): string => errorLog.read();

const emit = (level: LogLevel, scope: string, event: string, data?: Record<string, unknown>) => {
  const prefix = `[${level.toUpperCase()}] [${scope}]`;
  const payload = data ? JSON.stringify(data) : undefined;
  if (level === "warn" || level === "error") errorLog.record(level, scope, `${event}${payload ? ` ${payload}` : ""}`);
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
  const sink = level === "debug" || level === "info" ? console.log : console.warn;
  if (payload) {
    sink(`${prefix} ${event}`, payload);
  } else {
    sink(`${prefix} ${event}`);
  }
};

export type MobileLogger = {
  debug: (event: string, data?: Record<string, unknown>) => void;
  info: (event: string, data?: Record<string, unknown>) => void;
  warn: (event: string, data?: Record<string, unknown>) => void;
  error: (event: string, data?: Record<string, unknown>) => void;
};

export const scopeLogger = (scope: string): MobileLogger => ({
  debug: (event, data) => emit("debug", scope, event, data),
  info: (event, data) => emit("info", scope, event, data),
  warn: (event, data) => emit("warn", scope, event, data),
  error: (event, data) => emit("error", scope, event, data),
});
