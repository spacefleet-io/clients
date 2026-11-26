/**
 * How a screen reader announces a new notice: errors interrupt (`assertive`), everything else waits its turn
 * (`polite`). The value is the same word for the web's `aria-live` and React Native's `accessibilityLiveRegion`.
 */
import type { NoticeLevel } from "./kinds";

export type LiveRegion = "polite" | "assertive";

export const liveRegionFor = (level: NoticeLevel): LiveRegion => (level === "error" ? "assertive" : "polite");

/** The web role that goes with it: `alert` for an error, `status` otherwise. */
export const liveRoleFor = (level: NoticeLevel): "alert" | "status" => (level === "error" ? "alert" : "status");
