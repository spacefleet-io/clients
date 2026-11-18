import type { WebContents } from "electron";
import { scopeLogger } from "./logger";

// LIB-DETAIL-06 (#2296): once the user clicks inside an embedded page (the trailer's YouTube player), keyboard
// focus lives in that cross-origin frame and its key presses never reach the app's document, so the trailer
// dialog's own Escape handler never runs. `before-input-event` sees every key press of the window, whichever frame
// it goes to: main tells the renderer about each Escape, and the renderer closes the trailer when the key went into
// the embedded player. An Escape that leaves the player's HTML fullscreen is not forwarded: it only exits
// fullscreen.

export const ESCAPE_KEY_CHANNEL = "sf-escape-key";

const logger = scopeLogger("escape-key-forward");

export const forwardEscapeKey = (webContents: WebContents) => {
  let htmlFullScreen = false;
  webContents.on("enter-html-full-screen", () => {
    htmlFullScreen = true;
  });
  webContents.on("leave-html-full-screen", () => {
    htmlFullScreen = false;
  });
  webContents.on("before-input-event", (_event, input) => {
    if (input.type !== "keyDown" || input.key !== "Escape" || input.isAutoRepeat) return;
    const focusedFrameUrl = webContents.focusedFrame?.url ?? null;
    if (htmlFullScreen) {
      logger.info({ focusedFrameUrl }, "Escape leaves HTML fullscreen: not forwarded");
      return;
    }
    logger.info({ focusedFrameUrl }, "Escape forwarded to the renderer");
    webContents.send(ESCAPE_KEY_CHANNEL);
  });
};
