/**
 * STOR-BW-07, STOR-BW-08, PLAY-QUAL-07: the desktop main side of a saturated silo.
 *
 * Saturation is per silo, so this state is fed only by the storage requests of the playback in progress, each carrying
 * the report of the silo that served it (`StorageDownloadHints.onTraffic`, or the traffic on a refusal / stop error). It
 * is never merged across silos and nothing here polls: a stopped viewer is not resumed, the user presses play again and
 * the silo either admits the playback or refuses it.
 */
import type { BrowserWindow, IpcMain } from "electron";
import type { StorageTraffic } from "@space/shared/storageTunnel";
import type { PlaybackSaturationState } from "../shared/playbackSaturation";

export type PlaybackSaturation = {
  getState: () => PlaybackSaturationState;
  /** The report of the silo serving the playback: session open or `session.ack`. */
  observe: (traffic: StorageTraffic) => void;
  /** The silo refused a new playback; its report says whether this viewer was stopped earlier. */
  noteRefused: (traffic: StorageTraffic | null) => void;
  /** The playback ended: the silo stopped this viewer, or the player found no rung under the cap. */
  noteStopped: (traffic: StorageTraffic | null) => void;
  /** A new playback source opened: the previous silo's cap no longer applies until the new silo reports. */
  reset: () => void;
};

export const createPlaybackSaturation = (onChange: (state: PlaybackSaturationState) => void): PlaybackSaturation => {
  let state: PlaybackSaturationState = { qualityCap: null, refusals: 0, stops: 0 };
  // True from a stop until a silo report says the viewer is not stopped, so the requests that fail together count once.
  let stopped = false;

  const set = (patch: Partial<PlaybackSaturationState>) => {
    const next = { ...state, ...patch };
    if (next.qualityCap === state.qualityCap && next.refusals === state.refusals && next.stops === state.stops) return;
    state = next;
    onChange(state);
  };

  const noteStop = () => {
    if (stopped) return;
    stopped = true;
    set({ stops: state.stops + 1 });
  };

  return {
    getState: () => state,
    observe: (traffic) => {
      set({ qualityCap: traffic.qualityCap });
      if (traffic.playbackStopped) noteStop();
      else stopped = false;
    },
    noteRefused: (traffic) => {
      if (traffic) stopped = traffic.playbackStopped;
      set({ qualityCap: traffic ? traffic.qualityCap : state.qualityCap, refusals: state.refusals + 1 });
    },
    noteStopped: (traffic) => {
      if (traffic) set({ qualityCap: traffic.qualityCap });
      noteStop();
    },
    reset: () => {
      stopped = false;
      set({ qualityCap: null });
    },
  };
};

/** `sf-playback-saturation-state` (read), `sf-playback-saturation` (push), `sf-playback-saturation-stop` (the player stopped itself). */
export const registerPlaybackSaturation = (ipcMain: IpcMain, getWindow: () => BrowserWindow | null): PlaybackSaturation => {
  const saturation = createPlaybackSaturation((state) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send("sf-playback-saturation", state);
  });
  ipcMain.handle("sf-playback-saturation-state", () => saturation.getState());
  ipcMain.handle("sf-playback-saturation-stop", () => saturation.noteStopped(null));
  return saturation;
};
