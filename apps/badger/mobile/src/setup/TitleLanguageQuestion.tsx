// "How should titles appear?" (ACCT-PROF-03): the two options with their two examples each, "App language everywhere"
// preselected, the answer saved in the profile's settings (`titleLanguage`, synced). Asked as a numbered step of the
// phone's first setup, right after the key and "Who's watching?" (UX-SETUP-03, `TitleLanguageStep`), and otherwise
// (a profile created later, the TV, UX-SETUP-04) on its own screen without a step count right after the profile is
// picked (`TitleLanguageScreen`). The same texts as every other app (`titleLanguage.*`, REL-FAM-02).
import React, { useState } from "react";
import type { TFunction } from "i18next";
import { Image, StyleSheet, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { DEFAULT_TITLE_LANGUAGE, TITLE_LANGUAGES, type TitleLanguage } from "@space/shared/titleLanguage";
import { MobileAppBackdrop } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { scopeLogger } from "@space/mobile-shell/logger";
import { phoneSetupPosition } from "@space/mobile-shell/setup";
import type { PhoneSetupStepProps } from "@space/mobile-shell/setup-flow";
import { MobileChoiceList, MobileSetupChoices, MobileSetupStep } from "@space/mobile-shell/setup-step";
import { useActiveTitleLanguageAnswer } from "../lib/profileSettings";
import { answerTitleLanguage } from "../lib/titleLanguageQuestion";
import { IS_TV } from "../tv/lib/tvRuntime";
import { useTvScale, useTvStyles } from "../tv/lib/tvScale";
import { tvCardStyle } from "../tv/ui/tokens";
import { TvBody, TvTitle } from "../tv/ui/TvText";
import { TvPillButton } from "../tv/ui/TvPillButton";

const log = scopeLogger("title-language");

/** The SpaceBadger astronaut badger (UX-TV-04: the brand picture of the TV app). */
const MASCOT = require("../assets/mascot.webp");

/** Each option's label, and its description over its two examples. */
export const titleLanguageChoices = (t: TFunction) =>
  TITLE_LANGUAGES.map((value) => {
    const examples = t(`titleLanguage.${value}.examples`, { returnObjects: true }) as unknown;
    const shown = Array.isArray(examples) ? examples.join(" · ") : "";
    return { value, label: t(`titleLanguage.${value}.label`), detail: `${t(`titleLanguage.${value}.description`)}\n${shown}` };
  });

/** Saves the answer in the active profile (through its settings binding) and logs it. */
const saveTitleLanguage = (titleLanguage: TitleLanguage, where: "setup" | "screen") => {
  log.info("answered", { titleLanguage, where, tv: IS_TV });
  answerTitleLanguage(titleLanguage);
};

/** The phone setup's numbered step (after the key and "Who's watching?", before notifications). */
export const TitleLanguageStep = ({ progress, advance, back, onLanguage }: PhoneSetupStepProps) => {
  const { t } = useTranslation();
  const [answer, setAnswer] = useState<TitleLanguage>(DEFAULT_TITLE_LANGUAGE);
  const [busy, setBusy] = useState(false);
  // The sky alone until the profile's settings are read: a profile that already answered skips the step.
  if (useActiveTitleLanguageAnswer() === null) return <View testID="setup-title-language-wait" />;
  const { step, total } = phoneSetupPosition(progress);
  return (
    <MobileSetupStep
      step={step}
      total={total}
      title={t("titleLanguage.question")}
      body={t("titleLanguage.intro")}
      onBack={back}
      onLanguage={(code) => void onLanguage(code)}
      busy={busy}
      onNext={async () => {
        setBusy(true);
        try {
          // Kept counted once answered here, so the steps after it keep their numbers.
          await advance({ titleLanguageAnswered: true });
          saveTitleLanguage(answer, "setup");
        } finally {
          setBusy(false);
        }
      }}
    >
      <MobileSetupChoices choices={titleLanguageChoices(t)} selected={answer} onSelect={setAnswer} />
    </MobileSetupStep>
  );
};

/** On its own, no step count: the navigator moves on once the answer is saved. */
export const TitleLanguageScreen = () => (IS_TV ? <TvTitleLanguageScreen /> : <PhoneTitleLanguageScreen />);

const PhoneTitleLanguageScreen = () => {
  const { t } = useTranslation();
  const [answer, setAnswer] = useState<TitleLanguage>(DEFAULT_TITLE_LANGUAGE);
  return (
    <MobileSetupStep
      step={0}
      total={0}
      header={null}
      title={t("titleLanguage.question")}
      body={t("titleLanguage.intro")}
      onNext={() => saveTitleLanguage(answer, "screen")}
    >
      <MobileSetupChoices choices={titleLanguageChoices(t)} selected={answer} onSelect={setAnswer} />
    </MobileSetupStep>
  );
};

/** Height of the TV's list in design dp: two rows with a two-line detail, and the ring's room. */
const TV_LIST_HEIGHT = 2 * 64 + 7 + 2 * 5;

/** The TV's question as its language step (UX-TV-32): the badger over one card, rows the remote moves through, Next. */
const TvTitleLanguageScreen = () => {
  const { t } = useTranslation();
  const scale = useTvScale();
  const styles = useTvStyles(baseTvStyles);
  const [answer, setAnswer] = useState<TitleLanguage>(DEFAULT_TITLE_LANGUAGE);
  return (
    <View style={styles.screen} testID="tv-title-language">
      <MobileAppBackdrop />
      <Image source={MASCOT} style={styles.mascot} resizeMode="contain" accessible={false} />
      <View style={[tvCardStyle, styles.card]}>
        <TvTitle style={styles.title}>{t("titleLanguage.question")}</TvTitle>
        <TvBody muted style={styles.body}>
          {t("titleLanguage.intro")}
        </TvBody>
        <View style={styles.list}>
          <MobileChoiceList testID="title-language-list" height={TV_LIST_HEIGHT * scale} choices={titleLanguageChoices(t)} selected={answer} onSelect={setAnswer} />
        </View>
        <View style={styles.foot}>
          <TvPillButton testID="setup-next" variant="primary" label={t("setup.next")} iconEnd={ChevronRight} onPress={() => saveTitleLanguage(answer, "screen")} />
        </View>
      </View>
    </View>
  );
};

/** Sizes in design dp, as the TV's language step (`TvLanguageScreen`), scaled with the TV (UX-TV-13). */
const baseTvStyles = StyleSheet.create({
  screen: { flex: 1, alignItems: "center", paddingTop: 34 },
  mascot: { width: 75, height: 75 },
  card: { width: 430, marginTop: 10, paddingTop: 22, paddingHorizontal: 24, paddingBottom: 20 },
  title: { fontSize: 24, lineHeight: 30 },
  body: { marginTop: 5, fontSize: 11, lineHeight: 15 },
  list: { marginTop: 10, marginHorizontal: -5 },
  foot: { marginTop: 10, flexDirection: "row", justifyContent: "flex-end" },
});
