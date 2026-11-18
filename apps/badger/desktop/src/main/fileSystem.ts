import { ipcMain, dialog } from "electron";
import { readdirSync, statSync } from "node:fs";
import { join, extname, basename, dirname } from "node:path";
import { mainUiStrings } from "./uiStrings";
import { SUBTITLE_EXTENSIONS, VIDEO_EXTENSIONS } from "../shared/importableMedia";

type ScannedFile = {
  path: string;
  name: string;
  size: number;
  kind: "video" | "subtitle";
};

const scanDirectory = (dir: string): ScannedFile[] => {
  let results: ScannedFile[] = [];
  try {
    const list = readdirSync(dir);
    for (const file of list) {
      if (file.startsWith(".")) continue; // Skip hidden
      const fullPath = join(dir, file);
      try {
        const stats = statSync(fullPath);
        if (stats.isDirectory()) {
          results = results.concat(scanDirectory(fullPath));
        } else if (stats.isFile()) {
          const ext = extname(file).toLowerCase();
          if (VIDEO_EXTENSIONS.has(ext)) {
            results.push({
              path: fullPath,
              name: file,
              size: stats.size,
              kind: "video",
            });
          } else if (SUBTITLE_EXTENSIONS.has(ext)) {
            results.push({
              path: fullPath,
              name: file,
              size: stats.size,
              kind: "subtitle",
            });
          }
        }
      } catch {
        // Ignore unreadable
      }
    }
  } catch {
    // Ignore access denied
  }
  return results;
};

export const registerFileSystemIpc = (ipc: typeof ipcMain) => {
  ipc.handle("sf-fs-scan", async (_event, paths: string[]) => {
    const results: ScannedFile[] = [];
    for (const p of paths) {
      try {
        const stats = statSync(p);
        if (stats.isDirectory()) {
          results.push(...scanDirectory(p));
        } else if (stats.isFile()) {
          const ext = extname(p).toLowerCase();
          if (VIDEO_EXTENSIONS.has(ext)) {
            results.push({
              path: p,
              name: basename(p),
              size: stats.size,
              kind: "video",
            });
          } else if (SUBTITLE_EXTENSIONS.has(ext)) {
            results.push({
              path: p,
              name: basename(p),
              size: stats.size,
              kind: "subtitle",
            });
          }
        }
      } catch {
        // Ignore
      }
    }
    return results;
  });

  // Electron 43 defaults `defaultPath` to Downloads and the OS stops restoring
  // the last-used directory, so remember it ourselves.
  let lastDialogDirectory: string | undefined;
  ipc.handle("sf-fs-open-dialog", async (_event, options: { properties: any[] }) => {
    const result = await dialog.showOpenDialog({
      ...(lastDialogDirectory ? { defaultPath: lastDialogDirectory } : {}),
      properties: options.properties || ["openFile", "multiSelections"],
      filters: [
        {
          name: mainUiStrings().filterMedia,
          extensions: [
            ...Array.from(VIDEO_EXTENSIONS).map((e) => e.replace(".", "")),
            ...Array.from(SUBTITLE_EXTENSIONS).map((e) => e.replace(".", "")),
          ],
        },
        { name: mainUiStrings().filterVideos, extensions: Array.from(VIDEO_EXTENSIONS).map((e) => e.replace(".", "")) },
        { name: mainUiStrings().filterSubtitles, extensions: Array.from(SUBTITLE_EXTENSIONS).map((e) => e.replace(".", "")) },
      ],
    });
    if (result.canceled) return [];
    const [firstPath] = result.filePaths;
    if (firstPath) lastDialogDirectory = dirname(firstPath);
    return result.filePaths;
  });
};
