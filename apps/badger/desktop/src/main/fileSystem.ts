import { ipcMain, dialog } from "electron";
import { readdirSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, extname, basename, dirname } from "node:path";
import { mainUiStrings } from "./uiStrings";
import { SUBTITLE_EXTENSIONS, VIDEO_EXTENSIONS } from "../shared/importableMedia";
import { SUBTITLE_FILE_EXTENSIONS } from "@space/shared/subtitleFetch";

// Far above any real .srt/.ass/.vtt; a bigger file is read as empty, i.e. "not a subtitle we can read".
const MAX_ADDED_SUBTITLE_BYTES = 20 * 1024 * 1024;

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

let lastExportDirectory: string | undefined;
const pickedExportFolders = new Set<string>();

/** True for a folder the user picked in the export folder dialog this session. */
export const isPickedExportFolder = (dir: unknown): dir is string =>
  typeof dir === "string" && pickedExportFolders.has(dir);

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

  // "Add a subtitle file…" in the mpv player (PLAY-SUBGET-23): one .srt/.ass/.ssa/.vtt, its text and name; null when
  // cancelled. No parent window: the app's window hides while mpv plays, so the dialog opens as its own top-level
  // window, focused above the player.
  ipc.handle("sf-pick-subtitle-file", async () => {
    const result = await dialog.showOpenDialog({
      ...(lastDialogDirectory ? { defaultPath: lastDialogDirectory } : {}),
      properties: ["openFile"],
      filters: [{ name: mainUiStrings().filterSubtitles, extensions: [...SUBTITLE_FILE_EXTENSIONS] }],
    });
    const [path] = result.filePaths;
    if (result.canceled || !path) return null;
    lastDialogDirectory = dirname(path);
    const content = (await stat(path)).size > MAX_ADDED_SUBTITLE_BYTES ? "" : await readFile(path, "utf8");
    return { name: basename(path), content };
  });

  // "Download everything" (ACCT-EXPORT-01, OFFL-FILE-01): the folder the plain files go to; null
  // when cancelled. Only a folder picked here this session is accepted by the export IPCs (`isPickedExportFolder`),
  // so the renderer cannot make the runtime write anywhere else.
  ipc.handle("sf-pick-export-folder", async () => {
    const result = await dialog.showOpenDialog({
      ...(lastExportDirectory ? { defaultPath: lastExportDirectory } : {}),
      title: mainUiStrings().exportFolderTitle,
      buttonLabel: mainUiStrings().exportFolderButton,
      properties: ["openDirectory", "createDirectory"],
    });
    const [path] = result.filePaths;
    if (result.canceled || !path) return null;
    lastExportDirectory = path;
    pickedExportFolders.add(path);
    return path;
  });
};
