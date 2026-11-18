import { useState } from "react";
import { useTranslation } from "react-i18next";
import { bucketRelativeTime } from "@space/shared/format";
import { Button } from "@space/ui";
import { useToolAccess } from "@/lib/toolAccess";
import SettingListDialog from "../SettingListDialog";
import { SettingHint, SettingPanel, SettingRow } from "../kit";

const RELATIVE_KEY: Record<"seconds" | "minutes" | "hours" | "days", string> = {
  seconds: "account.storage.relativeSeconds",
  minutes: "account.storage.relativeMinutes",
  hours: "account.storage.relativeHours",
  days: "account.storage.relativeDays",
};

/**
 * DEV-LIB-01: every third-party tool the user approved to reach the library through the local runtime, with the
 * access it holds, when it was granted and last used, and a button that ends the access immediately.
 * UX-LIST-01: one summary row on the page; the full list scrolls inside a dialog.
 */
export default function ConnectedToolsSection() {
  const { t } = useTranslation();
  const access = useToolAccess();
  const [listOpen, setListOpen] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);

  if (!access) {
    return (
      <SettingPanel>
        <SettingHint>{t("toolAccess.unavailable")}</SettingHint>
      </SettingPanel>
    );
  }

  const grants = access.snapshot.grants;

  const when = (iso: string): string => {
    const bucket = bucketRelativeTime(iso);
    if (!bucket) return t("toolAccess.list.never");
    return bucket.unit === "just_now"
      ? t("account.storage.relativeJustNow")
      : t(RELATIVE_KEY[bucket.unit], { value: bucket.value });
  };

  const revoke = async (grantId: string) => {
    setRevokingId(grantId);
    setFailedId(null);
    try {
      if (!(await access.revoke(grantId))) setFailedId(grantId);
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <SettingPanel>
      <div className="grid gap-3" data-testid="connected-tools-section">
        {grants.length === 0 ? (
          <SettingHint>{t("toolAccess.empty")}</SettingHint>
        ) : (
          <SettingRow
            title={t("toolAccess.summary", { count: grants.length })}
            description={t("toolAccess.summaryHint")}
            control={
              <Button type="button" variant="secondary" size="sm" onClick={() => setListOpen(true)}>
                {t("toolAccess.viewAll")}
              </Button>
            }
          />
        )}
      </div>

      <SettingListDialog
        open={listOpen && grants.length > 0}
        onOpenChange={setListOpen}
        title={t("toolAccess.list.title")}
        description={t("toolAccess.list.subtitle")}
        testId="connected-tools-dialog"
      >
        {grants.map((grant) => (
          <div
            key={grant.grantId}
            className="flex items-center justify-between gap-4 border-t border-border pt-3 first:border-t-0 first:pt-0"
            data-testid="connected-tool-row"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-medium">{grant.toolName}</span>
                <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                  {t(`toolAccess.mode.${grant.mode}`)}
                </span>
              </div>
              <SettingHint>{t("toolAccess.list.grantedAt", { when: when(grant.grantedAt) })}</SettingHint>
              <SettingHint>
                {grant.lastUsedAt
                  ? t("toolAccess.list.lastUsed", { when: when(grant.lastUsedAt) })
                  : t("toolAccess.list.neverUsed")}
              </SettingHint>
              {failedId === grant.grantId ? (
                <p className="text-xs text-destructive">{t("toolAccess.list.revokeError")}</p>
              ) : null}
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={revokingId === grant.grantId}
              title={t("toolAccess.list.revokeHint", { name: grant.toolName })}
              aria-label={`${t("toolAccess.list.revoke")} — ${grant.toolName}`}
              onClick={() => void revoke(grant.grantId)}
            >
              {revokingId === grant.grantId ? t("toolAccess.list.revoking") : t("toolAccess.list.revoke")}
            </Button>
          </div>
        ))}
      </SettingListDialog>
    </SettingPanel>
  );
}
