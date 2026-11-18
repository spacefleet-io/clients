type DesktopTopNavTone = {
  active: string;
  idle: string;
  disabled: string;
};

type DesktopTopNavItemClassNameOptions = {
  isActive: boolean;
  tone?: DesktopTopNavTone;
  disabled?: boolean;
};

/**
 * A greyed-out tab (UX-LIBTAB-01): the idle colour at half opacity, with no hover, so every disabled tab looks the
 * same whether or not the pointer is on it.
 */
export const desktopTopNavDisabledClassName = "cursor-default select-none text-[#8b949e] opacity-50";

/** The one top-bar tab look every desktop app uses (UX-TOP-03); the accent comes from the app's `--primary` token. */
export const desktopTopNavTone: DesktopTopNavTone = {
  active: "border border-[#30363d] bg-[#161b22] text-white",
  idle: "text-[#8b949e] hover:bg-[#161b22]/60 hover:text-white",
  disabled: desktopTopNavDisabledClassName,
};

/** The selected tab's icon takes the app accent: Badger yellow, Parrot green (UX-TOP-03). */
export const desktopTopNavActiveIconClassName = "[&_svg]:text-primary";

export const desktopTopNavItemBaseClassName =
  "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-black uppercase tracking-[0.12em] transition-colors";

export const desktopTopNavTextActionBaseClassName = "text-xs font-black uppercase tracking-[0.12em]";

export const desktopTopNavItemClassName = ({
  isActive,
  tone = desktopTopNavTone,
  disabled = false,
}: DesktopTopNavItemClassNameOptions) =>
  [
    desktopTopNavItemBaseClassName,
    disabled ? tone.disabled : isActive ? `${tone.active} ${desktopTopNavActiveIconClassName}` : tone.idle,
  ]
    .filter(Boolean)
    .join(" ");

/** An icon button on the right of the top bar (import, notifications, account, settings). */
export const desktopTopNavIconActionClassName = "relative text-[#8b949e] hover:bg-[#161b22] hover:text-white";
