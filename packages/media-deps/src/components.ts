/**
 * Checks that every component the build enabled really ended up in the built binary.
 * `./configure` silently ignores `--enable-<kind>=<unknown>` (e.g. a codec name such as
 * `hdmv_pgs_subtitle` instead of the decoder name `pgssub`), so a typo ships a binary that
 * lacks the component and only fails at the first job that needs it.
 *
 * Parsers have no listing flag in the ffmpeg CLI, so they cannot be verified here.
 */
export type ListedComponentKind = "decoder" | "demuxer" | "encoder" | "muxer" | "bsf" | "filter" | "protocol";

/** The ffmpeg CLI flag that lists the built components of each kind. */
export const COMPONENT_LIST_ARGS: Record<ListedComponentKind, string> = {
  decoder: "-decoders",
  demuxer: "-demuxers",
  encoder: "-encoders",
  muxer: "-muxers",
  bsf: "-bsfs",
  filter: "-filters",
  protocol: "-protocols",
};

export const LISTED_COMPONENT_KINDS = Object.keys(COMPONENT_LIST_ARGS) as ListedComponentKind[];

// Component names ignore underscores: configure's `movtext` is listed by ffmpeg as `mov_text`.
const componentKey = (name: string) => name.replaceAll("_", "");

/** configure names that ffmpeg lists under another name (`--enable-demuxer=mpegps` is listed as `mpeg`). */
const LISTED_ALIASES: Record<string, string> = { "demuxer:mpegps": "mpeg" };

/**
 * `image_*_pipe` demuxers are never printed by `-demuxers`; their presence is proven by the name
 * string inside libavformat (see verify.ts).
 */
export const isUnlistedDemuxer = (name: string) => /^image_[a-z0-9]+_pipe$/.test(name);

/**
 * Parse the stdout of `ffmpeg -hide_banner <list flag>` into the set of built component keys.
 * Codec and format listings are `<FLAGS>[d] <name[,alias…]> <description>` rows, where a
 * trailing or spaced lowercase `d` marks a device (`  Ed alsa`, ` D d lavfi`); `-filters` rows
 * are `<TSC> <name> <in>-><out> <description>`; `-bsfs` and `-protocols` are one bare name
 * per line under header lines (`Bitstream filters:`, `Input:`).
 */
export const parseComponentListing = (kind: ListedComponentKind, stdout: string): Set<string> => {
  const built = new Set<string>();
  for (const line of stdout.split("\n")) {
    if (kind === "bsf" || kind === "protocol") {
      const name = line.trim();
      if (/^[a-z0-9_]+$/.test(name)) built.add(componentKey(name));
      continue;
    }
    const names =
      kind === "filter"
        ? /^\s*[A-Z.]{2,3}\s+(\S+)\s+\S+->\S+/.exec(line)?.[1]
        : /^\s*[A-Z.]+(?:\s+d|d)?\s+(\S+)/.exec(line)?.[1];
    if (!names) continue;
    for (const name of names.split(",")) built.add(componentKey(name));
    // Some codecs are listed under their decoder name with the codec noted: `msmpeg4 … (codec msmpeg4v3)`.
    const codec = /\(codec (\S+)\)/.exec(line)?.[1];
    if (codec) built.add(componentKey(codec));
  }
  return built;
};

/** `--enable-indev=` devices (lavfi) show up in the demuxer listing. */
const listingKind = (flagKind: string): ListedComponentKind | null => {
  if (flagKind === "indev") return "demuxer";
  return (LISTED_COMPONENT_KINDS as string[]).includes(flagKind) ? (flagKind as ListedComponentKind) : null;
};

/**
 * Return every `--enable-<kind>=<name>` flag of `flags` whose component is absent from the
 * matching listing. A kind with no listing is reported in full, so a caller that forgets to
 * collect one cannot pass silently. Flags of kinds ffmpeg cannot list (parser, hwaccel,
 * external libraries) are skipped.
 */
export const findMissingComponents = (
  flags: readonly string[],
  listings: Partial<Record<ListedComponentKind, string>>
): string[] => {
  const parsed = new Map<ListedComponentKind, Set<string>>();
  const missing: string[] = [];
  for (const flag of flags) {
    const match = /^--enable-([a-z]+)=(.+)$/.exec(flag);
    const kind = match ? listingKind(match[1]!) : null;
    if (!match || !kind) continue;
    if (kind === "demuxer" && isUnlistedDemuxer(match[2]!)) continue;
    if (!parsed.has(kind)) {
      const listing = listings[kind];
      parsed.set(kind, listing === undefined ? new Set<string>() : parseComponentListing(kind, listing));
    }
    const listed = LISTED_ALIASES[`${kind}:${match[2]}`] ?? match[2]!;
    if (!parsed.get(kind)!.has(componentKey(listed))) missing.push(flag);
  }
  return missing;
};
