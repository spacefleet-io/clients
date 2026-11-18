import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Search, X } from "lucide-react";
import { Button, Input, Label, StatusBadge, Switch, toast, type StatusBadgeStatus } from "@space/ui";
import { getMediaLanguageFlag, MEDIA_LANGUAGE_OPTIONS } from "@space/shared";
import { useLibraryActions } from "@/lib/libraryContext";
import { useClientSettings } from "@/lib/settings/useClientSettings";
import SettingListDialog from "../SettingListDialog";
import { SettingHint, SettingPanel } from "../kit";

type TestState = "idle" | "ok" | "fail" | "testing";

const STATE_TO_STATUS: Record<TestState, StatusBadgeStatus> = {
  idle: "idle",
  ok: "ok",
  fail: "fail",
  testing: "pending",
};

const normalizeInvidiousUrl = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const withScheme = trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
};

export default function TrailersSection() {
  const { t } = useTranslation();
  const { config, setConfig, updateNestedSetting } = useClientSettings();
  const { setSharedSetting } = useLibraryActions();

  const [invidiousTestState, setInvidiousTestState] = useState<TestState>(() =>
    config.trailerSource.provider === "invidious" && config.trailerSource.validated ? "ok" : "idle"
  );
  const [languageQuery, setLanguageQuery] = useState("");
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false);

  const allMediaLanguages = useMemo(
    () =>
      MEDIA_LANGUAGE_OPTIONS.slice().sort((a, b) =>
        (a.englishName || a.nativeName).localeCompare(b.englishName || b.nativeName)
      ),
    []
  );

  const trailerExtras = config.trailerLanguages.extras;
  const trailerExtrasMaxed = trailerExtras.length >= 2;
  const resolveLanguageLabel = (code: string) => {
    const match = allMediaLanguages.find((lang) => lang.code === code);
    return match?.nativeName || match?.englishName || code.toUpperCase();
  };

  const normalizedQuery = languageQuery.trim().toLowerCase();
  const filteredLanguages = allMediaLanguages
    .filter((lang) => !trailerExtras.includes(lang.code))
    .filter(
      (lang) =>
        !normalizedQuery ||
        lang.code.toLowerCase().includes(normalizedQuery) ||
        lang.englishName.toLowerCase().includes(normalizedQuery) ||
        lang.nativeName.toLowerCase().includes(normalizedQuery)
    );

  const toggleTrailerLanguage = (language: string, checked: boolean) => {
    const extras = trailerExtras.slice();
    let nextExtras = extras;
    if (checked && !extras.includes(language)) {
      if (extras.length < 2) nextExtras = [...extras, language];
    } else if (!checked && extras.includes(language)) {
      nextExtras = extras.filter((value) => value !== language);
    }
    if (nextExtras !== extras) {
      updateNestedSetting({ trailerLanguages: { extras: nextExtras } });
      // Mirror the synced source-of-truth to shared settings (cross-device).
      // Preserved dual-write from the original implementation.
      const updatedAt = new Date().toISOString();
      void setSharedSetting("trailer_languages", JSON.stringify({ extras: nextExtras, updatedAt })).catch(() => {});
    }
  };

  const testInvidious = async () => {
    const normalized = normalizeInvidiousUrl(config.trailerSource.invidiousUrl);
    if (!normalized) {
      setInvidiousTestState("fail");
      toast(t("settings.advanced.trailer.instanceRequired"));
      return;
    }
    setInvidiousTestState("testing");
    try {
      const res = await fetch(`${normalized}/api/v1/stats`);
      const ok = res.ok;
      setInvidiousTestState(ok ? "ok" : "fail");
      updateNestedSetting({
        trailerSource: { ...config.trailerSource, invidiousUrl: normalized, validated: ok },
      });
      toast(ok ? t("settings.advanced.trailer.healthOk") : t("settings.advanced.trailer.healthFail"));
    } catch {
      setInvidiousTestState("fail");
      updateNestedSetting({ trailerSource: { ...config.trailerSource, validated: false } });
      toast(t("settings.advanced.trailer.healthFail"));
    }
  };

  const statusLabel = (state: TestState) =>
    state === "ok"
      ? t("settings.advanced.trailer.healthy")
      : state === "fail"
        ? t("settings.advanced.trailer.needsAttention")
        : state === "testing"
          ? t("settings.advanced.trailer.testing")
          : t("settings.advanced.trailer.notTested");

  const isInvidious = config.trailerSource.provider === "invidious";

  return (
    <div className="space-y-4">
      {/* Trailer source */}
      <SettingPanel>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="font-semibold">{t("settings.advanced.trailer.title")}</div>
            <SettingHint>{t("settings.advanced.trailer.subtitle")}</SettingHint>
          </div>
          <Switch
            className="shrink-0"
            checked={isInvidious}
            onCheckedChange={(checked) => {
              setInvidiousTestState("idle");
              updateNestedSetting({
                trailerSource: {
                  ...config.trailerSource,
                  provider: checked ? "invidious" : "youtube",
                  validated: checked ? false : true,
                },
              });
            }}
          />
        </div>

        {isInvidious ? (
          <div className="mt-4 space-y-2">
            <Label htmlFor="invidiousUrl">{t("settings.advanced.trailer.instanceLabel")}</Label>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                id="invidiousUrl"
                className="flex-1"
                value={config.trailerSource.invidiousUrl}
                onChange={(e) => {
                  setInvidiousTestState("idle");
                  setConfig((prev) => ({
                    ...prev,
                    trailerSource: { ...prev.trailerSource, invidiousUrl: e.target.value, validated: false },
                  }));
                }}
                onBlur={(e) =>
                  updateNestedSetting({
                    trailerSource: { ...config.trailerSource, invidiousUrl: e.target.value, validated: false },
                  })
                }
                placeholder={t("settings.advanced.trailer.instancePlaceholder")}
              />
              <Button type="button" variant="secondary" onClick={testInvidious} disabled={invidiousTestState === "testing"}>
                {invidiousTestState === "testing"
                  ? t("settings.advanced.trailer.testing")
                  : t("settings.advanced.trailer.testButton")}
              </Button>
            </div>
            <StatusBadge status={STATE_TO_STATUS[invidiousTestState]}>{statusLabel(invidiousTestState)}</StatusBadge>
          </div>
        ) : null}
      </SettingPanel>

      {/* Trailer languages */}
      <SettingPanel>
        <div className="space-y-1">
          <div className="font-semibold">{t("settings.trailerLanguages.title")}</div>
          <SettingHint>{t("settings.trailerLanguages.subtitle")}</SettingHint>
        </div>

        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/40 px-3 py-1 text-xs font-semibold">
              <span className="text-base leading-none">{getMediaLanguageFlag("xx")}</span>
              {t("settings.trailerLanguages.originalLabel")}
            </span>
            {trailerExtras.map((code) => (
              <span
                key={code}
                className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-xs font-semibold"
              >
                <span className="text-base leading-none">{getMediaLanguageFlag(code)}</span>
                {resolveLanguageLabel(code)}
                <button
                  type="button"
                  className="ml-1 rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                  onClick={() => toggleTrailerLanguage(code, false)}
                  aria-label={t("settings.trailerLanguages.remove", { language: resolveLanguageLabel(code) })}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>

          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={trailerExtrasMaxed}
            onClick={() => setLanguagePickerOpen(true)}
          >
            <Plus className="mr-1 h-4 w-4" />
            {t("settings.trailerLanguages.add")}
          </Button>

          <SettingListDialog
            open={languagePickerOpen}
            onOpenChange={(open) => {
              setLanguagePickerOpen(open);
              if (!open) setLanguageQuery("");
            }}
            title={t("settings.trailerLanguages.add")}
            description={t("settings.trailerLanguages.subtitle")}
            testId="trailer-language-dialog"
            toolbar={
              <div className="flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm">
                <Search className="h-4 w-4 text-muted-foreground" />
                <input
                  className="w-full bg-transparent outline-none"
                  id="trailerLanguageSearch"
                  name="trailerLanguageSearch"
                  placeholder={t("settings.trailerLanguages.searchPlaceholder")}
                  value={languageQuery}
                  onChange={(e) => setLanguageQuery(e.target.value)}
                />
              </div>
            }
          >
            {filteredLanguages.map((lang) => (
              <button
                key={lang.code}
                type="button"
                onClick={() => {
                  toggleTrailerLanguage(lang.code, true);
                  setLanguageQuery("");
                  setLanguagePickerOpen(false);
                }}
                className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-left text-sm text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
              >
                <span className="text-base leading-none">{getMediaLanguageFlag(lang.code)}</span>
                <span className="font-medium">{resolveLanguageLabel(lang.code)}</span>
                <span className="text-xs uppercase text-muted-foreground">{lang.code}</span>
              </button>
            ))}
            {filteredLanguages.length === 0 ? <SettingHint>{t("settings.trailerLanguages.noResults")}</SettingHint> : null}
          </SettingListDialog>

          <SettingHint>{t("settings.trailerLanguages.maxHint")}</SettingHint>
        </div>
      </SettingPanel>
    </div>
  );
}
