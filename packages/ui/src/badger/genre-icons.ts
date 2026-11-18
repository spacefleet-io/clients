/**
 * The icon drawn beside each TMDB genre in Badger (the title page's genre pills, the library's genre filter, Home's
 * genre rows), shared by the desktop app and the web player (REL-FAM-02).
 */
import type { GenreCategory } from "@space/shared";
import {
  AlertTriangle,
  Baby,
  Compass,
  Droplet,
  Eye,
  Film,
  Fingerprint,
  Heart,
  Landmark,
  Mic,
  Mountain,
  Music2,
  Newspaper,
  Puzzle,
  Rocket,
  Skull,
  Shield,
  Smile,
  Sparkles,
  Tag,
  Tv,
  Users,
  Wand2,
  Zap,
  type LucideIcon,
} from "lucide-react";

const movieGenreIcons: Record<number, LucideIcon> = {
  28: Zap,
  12: Compass,
  16: Sparkles,
  35: Smile,
  80: Fingerprint,
  99: Film,
  18: Film,
  10751: Users,
  14: Wand2,
  36: Landmark,
  27: Skull,
  10402: Music2,
  9648: Puzzle,
  10749: Heart,
  878: Rocket,
  10770: Tv,
  53: AlertTriangle,
  10752: Shield,
  37: Mountain,
};

const tvGenreIcons: Record<number, LucideIcon> = {
  10759: Compass,
  16: Sparkles,
  35: Smile,
  80: Fingerprint,
  99: Film,
  18: Film,
  10751: Users,
  10762: Baby,
  9648: Puzzle,
  10763: Newspaper,
  10764: Eye,
  10765: Rocket,
  10766: Droplet,
  10767: Mic,
  10768: Landmark,
  37: Mountain,
};

/** A genre's icon; a tag for a genre id we have no icon for. */
export const genreIcon = (category: GenreCategory, id: number): LucideIcon =>
  (category === "movie" ? movieGenreIcons[id] : tvGenreIcons[id]) ?? Tag;
