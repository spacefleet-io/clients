import type { RefObject } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@space/ui";
import { desktopTopNavDisabledClassName } from "@space/desktop-shell/components";
import { ProfileMenuItems, useProfilesSnapshot, type ProfileMenuProps } from "@space/ui/profiles";

// The narrow-window navigation sheet. TopNav renders its trigger button eagerly
// and lazy-loads this component on the first open, so the Sheet primitives stay
// out of the TopNav chunk (issue #25: TopNav sat at 44.75 of its 45 KiB budget).
// UX-TOP-01: below the bar's breakpoint the avatar menu is hidden with the other icons, so the sheet ends with the
// same entries (every profile, Add profile, Manage profiles, Sign out) from the shared `ProfileMenuItems`.
export default function TopNavMobileMenu({
  open,
  onOpenChange,
  hasMedia,
  iconSrc,
  profileMenu,
  triggerRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasMedia: boolean;
  iconSrc: string;
  profileMenu: ProfileMenuProps;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation();
  const snapshot = useProfilesSnapshot(profileMenu.store);
  const current = snapshot.profiles.find((p) => p.id === snapshot.activeId);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        // Scrolls on a short window: five profiles and their entries are taller than a 600 px window.
        // Thin dark scrollbar, so it doesn't show Chromium's light-grey default on the dark sheet.
        className="w-[320px] sm:w-[360px] overflow-y-auto [scrollbar-color:#30363d_transparent] [scrollbar-width:thin] bg-[#0d1117] text-white"
        // No SheetTrigger here (the button lives in TopNav), so hand focus back
        // to it ourselves when the sheet closes.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef.current?.focus();
        }}
      >
        <SheetHeader className="sr-only">
          <SheetTitle>{t("nav.appNav")}</SheetTitle>
          <SheetDescription>{t("nav.openMenu")}</SheetDescription>
        </SheetHeader>
        <div className="flex items-center gap-3 pb-6">
          <img className="h-[45px] w-[45px]" src={iconSrc} alt={t("brand.app")} />
          <div>
            <div className="font-semibold leading-tight">{t("brand.app")}</div>
            <div className="text-sm text-[#8b949e]">{t("nav.appNav")}</div>
          </div>
        </div>
        <div className="grid gap-2">
          <Button
            asChild
            variant="ghost"
            className="justify-start text-[#8b949e] hover:text-white hover:bg-[#161b22] text-xs font-black uppercase tracking-[0.12em]"
          >
            <Link to="/home">{t("nav.dashboard")}</Link>
          </Button>
          {/* UX-LIBTAB-01: while the library is empty, Library and Playlists are greyed out and open nothing. */}
          {(
            [
              ["/media-library", t("nav.library")],
              ["/playlists", t("nav.playlists")],
            ] as const
          ).map(([to, label]) =>
            hasMedia ? (
              <Button
                key={to}
                asChild
                variant="ghost"
                className="justify-start text-[#8b949e] hover:text-white hover:bg-[#161b22] text-xs font-black uppercase tracking-[0.12em]"
              >
                <Link to={to}>{label}</Link>
              </Button>
            ) : (
              <Button
                key={to}
                variant="ghost"
                className={`justify-start ${desktopTopNavDisabledClassName} text-xs font-black uppercase tracking-[0.12em]`}
                disabled
              >
                {label}
              </Button>
            )
          )}
          <Button
            asChild
            variant="ghost"
            className="justify-start text-[#8b949e] hover:text-white hover:bg-[#161b22] text-xs font-black uppercase tracking-[0.12em]"
          >
            <Link to="/settings">{t("nav.settings")}</Link>
          </Button>
        </div>
        <div className="my-6 h-px bg-[#30363d]" />
        {/* px-2 lines the entries up with the nav; the separator steps back out so it is as wide and as dark as the divider above. */}
        <div role="menu" aria-label={t("profiles.menuA11y", { name: current?.name ?? "" })} data-testid="top-nav-mobile-profiles" className="grid gap-0.5 px-2 [&>[role=separator]]:-mx-2 [&>[role=separator]]:bg-[#30363d]">
          <ProfileMenuItems {...profileMenu} onPicked={() => onOpenChange(false)} testIdPrefix="top-nav-mobile-profile" />
        </div>
      </SheetContent>
    </Sheet>
  );
}
