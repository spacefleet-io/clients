/**
 * Host-element stand-ins for the lucide icons TV Settings draws (its groups, rows, dialogs and the shared TV pieces
 * it imports). Each icon renders as a host element named after it, so a test can find it by type.
 */
const ICONS = [
  "AudioLines",
  "Bug",
  "Captions",
  "Check",
  "ChevronDown",
  "ChevronRight",
  "ChevronUp",
  "CloudOff",
  "Film",
  "Globe",
  "Headphones",
  "Home",
  "Info",
  "Languages",
  "Library",
  "Link",
  "Lock",
  "LogOut",
  "Mail",
  "MonitorSmartphone",
  "MousePointerClick",
  "Play",
  "QrCode",
  "RefreshCw",
  "RotateCcw",
  "Search",
  "Settings",
  "Shield",
  "SkipForward",
  "Sparkles",
  "Tv",
  "Type",
  "User",
  "UserCog",
  "Users",
] as const;

export const lucideStandIns = (): Record<(typeof ICONS)[number], string> =>
  Object.fromEntries(ICONS.map((name) => [name, `${name}Icon`])) as Record<(typeof ICONS)[number], string>;
