import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BadgerContinueHero } from "@space/ui/badger";
import MediaImage from "@/components/MediaImage";
import { useLibraryActions } from "@/lib/libraryContext";
import type { MediaRow } from "@/lib/libraryDb";
import { getGenreName } from "@/lib/genres";
import { useMediaImage } from "@/lib/useMediaImage";
import { formatClock } from "@space/shared/format";
import { buildBadgerContinueHeroText } from "@space/ui/badger/continue-hero";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "dashboard-continue-hero" });

/**
 * UX-HOME-01: Home's "Continue watching" hero, the shared card with the title's runtime and time left (from its
 * longest version, fetched with the details when not cached), Resume and Details. No playlist or language button.
 */
export default function DashboardContinueHero({
  item,
  onResume,
  onDetails,
}: {
  item: MediaRow;
  onResume: (id: string) => void;
  onDetails: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { getMediaDetails, fetchMediaDetails } = useLibraryActions();
  const cached = getMediaDetails(item.id);
  const [details, setDetails] = useState(cached);
  const glowSrc = useMediaImage(item.posterPath);

  useEffect(() => {
    let cancelled = false;
    const hit = getMediaDetails(item.id);
    setDetails(hit);
    if (hit) return;
    fetchMediaDetails(item.id)
      .then((next) => {
        if (!cancelled) setDetails(next);
      })
      .catch((error: unknown) => log.warn({ mediaId: item.id, error: String(error) }, "continue-hero.details.failed"));
    return () => {
      cancelled = true;
    };
  }, [item.id, getMediaDetails, fetchMediaDetails]);

  // A film's runtime is its longest version; a show's progress is per show, so it has no single runtime.
  const runtimeSeconds =
    item.type === "movie"
      ? Math.max(0, ...(details?.formats ?? []).map((format) => format.durationSeconds ?? 0)) || null
      : null;
  const genreType = item.type === "tv" ? "tv" : "movie";
  const genreNames = (item.genres ?? [])
    .map((id) => getGenreName(genreType, id, i18n.language))
    .filter((name): name is string => Boolean(name));
  const { meta, resumeAtSeconds } = buildBadgerContinueHeroText(item, runtimeSeconds, genreNames, (count) =>
    t("dashboard.hero.minutesLeft", { count }),
  );

  return (
    <BadgerContinueHero
      eyebrow={t("dashboard.sections.continue")}
      title={item.title}
      meta={meta}
      progressPct={item.progressPct || 0}
      poster={<MediaImage path={item.posterPath} alt={item.title} className="h-full w-full object-cover" />}
      glowSrc={glowSrc}
      resumeLabel={
        resumeAtSeconds !== null
          ? t("dashboard.hero.resume", { time: formatClock(resumeAtSeconds) })
          : t("dashboard.hero.resumeShort")
      }
      detailsLabel={t("dashboard.hero.details")}
      onResume={() => onResume(item.id)}
      onDetails={() => onDetails(item.id)}
    />
  );
}
