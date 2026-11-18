/**
 * Text subtitles as WebVTT, the one format browsers and cast devices read (REL-FAM-02: one converter for every app).
 * - `subtitleToVtt`: a stored text subtitle (SRT from ingest, VTT, or an ASS / SSA file the user added, INGS-SUBS-01)
 *   as WebVTT, or null for a format no player can show this way. Used by the web player (PLAT-WEB-02).
 * - `strictWebVtt`: that WebVTT cleaned up for a cast device, whose parser is stricter than a browser's or mpv's
 *   (UX-TV-03): bad cues dropped, only `<b> <i> <u>` kept, times rewritten, optionally the HLS `X-TIMESTAMP-MAP`.
 * Image subtitles (PGS, VobSub) are never converted here.
 *
 * Pure: strings in, strings out.
 */

/** Ingest stores every text subtitle as SRT; browsers only render WebVTT. SRT → VTT: header + `,` → `.` in cue times. */
export const srtToVtt = (srt: string) =>
  `WEBVTT\n\n${srt
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")}`;

/** ASS / SSA time `h:mm:ss.cc` → VTT `hh:mm:ss.mmm`. */
const assTime = (value: string) => {
  const [h = "0", m = "0", s = "0.0"] = value.trim().split(":");
  const [whole = "0", cents = "0"] = s.split(".");
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}:${whole.padStart(2, "0")}.${cents.padEnd(3, "0").slice(0, 3)}`;
};

/**
 * ASS / SSA (a subtitle the user added, INGS-SUBS-01) → VTT: each `Dialogue:` line of `[Events]`, fields located by the
 * `Format:` line, styling tags (`{\i1}`…) dropped, `\N` / `\n` as line breaks. A browser draws no ASS styling.
 */
export const assToVtt = (ass: string) => {
  const lines = ass.replace(/^\uFEFF/, "").split(/\r\n?|\n/);
  let fields = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
  const cues: string[] = [];
  for (const line of lines) {
    const format = /^Format:\s*(.*)$/i.exec(line);
    if (format && /text/i.test(format[1]!)) fields = format[1]!.split(",").map((field) => field.trim().toLowerCase());
    const dialogue = /^Dialogue:\s*(.*)$/i.exec(line);
    if (!dialogue) continue;
    const parts = dialogue[1]!.split(",");
    // The text is the last field and may hold commas.
    const values = [...parts.slice(0, fields.length - 1), parts.slice(fields.length - 1).join(",")];
    const at = (name: string) => values[fields.indexOf(name)] ?? "";
    const text = at("text").replace(/\{[^}]*\}/g, "").replace(/\\[Nn]/g, "\n").replace(/\\h/g, " ").trim();
    if (text) cues.push(`${assTime(at("start"))} --> ${assTime(at("end"))}\n${text}`);
  }
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
};

/** The text formats that turn into WebVTT. `sub` / `txt` (MicroDVD and the like) do not. */
const TO_VTT: Record<string, (text: string) => string> = {
  srt: srtToVtt,
  vtt: (text) => text.replace(/^\uFEFF/, ""),
  ass: assToVtt,
  ssa: assToVtt,
};

/** True when a stored subtitle of this format can be shown as WebVTT. */
export const isVttConvertible = (format: string | null | undefined): boolean => !!format && format in TO_VTT;

/** A stored text subtitle as WebVTT, or null when its format does not turn into WebVTT. */
export const subtitleToVtt = (text: string, format: string | null) => {
  const convert = format ? TO_VTT[format] : undefined;
  return convert ? convert(text) : null;
};

export type StrictWebVttOptions = {
  /** Add `X-TIMESTAMP-MAP` (HLS requires it in WebVTT segments, Apple HLS authoring rule 5.3); LOCAL 0 = MPEGTS 0. */
  hlsTimestampMap?: boolean;
};

type Cue = { start: number; end: number; settings: string; text: string };

// `,` too: an SRT time that reached here unconverted still reads.
const TIME = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/;

/** Seconds of `HH:MM:SS.mmm` / `MM:SS.mmm`, or null. `.5` is 500 ms: the fraction is a decimal one. */
const parseTime = (raw: string): number | null => {
  const match = TIME.exec(raw.trim());
  if (!match) return null;
  const hours = match[1] ? parseInt(match[1], 10) : 0;
  const fraction = match[4] ? parseInt(match[4].padEnd(3, "0"), 10) : 0;
  return hours * 3600 + parseInt(match[2]!, 10) * 60 + parseInt(match[3]!, 10) + fraction / 1000;
};

const pad = (value: number, width: number): string => String(value).padStart(width, "0");

export const formatVttTime = (seconds: number): string => {
  const totalMs = Math.round(Math.max(0, seconds) * 1000);
  const ms = totalMs % 1000;
  const total = (totalMs - ms) / 1000;
  return `${pad(Math.floor(total / 3600), 2)}:${pad(Math.floor((total % 3600) / 60), 2)}:${pad(total % 60, 2)}.${pad(ms, 3)}`;
};

/** WebVTT text allows `<b> <i> <u>` (plus `<c> <v> <lang> <ruby> <rt>`): keep those three, drop other markup, escape the rest. */
const cleanText = (raw: string): string => {
  const withBreaks = raw.replace(/<br\s*\/?>/gi, "\n").replace(/\{\\[^}]*\}/g, "");
  const kept = withBreaks.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)(?:[\s.][^>]*)?>/g, (_tag, slash: string, name: string) => {
    const lower = name.toLowerCase();
    return lower === "b" || lower === "i" || lower === "u" ? `<${slash}${lower}>` : "";
  });
  return kept
    .replace(/&(?!(?:amp|lt|gt|lrm|rlm|nbsp);)/g, "&amp;")
    // A `<` that does not open one of the three tags above is text.
    .replace(/<(?!\/?[biu]>)/g, "&lt;")
    .replace(/-->/g, "--&gt;")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
};

const KNOWN_SETTING = /^(?:vertical|line|position|size|align|region)(?::|$)/;

const cleanSettings = (raw: string): string =>
  raw
    .split(/\s+/)
    .filter((part) => KNOWN_SETTING.test(part))
    .join(" ");

/** WebVTT: blocks separated by blank lines, `start --> end [settings]`, then text; a cue may have an identifier line before the timing. */
const parseBlocks = (text: string): Cue[] => {
  const cues: Cue[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split("\n");
    const timingAt = lines.findIndex((line) => line.includes("-->"));
    if (timingAt < 0) continue;
    // NOTE / STYLE / REGION blocks carry no cue.
    if (/^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0] ?? "")) continue;
    const match = /^\s*(\S+)\s*-->\s*(\S+)(.*)$/.exec(lines[timingAt]!);
    if (!match) continue;
    const start = parseTime(match[1]!);
    const end = parseTime(match[2]!);
    if (start == null || end == null || end <= start) continue;
    const body = cleanText(lines.slice(timingAt + 1).join("\n"));
    if (!body) continue;
    cues.push({ start, end, settings: cleanSettings(match[3]!), text: body });
  }
  return cues;
};

/** WebVTT (or SRT) cleaned up for a strict device parser; a file with no valid cue gives a valid empty WebVTT. */
export const strictWebVtt = (input: string, options: StrictWebVttOptions = {}): string => {
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const cues = parseBlocks(text);
  const header = ["WEBVTT"];
  if (options.hlsTimestampMap) header.push("X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000");
  const body = cues.map((cue) => {
    const timing = `${formatVttTime(cue.start)} --> ${formatVttTime(cue.end)}${cue.settings ? ` ${cue.settings}` : ""}`;
    return `${timing}\n${cue.text}`;
  });
  return `${[header.join("\n"), ...body].join("\n\n")}\n`;
};
