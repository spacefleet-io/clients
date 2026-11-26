import { Suspense, lazy, memo, useRef, useState, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth";
import { useLibraryShell } from "@/lib/libraryContext";
import { useIngestion } from "@/lib/ingestionContext";
import { Button } from "@space/ui";
import { BadgerIconButton, badgerTopBarIcons } from "@space/ui/badger";
import { House, LibraryBig, ListMusic, Loader2, Menu, Settings } from "lucide-react";
import { shouldShowLibrarySyncBanner } from "@/lib/librarySyncStatus";
import { getSystemIssueMessage } from "@/lib/systemIssueMessage";
import iconPng from "@/assets/icon.png";
import { DesktopAppTopNav, SyncBannerSurface, desktopTopNavItemClassName } from "@space/desktop-shell/components";
import { ProfileMenu, type ProfileMenuProps } from "@space/ui/profiles";
import { profileStore } from "@/lib/profileStore";
import { rendererLogger } from "@/logger";
import TopNavNotificationsButton from "@/components/TopNavNotificationsButton";
import TopNavJobsSidebar from "@/components/TopNavJobsSidebar";
import { DesktopOfflineIndicator } from "@/components/DesktopOfflineIndicator";
import { FounderNotice } from "@/components/FounderNotice";
import { SkipCatchUpNotice } from "@/components/SkipCatchUpNotice";
import { UnpaidAccessSign } from "@/components/UnpaidAccessSign";
import { OverQuotaSign } from "@/components/OverQuotaSign";
import { useSignOutWithKeyCheck } from "@/components/SignOutKeyCheck";
import TopNavSearch from "@/components/TopNavSearch";

const TopNavMobileMenu = lazy(() => import("@/components/TopNavMobileMenu"));

const profileMenuLogger = rendererLogger.child({ scope: "profiles-menu" });
const profileMenuLog = (event: string, data: Record<string, unknown>) => profileMenuLogger.info(data, event);
/** Settings → Profiles (`ProfilesSection`); `add=1` opens its manager on a new profile. */
const PROFILES_SETTINGS_PATH = "/settings?section=profiles";

function TopNav() {
  const { user } = useAuth();
  const { mediaCount, loading, error, datasetStatus, writeBlockedReason } = useLibraryShell();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { openIngestion } = useIngestion();
  const mobileMenuTriggerRef = useRef<HTMLButtonElement>(null);
  // Mounted on first open only, so the sheet chunk is never fetched at startup.
  const [mobileMenuMounted, setMobileMenuMounted] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // ACCT-DEV-03: asks whether the library key was saved before signing out, when this computer holds it.
  const { requestSignOut, dialog: signOutKeyCheckDialog } = useSignOutWithKeyCheck();
  const hasMedia = mediaCount > 0;
  const showLibrarySyncBanner = Boolean(
    user &&
      shouldShowLibrarySyncBanner({
        loading,
        hasError: Boolean(error),
        datasetStatus,
        requirePlayback: true,
      })
  );
  const writeBlockedMessage = getSystemIssueMessage(writeBlockedReason);
  const iconSrc = iconPng;
  // UX-TOP-01: one set of avatar-menu entries for the wide bar's popover and the narrow window's sheet.
  const profileMenu: ProfileMenuProps = {
    store: profileStore,
    log: profileMenuLog,
    t,
    signOutLabel: t("nav.signOut"),
    onSignOut: () => void requestSignOut(),
    onAddProfile: () => navigate(`${PROFILES_SETTINGS_PATH}&add=1`),
    onManageProfiles: () => navigate(PROFILES_SETTINGS_PATH),
  };
  const navLinkClass =
    (dimmed = false) =>
    ({ isActive }: { isActive: boolean }) =>
      [desktopTopNavItemClassName({ isActive }), dimmed ? "opacity-50" : ""].filter(Boolean).join(" ");
  // UX-LIBTAB-01: while the library is empty, Library and Playlists are greyed out and are not links.
  const libraryTab = (to: string, testId: string, icon: ReactNode, label: string) =>
    hasMedia ? (
      <NavLink to={to} className={navLinkClass()} data-testid={testId}>
        {icon}
        {label}
      </NavLink>
    ) : (
      <div className={desktopTopNavItemClassName({ isActive: false, disabled: true })} aria-disabled="true" data-testid={testId}>
        {icon}
        {label}
      </div>
    );

  return (
    <>
      <DesktopAppTopNav
        logoSrc={iconSrc}
        logoAlt={t("brand.app")}
        title={t("brand.app")}
        // UX-NOTICE-02, UX-NOTICE-08: offline, the first sync, an unpaid account and a library over its storage are
        // said by small signs inside the fixed bar, never by a bar under it that pushes the page down.
        status={
          <>
            <DesktopOfflineIndicator />
            <UnpaidAccessSign />
            <OverQuotaSign />
            {showLibrarySyncBanner ? (
              <span
                role="status"
                data-testid="desktop-sync-indicator"
                className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-[#30363d] px-2.5 text-xs font-medium text-[#8b949e]"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[#ffaa54]" aria-hidden="true" />
                <span>{t("library.syncing")}</span>
              </span>
            ) : null}
          </>
        }
        desktopLayout="balanced"
        desktopNav={
          user ? (
            <nav className="flex items-center gap-1">
              <NavLink to="/home" className={navLinkClass()}>
                <House className="h-4 w-4" />
                {t("nav.dashboard")}
              </NavLink>
              {libraryTab("/media-library", "top-nav-library", <LibraryBig className="h-4 w-4" />, t("nav.library"))}
              {/* UX-TOP-01: Playlists is a main tab beside Home and Library, as in Parrot (PAR-NAV-01). */}
              {libraryTab("/playlists", "top-nav-playlists", <ListMusic className="h-4 w-4" />, t("nav.playlists"))}
            </nav>
          ) : null
        }
        // UX-TOP-01: Search (the palette, UX-SEARCH-01) and "+" (add media from any page), jobs, notifications,
        // settings, then the current profile's avatar menu (UX-TOP-02, the same menu as Parrot's), shown even with one
        // profile: every profile to switch to, Add profile, Manage profiles and Sign out.
        leadingActions={
          user ? (
            <>
              <TopNavSearch />
              <BadgerIconButton
                label={t("nav.addMedia")}
                icon={badgerTopBarIcons.add}
                onClick={() => openIngestion()}
                testId="top-nav-add-media"
              />
              <TopNavJobsSidebar />
            </>
          ) : null
        }
        notificationAction={user ? <TopNavNotificationsButton userId={user.id} /> : null}
        accountAction={
          user ? (
            <BadgerIconButton
              label={t("nav.settings")}
              icon={<Settings className="h-[18px] w-[18px]" aria-hidden />}
              onClick={() => navigate("/settings")}
              testId="top-nav-settings"
            />
          ) : null
        }
        signOutAction={user ? <ProfileMenu {...profileMenu} /> : null}
        mobileActions={
          user ? (
            <>
              <Button
                ref={mobileMenuTriggerRef}
                variant="outline"
                size="icon"
                type="button"
                aria-label={t("nav.openMenu")}
                aria-haspopup="dialog"
                aria-expanded={mobileMenuOpen}
                className="relative border-[#30363d] text-[#8b949e] hover:text-white hover:bg-[#161b22]"
                onClick={() => {
                  setMobileMenuMounted(true);
                  setMobileMenuOpen(true);
                }}
              >
                <Menu className="h-4 w-4" />
              </Button>
              {mobileMenuMounted ? (
                <Suspense fallback={null}>
                  <TopNavMobileMenu
                    open={mobileMenuOpen}
                    onOpenChange={setMobileMenuOpen}
                    hasMedia={hasMedia}
                    iconSrc={iconSrc}
                    profileMenu={profileMenu}
                    triggerRef={mobileMenuTriggerRef}
                  />
                </Suspense>
              ) : null}
            </>
          ) : null
        }
      />
      {signOutKeyCheckDialog}
      <FounderNotice />
      {user ? <SkipCatchUpNotice /> : null}
      <SyncBannerSurface
        visible={Boolean(user && writeBlockedMessage)}
        message={writeBlockedMessage}
      />
    </>
  );
}

export default memo(TopNav);
