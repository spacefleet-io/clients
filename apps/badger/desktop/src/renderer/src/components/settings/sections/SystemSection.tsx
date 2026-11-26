import { useTranslation } from "react-i18next";
import { Button, StatusBadge, Switch, type StatusBadgeStatus } from "@space/ui";
import { useRuntimeStatus, type RuntimeStatusValue } from "@space/desktop-shell/services/runtime-status";
import { useErrorReportsSetting } from "@space/error-report/react";
import { errorReports, errorReportsLog } from "@/lib/errorReports";
import { SettingGroup, SettingHint, SettingPanel, SettingRow } from "../kit";
import { ErrorReportsLink } from "@space/desktop-shell/components";
import { useHiddenJobNoticesSetting } from "@space/desktop-shell/hooks";

const RUNTIME_STATUS: Record<RuntimeStatusValue, StatusBadgeStatus> = {
  ready: "ok",
  restarting: "pending",
  lost: "fail",
  unknown: "idle",
};

export default function SystemSection() {
  const { t, i18n } = useTranslation();
  // REL-LOG-06: undefined = no bridge (web/tests) → row hidden; null = loading.
  const { value: errorReportsOn, set: setErrorReportsOn } = useErrorReportsSetting(errorReports, errorReportsLog);
  const { status: runtimeStatus, restart: restartRuntime, restarting: runtimeRestarting } = useRuntimeStatus();
  // UX-NOTICE-06: system notification for a job that ends while the window is hidden; on by default.
  const hiddenJobNotices = useHiddenJobNoticesSetting(window.sf?.hiddenJobNotices);

  return (
    <div className="space-y-4">
      <SettingPanel>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="font-semibold">{t("settings.system.runtime.title")}</div>
            <SettingHint>{t("settings.system.runtime.subtitle")}</SettingHint>
          </div>
          <StatusBadge status={RUNTIME_STATUS[runtimeStatus]} dot className="shrink-0">
            {t(`settings.system.runtime.status.${runtimeStatus}`)}
          </StatusBadge>
        </div>
        <div className="mt-3">
          <Button variant="secondary" size="sm" onClick={() => void restartRuntime()} disabled={runtimeRestarting}>
            {runtimeRestarting ? t("settings.system.runtime.restarting") : t("settings.system.runtime.restart")}
          </Button>
        </div>
      </SettingPanel>

      {errorReportsOn !== undefined ? (
        <SettingGroup>
          <SettingRow
            title={t("settings.system.errorReports.title")}
            description={
              <>
                {t("settings.system.errorReports.subtitle")}{" "}
                <ErrorReportsLink
                  language={i18n.language}
                  label={t("settings.system.errorReports.link")}
                  testId="settings-error-reports-link"
                />
              </>
            }
            control={
              <Switch
                data-testid="settings-error-reports-switch"
                checked={errorReportsOn === true}
                disabled={errorReportsOn === null}
                onCheckedChange={setErrorReportsOn}
              />
            }
          />
        </SettingGroup>
      ) : null}
      {hiddenJobNotices.value !== undefined ? (
        <SettingGroup>
          <SettingRow
            title={t("notify.system.hiddenJobsSetting")}
            description={t("notify.system.hiddenJobsHint")}
            control={
              <Switch
                data-testid="settings-hidden-job-notices-switch"
                aria-label={t("notify.system.hiddenJobsSetting")}
                checked={hiddenJobNotices.value === true}
                disabled={hiddenJobNotices.value === null}
                onCheckedChange={hiddenJobNotices.set}
              />
            }
          />
        </SettingGroup>
      ) : null}
    </div>
  );
}
