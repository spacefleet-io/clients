import { useCallback, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@space/ui";
import { ProfilesManager } from "@space/ui/profiles";
import { useProfileScreenDeps } from "@/components/profiles/profileScreenDeps";
import { profileStore, useProfiles } from "@/lib/profileStore";
import { SettingGroup, SettingRow } from "../kit";

/**
 * The account's profiles (ACCT-PROF-01, ACCT-PROF-02, ACCT-PROF-05): who is watching now and a one-step switch
 * (UX-PROF-01), then add, edit (name and avatar) and delete. Every profile is listed and handled the same way. The top
 * bar's avatar menu (UX-TOP-01) opens this section, with `add=1` for "Add profile", which starts the manager on a new
 * profile; the parameter is dropped once that is saved or cancelled. Opening the section reads the list again, as
 * "Who's watching?" does, so a profile added, renamed or deleted on another device or the website shows here.
 */
export default function ProfilesSection() {
  const { t } = useTranslation();
  const snapshot = useProfiles();
  const deps = useProfileScreenDeps();
  const [searchParams, setSearchParams] = useSearchParams();
  const adding = searchParams.get("add") === "1";
  const active = snapshot.profiles.find((p) => p.id === snapshot.activeId);
  useEffect(() => {
    void profileStore.refresh();
  }, []);
  const addDone = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("add");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  return (
    <div className="space-y-4">
      {active && snapshot.profiles.length > 1 ? (
        <SettingGroup>
          <SettingRow
            title={t("profiles.switch")}
            description={t("profiles.watchingAs", { name: active.name })}
            control={
              <Button data-testid="settings-profile-switch" type="button" variant="outline" onClick={() => profileStore.askAgain()}>
                {t("profiles.switch")}
              </Button>
            }
          />
        </SettingGroup>
      ) : null}
      {/* Remounted when "Add profile" is picked again from the menu while this section is open. */}
      <ProfilesManager key={adding ? "add" : "list"} {...deps} startWith={adding ? "add" : undefined} onAddDone={adding ? addDone : undefined} />
    </div>
  );
}
