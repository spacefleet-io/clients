// PAR-FMT-02: the desktop makes each song's light copy in a hidden window of its own (its own renderer process, so
// the app's window never waits on it), with Chromium's WebCodecs Opus encoder. One song at a time; the window starts
// with the first song and closes after a minute with nothing to do.
import { BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import type { ParrotLightCopyMaker } from "@space/parrot-ingest";
import { LIGHT_COPY_IPC, LIGHT_COPY_MAX_READ_BYTES, type LightCopyJob, type LightCopyResult } from "../shared/lightCopy";

const IDLE_CLOSE_MS = 60_000;

export type DesktopLightCopyEncoder = { make: ParrotLightCopyMaker; close: () => void };

export const createDesktopLightCopyEncoder = (input: {
  mainOutDir: string;
  appVersion: string;
  log: (message: string) => void;
}): DesktopLightCopyEncoder => {
  let window: BrowserWindow | null = null;
  let ready: Promise<BrowserWindow> | null = null;
  let nextId = 1;
  let queue: Promise<unknown> = Promise.resolve();
  let idle: NodeJS.Timeout | null = null;
  const pending = new Map<number, (result: LightCopyResult) => void>();
  // The original of each job in the window, read a piece at a time (never sent whole).
  const readers = new Map<number, { size: number; read: (start: number, end: number) => Promise<Uint8Array> }>();

  ipcMain.on(LIGHT_COPY_IPC.done, (event, result: LightCopyResult) => {
    if (event.sender !== window?.webContents) return;
    pending.get(result.id)?.(result);
    pending.delete(result.id);
  });
  ipcMain.handle(LIGHT_COPY_IPC.read, async (event, id: number, start: number, end: number) => {
    if (event.sender !== window?.webContents) throw new Error("not the encoder window");
    const reader = readers.get(id);
    if (!reader) throw new Error(`no light copy job ${id}`);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= reader.size || end + 1 - start > LIGHT_COPY_MAX_READ_BYTES)
      throw new Error(`bad read ${start}..${end} of a ${reader.size}-byte original`);
    return reader.read(start, end);
  });

  const close = () => {
    clearTimeout(idle ?? undefined);
    idle = null;
    const closing = window;
    window = null;
    ready = null;
    if (closing && !closing.isDestroyed()) closing.destroy();
    for (const [id, resolve] of pending) resolve({ id, ok: false, error: "the encoder window closed" });
    pending.clear();
  };

  const open = (): Promise<BrowserWindow> => {
    ready ??= new Promise<BrowserWindow>((resolve, reject) => {
      const created = new BrowserWindow({
        show: false,
        width: 320,
        height: 200,
        webPreferences: {
          preload: join(input.mainOutDir, "../preload/lightcopy.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          // Hidden for good: Chromium must not slow its timers down.
          backgroundThrottling: false,
        },
      });
      window = created;
      created.webContents.setAudioMuted(true);
      const onReady = (event: Electron.IpcMainEvent) => {
        if (event.sender !== created.webContents) return;
        ipcMain.off(LIGHT_COPY_IPC.ready, onReady);
        input.log("[light-copy] encoder window ready");
        resolve(created);
      };
      ipcMain.on(LIGHT_COPY_IPC.ready, onReady);
      created.webContents.on("render-process-gone", (_event, details) => {
        input.log(`[light-copy] encoder window gone: ${details.reason}`);
        ipcMain.off(LIGHT_COPY_IPC.ready, onReady);
        if (window === created) close();
        reject(new Error(`LIGHT_COPY_WINDOW_GONE: ${details.reason}`));
      });
      created.webContents.on("console-message", (details) => {
        if (details.level === "error" || details.level === "warning") input.log(`[light-copy:${details.level}] ${details.message}`);
      });
      const loaded = process.env.ELECTRON_RENDERER_URL
        ? created.loadURL(`${process.env.ELECTRON_RENDERER_URL}/lightcopy.html`)
        : created.loadFile(join(input.mainOutDir, "../renderer/lightcopy.html"));
      loaded.catch((error: unknown) => {
        ipcMain.off(LIGHT_COPY_IPC.ready, onReady);
        if (window === created) close();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
    return ready;
  };

  const encode = async (job: Parameters<ParrotLightCopyMaker>[0]): Promise<Uint8Array> => {
    clearTimeout(idle ?? undefined);
    idle = null;
    const target = await open();
    const id = nextId++;
    readers.set(id, job);
    try {
      const { read: _read, ...meta } = job;
      const result = await new Promise<LightCopyResult>((resolve) => {
        pending.set(id, resolve);
        target.webContents.send(LIGHT_COPY_IPC.job, { ...meta, id, appVersion: input.appVersion } satisfies LightCopyJob);
      });
      if (!result.ok) throw new Error(result.error);
      input.log(
        `[light-copy] ${job.size} bytes of ${job.codec} encoded to ${result.bytes.length} bytes of Opus in ${result.ms} ms` +
          (result.streamed ? " (streamed)" : "")
      );
      return new Uint8Array(result.bytes);
    } finally {
      readers.delete(id);
    }
  };

  const make: ParrotLightCopyMaker = (job) => {
    const run = queue.then(() => encode(job));
    queue = run.catch(() => {}).finally(() => {
      if (pending.size === 0 && window) idle = setTimeout(close, IDLE_CLOSE_MS);
    });
    return run;
  };

  return { make, close };
};
