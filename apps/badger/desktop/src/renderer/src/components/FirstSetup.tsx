/**
 * "First setup": the full-window, step-by-step flow a computer goes through
 * once before the app (#25). One question per step, Back / Next, and a final
 * Finish. Nothing is saved until Finish; closing the window part-way saves
 * nothing, so the flow comes back on the next start. The steps are a list
 * (firstSetupSteps.ts); this component only renders and saves them.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, CardFooter, Label, RadioGroup, RadioGroupItem } from "@space/ui";
import { DesktopStartupCard, DesktopStartupControls, DesktopStartupPage } from "@space/desktop-shell/components";
import SetupLanguageMenu from "@/components/SetupLanguageMenu";
import mascotWebp from "@/assets/mascot.webp";
import { rendererLogger } from "@/logger";
import { hasHardwareEncoder } from "@space/shared/transcodeHardware";
import {
  describeCpuModel,
  detectedHardware,
  saveFirstSetup,
  type FirstSetupDevice,
  type FirstSetupStep,
} from "./firstSetupSteps";

const log = rendererLogger.child({ scope: "first-setup" });

type FirstSetupProps = {
  device: FirstSetupDevice;
  /** The steps to ask, already narrowed to the ones this computer has not answered. */
  steps: readonly FirstSetupStep[];
  /** Called once every answer is stored. */
  onDone: () => void;
  /** Numbered steps this setup already showed before these questions (the library key: 1), so they count on from it (UX-SETUP-08). */
  stepOffset?: number;
};

export default function FirstSetup({ device, steps, onDone, stepOffset = 0 }: FirstSetupProps) {
  const { t, i18n } = useTranslation();
  const [index, setIndex] = useState(0);
  // The step's preselected pick (its recommendation, or "Do not send" on error reports) starts chosen;
  // going Back and forward again keeps what was picked.
  const [choices, setChoices] = useState<Record<string, string>>(() =>
    Object.fromEntries(steps.flatMap((step) => {
      const preselected = step.preselected?.(device) ?? step.recommended(device);
      return preselected === null ? [] : [[step.id, preselected]];
    })),
  );
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  // Steps already stored when a later one failed: their picks are final, so Back is not offered.
  const [saved] = useState(() => new Set<string>());
  const [locked, setLocked] = useState(false);

  const step = steps[index];
  if (!step) return null;
  const ns = `firstSetup.steps.${step.id}`;
  const last = index === steps.length - 1;
  const recommended = step.recommended(device);
  const reason = step.reason(device);
  const choice = choices[step.id] ?? recommended;
  // Nothing preselected: Next / Finish wait for the user's own pick.
  const unanswered = choice === null;
  // The shared "change it later in Settings → Transcoding" note sits on the last step that has no note of its own.
  const lastSharedNote = steps.findLastIndex((s) => !s.later) === index;
  // Shown once, on the first step, not repeated on every question.
  const hardware = index === 0 ? detectedHardware(device) : null;

  const finish = () => {
    setSaving(true);
    setFailed(false);
    saveFirstSetup(steps, choices, device, saved)
      .then(onDone)
      .catch((err: unknown) => {
        log.error({ err: String(err) }, "[first-setup] could not store the answers");
        setFailed(true);
        setLocked(saved.size > 0);
        setSaving(false);
      });
  };

  return (
    <div data-testid="first-setup">
      <DesktopStartupPage
        nebula="badger"
        mainClassName="pb-12 pt-32"
        controls={
          <DesktopStartupControls>
            <SetupLanguageMenu />
          </DesktopStartupControls>
        }
      >
        <DesktopStartupCard
          eyebrow={<span>{t("firstSetup.title")}</span>}
          progress={
            stepOffset + steps.length > 1
              ? {
                  current: stepOffset + index + 1,
                  total: stepOffset + steps.length,
                  label: t("firstSetup.stepOf", { current: stepOffset + index + 1, total: stepOffset + steps.length }),
                  testId: "first-setup-progress",
                }
              : undefined
          }
          title={t(`${ns}.title`)}
          description={
            <>
              {step.explain.map((sentence) => t(`${ns}.explain.${sentence}`)).join(" ")}
              {step.infoLink ? (
                <>
                  {" "}
                  <a
                    href={step.infoLink.href(i18n.language)}
                    target="_blank"
                    rel="noreferrer"
                    className="whitespace-nowrap text-xs underline underline-offset-2 hover:text-foreground"
                    data-testid="first-setup-info-link"
                  >
                    {t(step.infoLink.label)}
                  </a>
                </>
              ) : null}
            </>
          }
          mascotSrc={mascotWebp}
          mascotAlt={t("brand.mascotAlt")}
          maxWidthClassName="max-w-2xl"
          contentClassName="space-y-5"
          footer={
            <CardFooter className="justify-between gap-3">
              {index > 0 && !locked ? (
                <Button
                  variant="outline"
                  data-testid="first-setup-back"
                  disabled={saving}
                  onClick={() => {
                    setFailed(false);
                    setIndex(index - 1);
                  }}
                >
                  {t("firstSetup.back")}
                </Button>
              ) : (
                <span />
              )}
              {last ? (
                <Button data-testid="first-setup-finish" disabled={saving || unanswered} onClick={finish}>
                  {saving ? t("firstSetup.saving") : t("firstSetup.finish")}
                </Button>
              ) : (
                <Button data-testid="first-setup-next" disabled={unanswered} onClick={() => setIndex(index + 1)}>
                  {t("firstSetup.next")}
                </Button>
              )}
            </CardFooter>
          }
        >
          <div className="space-y-5 text-sm" data-testid={`first-setup-step-${step.id}`}>
            {hardware ? (
              <p className="rounded-md border border-border bg-muted/40 px-3 py-2" data-testid="first-setup-computer">
                {t("firstSetup.computer", {
                  cpu: describeCpuModel(hardware.cpuModel) ?? t("firstSetup.cpuUnknown"),
                  cores: hardware.cores,
                  ram: Math.round(hardware.ramGB),
                })}{" "}
                {hasHardwareEncoder(hardware)
                  ? t("firstSetup.encoderFound", { encoder: hardware.hwEncoder })
                  : t("firstSetup.encoderNone")}
              </p>
            ) : null}

            {recommended !== null ? (
              <p className="font-medium" data-testid="first-setup-recommendation">
                {t(`${ns}.recommend.${recommended}`)}
                {reason ? <> {t(`${ns}.reason.${reason}`)}</> : null}
              </p>
            ) : null}

            <RadioGroup
              value={choice ?? ""}
              onValueChange={(value) => setChoices((prev) => ({ ...prev, [step.id]: value }))}
              aria-label={t(`${ns}.title`)}
            >
              {step.options.map((value) => {
                const id = `first-setup-${step.id}-${value}`;
                return (
                  <div
                    key={value}
                    className="flex items-start gap-3 rounded-md border border-border px-3 py-3 has-[[data-state=checked]]:border-primary"
                  >
                    <RadioGroupItem value={value} id={id} className="mt-0.5" data-testid={`first-setup-option-${value}`} />
                    <Label htmlFor={id} className="grid cursor-pointer gap-1 font-normal">
                      <span className="font-medium">
                        {t(`${ns}.options.${value}.label`)}
                        {value === recommended ? (
                          <span className="ml-2 text-xs font-normal text-muted-foreground" data-testid="first-setup-recommended-badge">
                            {t("firstSetup.recommendedBadge")}
                          </span>
                        ) : null}
                      </span>
                      {i18n.exists(`${ns}.options.${value}.description`) ? (
                        <span className="text-muted-foreground">{t(`${ns}.options.${value}.description`)}</span>
                      ) : null}
                    </Label>
                  </div>
                );
              })}
            </RadioGroup>

            {lastSharedNote ? <p className="text-muted-foreground">{t("firstSetup.settingsLater")}</p> : null}
            {step.later ? <p className="text-muted-foreground">{t(step.later)}</p> : null}
            {failed ? (
              <p className="text-destructive" role="alert" data-testid="first-setup-error">
                {t("firstSetup.saveError")}
              </p>
            ) : null}
          </div>
        </DesktopStartupCard>
      </DesktopStartupPage>
    </div>
  );
}
