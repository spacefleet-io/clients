// Preload of the hidden encoder window (PAR-FMT-02): only the job channel, nothing of the app's bridge.
import { contextBridge, ipcRenderer } from "electron";
import { LIGHT_COPY_IPC, type LightCopyBridge, type LightCopyJob } from "../shared/lightCopy";

const bridge: LightCopyBridge = {
  onJob: (listener) => {
    ipcRenderer.on(LIGHT_COPY_IPC.job, (_event, job: LightCopyJob) => listener(job));
  },
  read: (id, start, end) => ipcRenderer.invoke(LIGHT_COPY_IPC.read, id, start, end),
  done: (result) => ipcRenderer.send(LIGHT_COPY_IPC.done, result),
  ready: () => ipcRenderer.send(LIGHT_COPY_IPC.ready),
};

contextBridge.exposeInMainWorld("parrotLightCopy", bridge);
