import type { IpcMain } from "electron";
import type { FfmpegRuntimeBridge } from "./ffmpegRuntimeBridge";
import { getFfmpegCapabilities, runFfmpegCapabilityTest } from "./ffmpegCapabilities";

export const registerFfmpegIpc = (
  ipcMain: IpcMain,
  deps: {
    runtimeBridge: FfmpegRuntimeBridge;
  }
) => {
  ipcMain.handle("sf-ffmpeg-capabilities", async () => {
    const runtime = await deps.runtimeBridge.getCapabilities();
    if (runtime) return runtime;
    return getFfmpegCapabilities();
  });
  ipcMain.handle("sf-ffmpeg-capabilities-test", async (_event, encoder: "nvenc" | "qsv" | "vaapi" | "amf" | "videotoolbox" | "cpu" | undefined) => {
    const runtime = await deps.runtimeBridge.runCapabilityTest(encoder);
    if (runtime) return runtime;
    return runFfmpegCapabilityTest(encoder);
  });
};

