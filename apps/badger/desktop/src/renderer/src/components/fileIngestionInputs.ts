type CandidateLike = {
  id: string;
  name: string;
  kind: "video" | "subtitle";
  match?: {
    title?: string | null;
    type?: "movie" | "tv";
  } | null;
  parsed?: {
    title?: string | null;
    season?: number | null;
    episode?: number | null;
  } | null;
  subtitleDraft?: {
    language?: string | null;
    label?: string | null;
  } | null;
  probe?: {
    audioTracks: Array<{ index: number; language: string | null; label: string | null }>;
    subtitleTracks: Array<{ index: number; language: string | null; label: string | null }>;
  } | null;
};

export type FileIngestionUndefinedTrackRow = {
  id: string;
  candidateId: string;
  candidateName: string;
  kind: "audio" | "subtitle";
  index: number;
  language: string;
  label: string;
  keepUndefined: boolean;
  hint?: string;
};

export type FileIngestionUndefinedTrackDecision = {
  language: string;
  label: string;
  keepUndefined: boolean;
};

export const buildFileIngestionUndefinedTrackRows = <TCandidate extends CandidateLike>(
  ready: TCandidate[],
  params: {
    normalizeLanguageCode: (raw?: string | null) => string;
    normalizeTrackLabelForUi: (label: string | null | undefined, language: string | null | undefined) => string;
    trackNeedsLanguageReview: (track: { language?: string | null; label?: string | null }) => boolean;
  }
): FileIngestionUndefinedTrackRow[] => {
  const { normalizeLanguageCode, normalizeTrackLabelForUi, trackNeedsLanguageReview } = params;
  const rows: FileIngestionUndefinedTrackRow[] = [];

  ready.forEach((candidate) => {
    if (candidate.kind === "subtitle") {
      const language = normalizeLanguageCode(candidate.subtitleDraft?.language);
      if (!trackNeedsLanguageReview({ language, label: candidate.subtitleDraft?.label })) return;
      rows.push({
        id: `${candidate.id}:subtitle:0`,
        candidateId: candidate.id,
        candidateName: candidate.name,
        kind: "subtitle",
        index: 0,
        language,
        label: normalizeTrackLabelForUi(candidate.subtitleDraft?.label, language),
        keepUndefined: true,
      });
      return;
    }

    const probe = candidate.probe;
    if (!probe) return;
    probe.audioTracks.forEach((track) => {
      if (!trackNeedsLanguageReview(track)) return;
      rows.push({
        id: `${candidate.id}:audio:${track.index}`,
        candidateId: candidate.id,
        candidateName: candidate.name,
        kind: "audio",
        index: track.index,
        language: "und",
        label: normalizeTrackLabelForUi(track.label, track.language),
        keepUndefined: true,
      });
    });
    probe.subtitleTracks.forEach((track) => {
      if (!trackNeedsLanguageReview(track)) return;
      rows.push({
        id: `${candidate.id}:subtitle:${track.index}`,
        candidateId: candidate.id,
        candidateName: candidate.name,
        kind: "subtitle",
        index: track.index,
        language: "und",
        label: normalizeTrackLabelForUi(track.label, track.language),
        keepUndefined: true,
      });
    });
  });

  return rows;
};

export type FileIngestionTrackOverride = { index: number; language: string; label: string };

/**
 * Build the per-candidate audio + subtitle override Maps from the dialog's
 * `undefinedTrackDecisions` state. These Maps land on
 * `LabQueueFileInput.audioTrackOverrides` / `subtitleTrackOverrides`, which
 * the V2 translator forwards to the runtime as `audioOverrides` /
 * `subtitleOverrides`. Bug #4: this seam was correct, but the translator
 * dropped its output — keep the test for both halves green so any regression
 * is loud.
 *
 * Decisions where `keepUndefined` is true OR where the user's language pick
 * normalises back to "und" are ignored — the row stays as-is.
 */
export const buildFileIngestionTrackOverrideMaps = (params: {
  decisions: Record<string, FileIngestionUndefinedTrackDecision>;
  rows: FileIngestionUndefinedTrackRow[];
  normalizeLanguageCode: (raw?: string | null) => string;
  languageLabel: (code: string) => string;
}): {
  audioOverrideByCandidate: Map<string, FileIngestionTrackOverride[]>;
  subtitleOverrideByCandidate: Map<string, FileIngestionTrackOverride[]>;
} => {
  const { decisions, rows, normalizeLanguageCode, languageLabel } = params;
  const audioOverrideByCandidate = new Map<string, FileIngestionTrackOverride[]>();
  const subtitleOverrideByCandidate = new Map<string, FileIngestionTrackOverride[]>();
  Object.entries(decisions).forEach(([rowId, decision]) => {
    if (decision.keepUndefined) return;
    const row = rows.find((entry) => entry.id === rowId);
    if (!row) return;
    const language = normalizeLanguageCode(decision.language);
    if (language === "und") return;
    const label = decision.label.trim() || languageLabel(language);
    const target =
      row.kind === "audio" ? audioOverrideByCandidate : subtitleOverrideByCandidate;
    const list = target.get(row.candidateId) ?? [];
    list.push({ index: row.index, language, label });
    target.set(row.candidateId, list);
  });
  return { audioOverrideByCandidate, subtitleOverrideByCandidate };
};

export const buildFileIngestionActiveInputGroups = <
  TRow extends FileIngestionUndefinedTrackRow,
  TCandidate extends CandidateLike,
>(
  activeInputRows: TRow[],
  candidates: TCandidate[],
  params: {
    unknownMediaLabel: string;
    movieLabel: string;
  }
) => {
  const grouped = new Map<string, TRow[]>();
  activeInputRows.forEach((row) => {
    const rows = grouped.get(row.candidateId) ?? [];
    rows.push(row);
    grouped.set(row.candidateId, rows);
  });

  return Array.from(grouped.entries()).map(([candidateId, rows]) => {
    const candidate = candidates.find((entry) => entry.id === candidateId);
    const title =
      candidate?.match?.title?.trim() ||
      candidate?.parsed?.title?.trim() ||
      candidate?.name ||
      rows[0]?.candidateName ||
      params.unknownMediaLabel;
    const season = typeof candidate?.parsed?.season === "number" ? candidate.parsed.season : null;
    const episode = typeof candidate?.parsed?.episode === "number" ? candidate.parsed.episode : null;
    const slotLabel =
      season !== null && episode !== null
        ? `S${season}E${String(episode).padStart(2, "0")}`
        : candidate?.match?.type === "movie"
          ? params.movieLabel
          : null;

    return {
      candidateId,
      primaryLabel: slotLabel ? `${slotLabel} - ${title}` : title,
      rows,
    };
  });
};
