import i18n from "i18next";

export const formatUploadSpeedLabel = (
  t: (key: string, options?: Record<string, unknown>) => string,
  speedMibPerSec?: number,
  key = "lab.queue.uploadSpeed"
) => {
  if (!Number.isFinite(speedMibPerSec) || Number(speedMibPerSec) <= 0) return null;
  const speed = Number(speedMibPerSec);
  const rounded = speed >= 10 ? Math.round(speed) : Math.round(speed * 10) / 10;
  // The decimal follows the UI language ("2,5" in French, Dutch and German; UX-I18N-01).
  return t(key, { speed: rounded.toLocaleString(i18n.language || "en") });
};
