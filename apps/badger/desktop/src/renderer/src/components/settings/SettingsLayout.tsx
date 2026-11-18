import { Suspense, useCallback, useMemo, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button, Spinner } from "@space/ui";
import { DesktopSettingsShell, type DesktopSettingsGroup } from "@space/desktop-shell/components";
import { LogOut } from "lucide-react";
import TopNav from "../TopNav";
import { useAuth } from "../../auth";
import { useSignOutWithKeyCheck } from "../SignOutKeyCheck";
import {
  DEFAULT_SECTION,
  SETTINGS_GROUPS,
  getSectionDef,
  isSettingsSectionId,
  type SettingsSectionId,
} from "./registry";

/**
 * Unified settings shell. One page, one two-pane layout (filterable section
 * rail + content) that hosts every former Settings AND Account section. The
 * active section is driven by the `?section=` query param so both top-nav
 * entry points (gear → general, /account → account) deep-link into the same
 * surface, and `/account` redirects here. The layout is the fleet's shared
 * `DesktopSettingsShell` (UX-SET-01), which Parrot's Settings uses too.
 */
export default function SettingsLayout({
  defaultSection = DEFAULT_SECTION,
}: {
  /** Section shown when the URL carries no `?section=` (e.g. the /account entry lands on "account"). */
  defaultSection?: SettingsSectionId;
}) {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  // Sign out sits under the settings rail as well as in the top bar's avatar menu (UX-TOP-01); ACCT-DEV-03 asks about the key first.
  const { requestSignOut, dialog: signOutKeyCheckDialog } = useSignOutWithKeyCheck();

  const paramSection = searchParams.get("section");
  const activeSection: SettingsSectionId = isSettingsSectionId(paramSection)
    ? paramSection
    : defaultSection;

  const selectSection = useCallback(
    (section: SettingsSectionId) => {
      const next = new URLSearchParams(searchParams);
      next.set("section", section);
      setSearchParams(next, { replace: false });
    },
    [searchParams, setSearchParams]
  );

  const def = useMemo(() => getSectionDef(activeSection), [activeSection]);
  const ActiveComponent = def.Component;
  const groups = useMemo<DesktopSettingsGroup<SettingsSectionId>[]>(
    () =>
      SETTINGS_GROUPS.map((group) => ({
        id: group.id,
        label: t(`settings.nav.group.${group.id}`),
        sections: group.sections.map((id) => ({ id, label: t(`settings.nav.${id}`), icon: getSectionDef(id).icon })),
      })),
    [t]
  );

  if (!user) return <Navigate to="/login" replace />;

  return (
    <div className="min-h-screen">
      <TopNav />
      <main className="container py-10">
        <DesktopSettingsShell
          title={t("settings.title")}
          subtitle={t("settings.subtitle")}
          groups={groups}
          activeSection={activeSection}
          onSelect={selectSection}
          query={query}
          onQueryChange={setQuery}
          labels={{
            navAria: t("settings.nav.aria"),
            searchPlaceholder: t("settings.nav.searchPlaceholder"),
            noResults: t("settings.nav.noResults"),
          }}
          sectionDescription={t(`settings.sectionDesc.${activeSection}`)}
          railFooter={
            <>
              <Button
                type="button"
                variant="ghost"
                className="mt-4 w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
                onClick={() => void requestSignOut()}
                data-testid="settings-sign-out"
              >
                <LogOut className="h-4 w-4" aria-hidden />
                {t("nav.signOut")}
              </Button>
              {signOutKeyCheckDialog}
            </>
          }
        >
          <Suspense
            fallback={
              <div className="flex items-center justify-center py-24">
                <Spinner aria-label={t("common.loading")} />
              </div>
            }
          >
            {/* key forces a fresh mount per section so each owns its own state cleanly */}
            <ActiveComponent key={activeSection} />
          </Suspense>
        </DesktopSettingsShell>
      </main>
    </div>
  );
}
