/**
 * Parsers for the availability listings the built binaries print. They prove what a bundle can do without a GPU
 * (CI has none): a hwdec or GPU context missing from these lists can never be picked at runtime.
 */

/** First token of every indented line: the entry names of an mpv help listing. */
const indentedNames = (text: string): Set<string> => {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s+(\S+)/.exec(line);
    if (match) names.add(match[1]!);
  }
  return names;
};

/** `mpv --hwdec=help`: the method names (`nvdec`, `vaapi-copy`, `auto-safe`, ...), without the per-codec full names. */
export const parseMpvHwdecHelp = (text: string): Set<string> => indentedNames(text);

/** An mpv object list (`--vo=help`, `--gpu-context=help`, `--ao=help`): the entry names under "Available ...:". */
export const parseMpvObjectHelp = (text: string): Set<string> => indentedNames(text);

/** `ffmpeg -hide_banner -hwaccels`: the device types listed after "Hardware acceleration methods:". */
export const parseFfmpegHwaccels = (text: string): Set<string> => {
  const methods = new Set<string>();
  let inList = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "Hardware acceleration methods:") {
      inList = true;
      continue;
    }
    if (inList && trimmed) methods.add(trimmed);
  }
  return methods;
};

/** The entries of `wanted` absent from `have`, in `wanted` order. */
export const missingEntries = (wanted: readonly string[], have: Set<string>): string[] => wanted.filter((entry) => !have.has(entry));
