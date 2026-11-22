import { scrubText } from "@space/error-report/scrub";

/**
 * A warning or error the window printed, as the line `parrot-main.log` keeps. The text comes from the renderer and
 * the libraries running there (a failed fetch prints its URL, a player error the song's file), so it goes through the
 * REL-LOG-06 scrubber before it is written, as the error log scrubs it (UX-SUP-05). Other levels are not kept.
 */
export function rendererConsoleLine(level: string, message: string): string | null {
  if (level !== "error" && level !== "warning") return null;
  return `[renderer:${level}] ${scrubText(message)}`;
}
