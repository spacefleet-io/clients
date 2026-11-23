import React, { useState } from "react";
import { StyleSheet, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { MobileAppBackdrop } from "@space/mobile-shell/components";
import { getCurrentLanguage, isMobileUiLanguage, MOBILE_UI_LANGUAGES, useTranslation } from "@space/mobile-shell/i18n";
import { MobileChoiceList, MobileSetupMascot, TV_SETUP_CARD_TOP, TV_SETUP_MASCOT_SIZE, tvChoiceListHeight } from "@space/mobile-shell/setup-step";
import { MobileFlag } from "@space/mobile-shell/flag";
import { scopeLogger } from "@space/mobile-shell/logger";
import { chooseUiLanguage } from "../../lib/uiLanguage";
import { useTvScale, useTvStyles } from "@space/mobile-shell/tv/tvScale";
import { getTvSetup, saveTvSetup } from "../lib/tvSetupStore";
import { tvCardStyle } from "../ui/tokens";
import { TvBody, TvTitle } from "@space/mobile-shell/tv/TvText";
import { TvPillButton } from "@space/mobile-shell/tv/TvPillButton";

const log = scopeLogger("tv.setup");

/** Height of the language list in design dp: every app language as a whole row, none left to scroll to (UX-SETUP-08). */
const LIST_HEIGHT = tvChoiceListHeight(MOBILE_UI_LANGUAGES.length);

/**
 * Badger TV's step 0 (UX-SETUP-08, UX-TV-32): "Choose your language" before the sign-in, with no "step N of M". The
 * badger over the top border of one card (the phone's setup mascot, at the TV's size): the title, one line, the
 * languages as rows the remote moves through, all five in view (a longer list would scroll, UX-LIST-01), starting on
 * the TV's language (UX-I18N-01), and Next at the bottom right. A pick switches the app at once,
 * so the sign-in is already in it (kept on this TV, the account takes it after the sign-in, UX-I18N-07). Next marks
 * the language as chosen and the navigator shows the sign-in.
 */
export const TvLanguageScreen = () => {
  const { t } = useTranslation();
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const [language, setLanguage] = useState(() => getCurrentLanguage());
  const [busy, setBusy] = useState(false);
  return (
    <View style={styles.screen} testID="tv-language">
      <MobileAppBackdrop />
      <MobileSetupMascot size={TV_SETUP_MASCOT_SIZE * scale} testID="tv-language-mascot" />
      <View style={[tvCardStyle, styles.card]} testID="tv-language-card">
        <TvTitle style={styles.title}>{t("setup.language.title")}</TvTitle>
        <TvBody muted style={styles.body}>
          {t("setup.language.body")}
        </TvBody>
        <View style={styles.list}>
          <MobileChoiceList
            testID="setup-language-list"
            height={LIST_HEIGHT * scale}
            choices={MOBILE_UI_LANGUAGES.map((option) => ({ value: option.code, label: option.nativeName, lead: <MobileFlag code={option.code} /> }))}
            selected={language}
            onSelect={(code) => {
              setLanguage(code);
              log.info("language.pick", { language: code });
              if (isMobileUiLanguage(code)) void chooseUiLanguage(code, { pushToAccount: false });
            }}
          />
        </View>
        <View style={styles.foot} testID="tv-language-foot">
          <TvPillButton
            testID="setup-next"
            variant="primary"
            label={t("setup.next")}
            iconEnd={ChevronRight}
            disabled={busy}
            onPress={() => {
              const progress = getTvSetup();
              if (!progress) return;
              setBusy(true);
              log.info("language.chosen", { language });
              void saveTvSetup({ ...progress, step: "signIn", language }).finally(() => setBusy(false));
            }}
          />
        </View>
      </View>
    </View>
  );
};

/** Sizes in design dp: the approved mockup (`tv-language.html`, 1920x1080 px) halved, scaled with the TV (UX-TV-13). */
const baseStyles = StyleSheet.create({
  screen: { flex: 1, alignItems: "center", justifyContent: "center" },
  card: { width: 430, paddingTop: TV_SETUP_CARD_TOP, paddingHorizontal: 24, paddingBottom: 20 },
  title: { fontSize: 24, lineHeight: 30 },
  body: { marginTop: 5, fontSize: 11, lineHeight: 15 },
  // The rows' ring room (5 dp) is inside the list: pulled out so the rows line up with the title.
  list: { marginTop: 10, marginHorizontal: -5 },
  foot: { marginTop: 10, flexDirection: "row", justifyContent: "flex-end" },
});
