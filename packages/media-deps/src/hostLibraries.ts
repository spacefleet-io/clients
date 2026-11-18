/** A shell glob (`*`, `?`) as an anchored regex; every other character is literal (`libstdc++*`). */
const globRegex = (glob: string): RegExp =>
  new RegExp(
    `^${glob
      .split("")
      .map((char) => (char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
      .join("")}$`
  );

/**
 * The file names (input order) matching any host-library glob: libraries a bundle must leave to the host
 * (see `DepsTarget.hostLibraries`). The recipe's assemble step applies the same globs with shell `case`.
 */
export const findBundledHostLibraries = (names: readonly string[], patterns: readonly string[]): string[] => {
  const regexes = patterns.map(globRegex);
  return names.filter((name) => regexes.some((regex) => regex.test(name)));
};
