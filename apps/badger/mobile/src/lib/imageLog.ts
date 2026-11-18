import type { ImageErrorEvent } from "react-native";
import { scopeLogger } from "@space/mobile-shell/logger";

const log = scopeLogger("image");

/**
 * `onError` for a phone or TV picture: logs where it failed and the native reason (never the path or URL), so a blank
 * card can be told apart from a picture that was never fetched (`metadata image.failed`). `where` names the surface,
 * e.g. `tv.card.poster`, `phone.card.poster`.
 */
export const logImageError = (where: string) => (event: ImageErrorEvent) => {
  const reason = String(event.nativeEvent?.error ?? "unknown").replace(/[a-z]+:\/\/\S+|\/\S+/gi, "<path>");
  log.warn("render.failed", { where, error: reason.slice(0, 160) });
};
