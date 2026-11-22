import { AsyncLocalStorage } from "node:async_hooks";
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

/**
 * REL-LOG-28: the id of the request being served, bound to every line written while it runs (its handlers, its
 * services, the unhandled-error line), so a refusal or a failure is found next to its request line. Random per
 * request and made by the server; never a value a client sent.
 */
const requestScope = new AsyncLocalStorage<{ requestId: string }>();

/** Runs `fn` (a request's handlers) with `requestId` on every line it writes. */
export const runWithRequestId = <T>(requestId: string, fn: () => T): T => requestScope.run({ requestId }, fn);

// A fresh object per line: pino merges the line's own fields into what `mixin` returns, so handing it the store
// itself would leave every line's fields on the request and on each later line it writes.
const mixin = (): object => {
  const store = requestScope.getStore();
  return store ? { requestId: store.requestId } : {};
};

/** A code an error carries (`ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`, a Postgres `23505`): never free text. */
const ERROR_CODE = /^[A-Za-z0-9_.-]{1,48}$/;

const codeOf = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const { code } = error as { code: unknown };
  return typeof code === "string" && ERROR_CODE.test(code) ? code : null;
};

const nameOf = (error: unknown): string => (error instanceof Error ? error.constructor.name || error.name : "unknown");

/** What a log line says about a caught error (`errorFields`). */
export type ErrorFields = { errorName: string; errorCode?: string; errorAt?: string[]; causeName?: string; causeCode?: string };

/** How many stack frames `errorAt` keeps: enough to find the failing call and its caller, short enough for one line. */
const FRAME_LIMIT = 5;

/**
 * One stack frame as the runtime writes it: `at fn (file:line:col)` or `at file:line:col`, a name of identifier
 * characters and a path of file-name characters (`@` for scoped packages). A line with anything else (quotes,
 * commas, text after the frame) is not a plain frame and is dropped whole.
 */
const FRAME = /^\s*at (?:([A-Za-z0-9_$.<>[\] ]{1,80}) \()?([A-Za-z0-9_@./:-]{1,300}):(\d{1,7}):\d{1,7}\)?$/;

/** The file of a frame without the machine's folders: `pkg/lib/x.js` under `node_modules`, else the file name. */
const shortFile = (path: string): string => {
  const modules = path.lastIndexOf("/node_modules/");
  if (modules >= 0) return path.slice(modules + "/node_modules/".length);
  return path.slice(path.lastIndexOf("/") + 1);
};

/**
 * REL-LOG-30: where an error was thrown, as up to five `fn file:line` frames taken from its stack. The stack opens
 * with the class and the message, over as many lines as the message has; those lines are skipped by count, so a
 * message that itself looks like a frame never reaches the line.
 */
const framesOf = (error: Error): string[] | null => {
  if (typeof error.stack !== "string") return null;
  const headerLines = typeof error.message === "string" && error.message.length > 0 ? error.message.split("\n").length : 1;
  const frames: string[] = [];
  for (const line of error.stack.split("\n").slice(headerLines)) {
    const match = FRAME.exec(line);
    if (!match) continue;
    const [, fn, path, row] = match;
    const at = `${shortFile(path ?? "")}:${row}`;
    frames.push(fn ? `${fn} ${at}` : at);
    if (frames.length === FRAME_LIMIT) break;
  }
  return frames.length > 0 ? frames : null;
};

/**
 * REL-LOG-29: what a log line says about a caught error: its class and its code, and those of its `cause` (a fetch
 * failure's `TypeError` hides the socket error there). Never its message: a driver's message can carry the query's
 * values (an email address, an id), an HTTP client's the URL it called. At error level, also attach the error itself
 * with `[reportedError]: error` so its stack reaches the error reporter. REL-LOG-30: `errorAt` gives where it was
 * thrown (function, file and line, no message), so a warn line about a plain `Error` without a code, which reaches
 * no error reporter, still points at the failing call.
 */
export const errorFields = (error: unknown): ErrorFields => {
  const fields: ErrorFields = { errorName: nameOf(error) };
  const code = codeOf(error);
  if (code) fields.errorCode = code;
  const frames = error instanceof Error ? framesOf(error) : null;
  if (frames) fields.errorAt = frames;
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause !== undefined) {
    fields.causeName = nameOf(cause);
    const causeCode = codeOf(cause);
    if (causeCode) fields.causeCode = causeCode;
  }
  return fields;
};

export const createLogger = (options: CreateLoggerOptions): Logger => {
  const pretty = shouldPrettyPrint(options.pretty);
  const level = resolveLogLevel(options.level);
  const redact = options.redactPaths ?? DEFAULT_REDACT_PATHS;
  const loggerOptions: LoggerOptions = {
    hooks,
    mixin,
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
