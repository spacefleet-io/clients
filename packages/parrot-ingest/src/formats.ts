import { promises as fs } from "node:fs";
import path from "node:path";
import { isParrotAudioFile } from "./audioFormats";

export * from "./audioFormats";

/**
 * Every file `accept` takes under the given files and folders, sorted, each once. Hidden files and folders (dot names)
 * are skipped; a folder that cannot be read is reported through `onSkip` and the walk goes on. Each real folder is
 * walked once, so a symlink back to an ancestor (or a second link to the same folder) cannot loop or repeat it.
 */
export const findParrotFiles = async (
  roots: string[],
  accept: (file: string) => boolean,
  onSkip: (entry: string, reason: string) => void = () => {}
): Promise<string[]> => {
  const found = new Set<string>();
  const walkedFolders = new Set<string>();
  const visit = async (entry: string): Promise<void> => {
    let stat;
    try {
      stat = await fs.stat(entry);
    } catch (error) {
      onSkip(entry, error instanceof Error ? error.message : String(error));
      return;
    }
    if (stat.isFile()) {
      if (accept(entry)) found.add(path.resolve(entry));
      return;
    }
    if (!stat.isDirectory()) return;
    let names: string[];
    try {
      const realFolder = await fs.realpath(entry);
      if (walkedFolders.has(realFolder)) return;
      walkedFolders.add(realFolder);
      names = await fs.readdir(entry);
    } catch (error) {
      onSkip(entry, error instanceof Error ? error.message : String(error));
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      await visit(path.join(entry, name));
    }
  };
  for (const root of roots) await visit(root);
  return [...found].sort();
};
