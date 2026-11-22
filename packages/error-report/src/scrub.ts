/**
 * REL-LOG-06 scrubber. A report may carry only the error, its stack trace, the
 * app version and the operating system. It never carries a file name, a title,
 * a path, a URL, a user or account detail, or an address.
 *
 * The scrubber is an ALLOWLIST: it builds a new event from the few fields we
 * want and copies nothing else, so a field a future SDK version adds is dropped
 * until someone decides it is safe.
 */

/** Longest exception message we keep, in characters. */
export const MAX_MESSAGE_LENGTH = 300;

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`)\]]*/gi;
const QUOTED_PATTERN = /(["'`])(?:(?!\1)[^\n])*\1/g;
const WINDOWS_PATH_PATTERN = /(?:\b[A-Za-z]:[\\/]|\\\\[^\s\\/]+[\\/])[^\n]*/g;
// An absolute or home-relative path after whitespace, a bracket, `=` `:` `,`, or at the start.
// A path may hold spaces ("/media/Blade Runner (1982).mkv"), so everything to the end of the line goes.
const POSIX_PATH_PATTERN = /(^|[\s(\[=:,])(?:~|\.{1,2})?\/[\w.@%+~-][^\n]*/g;
// A relative path ("Movies/Dune Part Two.mkv"): a word, a slash, then to the end of the line, as spaces are allowed.
const RELATIVE_PATH_PATTERN = /\b[\w.-]+\/[\w.@%+~-][^\n]*/g;
// A bare file name with a media or document extension ("Dune.Part.Two.2024.mkv").
const FILE_NAME_PATTERN = /[^\s/\\'"`<>]+\.(?:mkv|mp4|m4v|avi|mov|webm|wmv|flv|mpg|mpeg|mp3|m4a|flac|ogg|opus|wav|srt|ass|ssa|vtt|sub|idx|jpg|jpeg|png|webp|gif|nfo|iso|zip|rar|7z|pdf|epub|db|sqlite)\b/gi;
const EMAIL_PATTERN = /[^\s@<>()[\]"']+@[^\s@<>()[\]"']+\.[A-Za-z]{2,}/g;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_PATTERN = /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_ID_PATTERN = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi;
const LONG_NUMBER_PATTERN = /\b\d{4,}\b/g;

// What a word of an error message may look like and still be kept (REL-LOG-06). Anything else could be part of an
// unquoted title ("Cannot open Blade Runner 2049 (2017) 2160p"), so it goes.
const PLACEHOLDER_WORD = /^<[a-z]+>$/;
const SHORT_NUMBER_WORD = /^\d{1,3}$/;
// Lowercase words and identifiers: "properties", "undefined", "process.env", "is_ready".
const LOWERCASE_WORD = /^[\p{Ll}_$][\p{Ll}_$.-]*$/u;
// Error codes: ENOENT, SQLITE_BUSY, HTTP, JSON.
const CODE_WORD = /^[A-Z][A-Z_]+$/;
// Code identifiers with a capital inside: TypeError, readFile, LibraryVersionDowngradeError, foo.barBaz.
const IDENTIFIER_WORD = /^[A-Za-z_$][A-Za-z_$.]*[a-z][A-Z][A-Za-z_$.]*$/;
/**
 * Capitalised words kept when they open a clause (the message's first word, or the first after `:` `.` `!` `?`):
 * how error messages start. Anywhere else a capitalised word goes, as titles are capitalised.
 */
const CLAUSE_STARTS: Record<string, true> = Object.fromEntries(
  [
    "A", "An", "The", "This", "No", "Not", "Cannot", "Could", "Can", "Did", "Does", "Do", "Is", "Was", "Has", "Must", "Should",
    "Failed", "Failure", "Unable", "Unexpected", "Unknown", "Invalid", "Missing", "Expected", "Required", "Unsupported",
    "Error", "Exception", "Uncaught", "Unhandled", "Network", "Request", "Response", "Timeout", "Timed", "Permission",
    "Access", "Maximum", "Out", "Object", "Attempted", "Load", "Invariant", "Value", "Native", "Module", "Internal",
    "Aborted", "Too", "Connection", "Server", "Database", "Storage", "Operation", "Already", "Only", "Rejected", "Refused",
    "Bad", "Empty", "Reading", "Writing", "Stream", "Socket", "Render", "Rendered", "Encountered", "Status", "Quota",
    "Memory", "Version", "Sync", "Key",
  ].map((word) => [word, true])
);
const CLAUSE_END = /[:.!?]$/;

/** Replaces every word whose shape is not allowed with `<redacted>`, a run of them with one. */
function redactUnknownWords(text: string): string {
  let clauseStart = true;
  const out = text.split(/(\s+)/).map((part) => {
    if (!part || /^\s+$/.test(part)) {
      if (part.includes("\n")) clauseStart = true;
      return part;
    }
    const [, lead = "", core = "", trail = ""] = /^([([{]*)(.*?)([)\]},;:.!?]*)$/s.exec(part) ?? [];
    const keep =
      core === "" ||
      PLACEHOLDER_WORD.test(core) ||
      SHORT_NUMBER_WORD.test(core) ||
      LOWERCASE_WORD.test(core) ||
      CODE_WORD.test(core) ||
      IDENTIFIER_WORD.test(core) ||
      (clauseStart && Object.hasOwn(CLAUSE_STARTS, core));
    clauseStart = CLAUSE_END.test(trail);
    return keep ? part : `${lead}<redacted>${trail}`;
  });
  return out.join("").replace(/<redacted>(?:\s+<redacted>)+/g, "<redacted>");
}

/**
 * Removes everything from a string that could name a file, a place, an address or an account, by pattern.
 * Quoted text goes as a whole: a title in an error ("Cannot play 'Blade Runner'") cannot be told apart from an
 * identifier by pattern, and the stack already says where the error happened.
 */
const replacePatterns = (text: string): string =>
  text
    .replace(URL_PATTERN, "<url>")
    .replace(QUOTED_PATTERN, "<redacted>")
    .replace(WINDOWS_PATH_PATTERN, "<path>")
    .replace(POSIX_PATH_PATTERN, (_all, lead: string) => `${lead}<path>`)
    .replace(RELATIVE_PATH_PATTERN, "<path>")
    .replace(FILE_NAME_PATTERN, "<file>")
    .replace(EMAIL_PATTERN, "<email>")
    .replace(UUID_PATTERN, "<id>")
    .replace(IPV6_PATTERN, "<ip>")
    .replace(IPV4_PATTERN, "<ip>")
    .replace(HEX_ID_PATTERN, "<id>")
    .replace(LONG_NUMBER_PATTERN, "<n>");

const capLength = (text: string): string =>
  text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}...` : text;

/** A code string (a function or class name, a release): the patterns only, as code is not English. */
const scrubCode = (text: string): string => capLength(replacePatterns(text));

/**
 * Removes everything from free text (an error message, a log line) that could name a file, a title, a place, an
 * address or an account. After the patterns, an unquoted title cannot be found by pattern, so only words shaped
 * like error text are kept: lowercase words, error codes, code identifiers, short numbers and the fixed words an
 * error message starts a clause with.
 */
export function scrubText(text: string): string {
  return capLength(redactUnknownWords(replacePatterns(text)));
}

/**
 * Reduces a script location to `app:///<bundle file name>`. A bundle name
 * (`index-3f9a.js`) says where the code lives; the folders before it hold the
 * user's name and install location. Source-map matching works on the debug id,
 * and `debug_meta` goes through this same function, so both stay in step.
 */
export function normalizeScriptPath(location: string): string {
  const withoutQuery = location.split(/[?#]/, 1)[0] ?? "";
  const last = withoutQuery.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const name = last.replace(/[^\w.@+-]/g, "_");
  return name ? `app:///${name}` : "app:///unknown";
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const asNumber = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

function pick(source: unknown, keys: readonly string[], map: (key: string, value: unknown) => unknown = (_k, v) => v): Json | undefined {
  if (!isRecord(source)) return undefined;
  const out: Json = {};
  for (const key of keys) {
    const value = map(key, source[key]);
    if (value !== undefined && value !== null) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function scrubFrame(frame: unknown): Json | undefined {
  if (!isRecord(frame)) return undefined;
  const out: Json = {};
  const fn = asString(frame.function);
  if (fn) out.function = scrubCode(fn).slice(0, 120);
  const filename = asString(frame.filename) ?? asString(frame.abs_path);
  if (filename) {
    out.filename = normalizeScriptPath(filename);
    out.abs_path = out.filename;
  }
  const lineno = asNumber(frame.lineno);
  if (lineno !== undefined) out.lineno = lineno;
  const colno = asNumber(frame.colno);
  if (colno !== undefined) out.colno = colno;
  if (typeof frame.in_app === "boolean") out.in_app = frame.in_app;
  const debugId = asString(frame.debug_id);
  if (debugId) out.debug_id = debugId;
  // `vars`, `pre_context`, `context_line`, `post_context` and `module` are left out on purpose.
  return out;
}

function scrubException(exception: unknown): Json | undefined {
  if (!isRecord(exception)) return undefined;
  const out: Json = {};
  const type = asString(exception.type);
  if (type) out.type = scrubCode(type).slice(0, 80);
  const value = asString(exception.value);
  if (value) out.value = scrubText(value);
  const mechanism = pick(exception.mechanism, ["type", "handled"]);
  if (mechanism) out.mechanism = mechanism;
  if (isRecord(exception.stacktrace) && Array.isArray(exception.stacktrace.frames)) {
    out.stacktrace = { frames: exception.stacktrace.frames.map(scrubFrame).filter((f): f is Json => f !== undefined) };
  }
  return out;
}

function scrubDebugMeta(debugMeta: unknown): Json | undefined {
  if (!isRecord(debugMeta) || !Array.isArray(debugMeta.images)) return undefined;
  const images = debugMeta.images
    .map((image) => {
      if (!isRecord(image)) return undefined;
      const out: Json = {};
      const type = asString(image.type);
      const debugId = asString(image.debug_id);
      const codeFile = asString(image.code_file);
      if (!type || !debugId || !codeFile) return undefined;
      out.type = type;
      out.debug_id = debugId;
      out.code_file = normalizeScriptPath(codeFile);
      return out;
    })
    .filter((image): image is Json => image !== undefined);
  return images.length > 0 ? { images } : undefined;
}

function scrubContexts(contexts: unknown): Json | undefined {
  if (!isRecord(contexts)) return undefined;
  const out: Json = {};
  const os = pick(contexts.os, ["name", "version"]);
  if (os) out.os = os;
  const runtime = pick(contexts.runtime, ["name", "version"]);
  if (runtime) out.runtime = runtime;
  const app = pick(contexts.app, ["app_version", "app_build"]);
  if (app) out.app = app;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The only tags a report keeps: which app, which platform, which kind of crash guard. Values are short fixed words. */
const REPORT_TAG_KEYS = ["app", "platform", "guard"] as const;
const REPORT_TAG_VALUE = /^[a-z][a-z0-9-]{0,31}$/;

function scrubTags(tags: unknown): Json | undefined {
  if (!isRecord(tags)) return undefined;
  const out: Json = {};
  for (const key of REPORT_TAG_KEYS) {
    const value = asString(tags[key]);
    if (value && REPORT_TAG_VALUE.test(value)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Turns an SDK error event into the report we are willing to send, or `null`
 * when there is nothing to send. Used as `beforeSend` in every SpaceFleet app.
 */
export function scrubErrorEvent<T extends object>(event: T): T | null {
  const source = event as Json;
  const out: Json = {};
  for (const key of ["event_id", "platform", "level", "release", "dist", "environment"] as const) {
    const value = asString(source[key]);
    if (value) out[key] = key === "release" || key === "dist" || key === "environment" ? scrubCode(value) : value;
  }
  const timestamp = asNumber(source.timestamp);
  if (timestamp !== undefined) out.timestamp = timestamp;
  const sdk = pick(source.sdk, ["name", "version"]);
  if (sdk) out.sdk = sdk;

  const exceptionValues = isRecord(source.exception) && Array.isArray(source.exception.values) ? source.exception.values : undefined;
  if (exceptionValues) {
    const values = exceptionValues.map(scrubException).filter((v): v is Json => v !== undefined);
    if (values.length > 0) out.exception = { values };
  }
  const message = asString(source.message) ?? (isRecord(source.logentry) ? asString(source.logentry.message) : undefined);
  if (message) out.message = scrubText(message);

  const debugMeta = scrubDebugMeta(source.debug_meta);
  if (debugMeta) out.debug_meta = debugMeta;
  const contexts = scrubContexts(source.contexts);
  if (contexts) out.contexts = contexts;
  const tags = scrubTags(source.tags);
  if (tags) out.tags = tags;

  if (!out.exception && !out.message) return null;
  return out as T;
}
