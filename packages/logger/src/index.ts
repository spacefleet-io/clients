import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";
import { createRequire } from "node:module";

export type CreateLoggerOptions = {
  service: string;
  level?: string;
  pretty?: boolean;
  base?: Record<string, unknown>;
  destination?: DestinationStream;
  redactPaths?: string[];
};

const DEFAULT_REDACT_PATHS = [
  "token",
  "*.token",
  "authorization",
  "*.authorization",
  "password",
  "*.password",
  "secret",
  "*.secret",
  "keyBase64",
  "*.keyBase64",
  // WAIT-JOIN-05: no email address in a log line.
  "email",
  "*.email",
];

const envTruthy = (value: string | undefined) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

const shouldPrettyPrint = (explicitPretty: boolean | undefined) => {
  if (typeof explicitPretty === "boolean") return explicitPretty;
  if (envTruthy(process.env.SF_LOG_PRETTY) || envTruthy(process.env.LOG_PRETTY)) return true;
  return process.env.NODE_ENV !== "production";
};

const resolveLogLevel = (explicitLevel: string | undefined) => {
  const level = String(explicitLevel ?? process.env.SF_LOG_LEVEL ?? process.env.LOG_LEVEL ?? "info").trim();
  return level.length > 0 ? level : "info";
};

const require = createRequire(import.meta.url);

const resolvePrettyFactory = () => {
  try {
    const mod = require("pino-pretty");
    if (typeof mod === "function") return mod as (opts?: Record<string, unknown>) => DestinationStream;
    if (mod && typeof mod.default === "function") {
      return mod.default as (opts?: Record<string, unknown>) => DestinationStream;
    }
  } catch {
    // Fall back to plain pino logger when pretty transport can't be loaded.
  }
  return null;
};

/**
 * Where error and fatal log lines are reported besides the log (spec REL-LOG-11: the service's Bugsink
 * project). Set once at start by the server; until then, and when a service
 * has no DSN, nothing is reported.
 */
export type ErrorReporter = {
  /** An error with its stack: the `err` field of the line, or the one attached with `reportedError`. */
  exception(error: Error, message: string): void;
  /** A line without an Error: only its message (a fixed text) is reported, never its fields. */
  message(message: string): void;
};

let errorReporter: ErrorReporter | null = null;

export const setErrorReporter = (reporter: ErrorReporter | null) => {
  errorReporter = reporter;
};

/**
 * Key of a log line's fields that hands an Error to the error reporter without writing it to the log
 * (a symbol key is never serialised): `logger.error({ errorName, [reportedError]: error }, "...")`.
 */
export const reportedError: unique symbol = Symbol.for("@space/logger.reportedError");

/** Key of a log line's fields that keeps that error line out of the error reporter (a symbol, not logged). */
export const notReported: unique symbol = Symbol.for("@space/logger.notReported");

const ERROR_LEVEL = 50;

const reportLine = (args: unknown[]) => {
  const reporter = errorReporter;
  if (!reporter) return;
  const [first, second] = args;
  const fields = typeof first === "object" && first !== null ? (first as Record<string | symbol, unknown>) : null;
  if (fields?.[notReported]) return;
  const message = typeof first === "string" ? first : typeof second === "string" ? second : "";
  const attached = fields?.[reportedError] ?? fields?.err ?? (first instanceof Error ? first : undefined);
  try {
    if (attached instanceof Error) reporter.exception(attached, message);
    else if (message) reporter.message(message);
  } catch {
    // Reporting never breaks logging.
  }
};

const hooks: LoggerOptions["hooks"] = {
  logMethod(args, method, level) {
    if (level >= ERROR_LEVEL) reportLine(args);
    return method.apply(this, args);
  },
};

export const createLogger = (options: CreateLoggerOptions): Logger => {
  const pretty = shouldPrettyPrint(options.pretty);
  const level = resolveLogLevel(options.level);
  const redact = options.redactPaths ?? DEFAULT_REDACT_PATHS;
  const loggerOptions: LoggerOptions = {
    hooks,
    level,
    base: {
      service: options.service,
      env: process.env.NODE_ENV ?? "development",
      ...(options.base ?? {}),
    },
    redact: {
      paths: redact,
      remove: true,
    },
  };

  if (options.destination) {
    return pino(loggerOptions, options.destination);
  }

  if (!pretty) {
    return pino(loggerOptions);
  }

  const prettyFactory = resolvePrettyFactory();
  if (!prettyFactory) {
    return pino(loggerOptions);
  }
  const stream = prettyFactory({
    colorize: true,
    translateTime: "SYS:standard",
    ignore: "pid,hostname",
    singleLine: true,
    // Written before the call returns, like plain pino's stdout: pino-pretty's default async write lost the last
    // line of a process that exits right after it (`shutdown_forced` before process.exit(1), REL-CD-06).
    sync: true,
  });
  return pino(loggerOptions, stream);
};

export const childLogger = (logger: Logger, bindings: Record<string, unknown>) => logger.child(bindings);
