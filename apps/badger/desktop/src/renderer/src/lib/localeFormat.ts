import { formatRating as formatRatingIn, formatStarRating as formatStarRatingIn } from "@space/shared/format";
import i18n from "i18next";

/** The shared rating formats (`@space/shared/format`) in the UI language (UX-I18N-01). */
export const formatRating = (value: number): string => formatRatingIn(value, i18n.language || "en");
export const formatStarRating = (value: number): string => formatStarRatingIn(value, i18n.language || "en");
