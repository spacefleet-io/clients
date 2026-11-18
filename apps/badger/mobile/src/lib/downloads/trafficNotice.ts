/**
 * What the Downloads screen says about the silo's traffic (STOR-BW-01, STOR-BW-09). The native engine reports one
 * `traffic` value in its state: `slowed` while the silo is high (transfers run at the reduced rate), `held` while it is
 * saturated (nothing transfers; the engine waits and resumes by itself). The notice only matters while a download is
 * actually waiting on the silo, so an idle list or a finished one shows none.
 */
import { isActiveStatus } from "./decisions";
import type { DownloadsState } from "@space/mobile-media-proxy/downloads";

export type TrafficNoticeKey = "downloads.trafficHeld" | "downloads.trafficSlowed";

export const trafficNoticeKey = (state: Pick<DownloadsState, "items" | "traffic">): TrafficNoticeKey | null => {
  if (state.traffic === "normal") return null;
  if (!state.items.some((item) => isActiveStatus(item.status))) return null;
  return state.traffic === "held" ? "downloads.trafficHeld" : "downloads.trafficSlowed";
};
