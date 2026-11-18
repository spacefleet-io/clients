import React, { useState } from "react";
import { Modal, Platform, StyleSheet, View } from "react-native";
import { MobileSkyLayer } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { MobileRenderBoundary } from "@space/mobile-shell/render-boundary";
import { MobileSetupChoices, MobileSetupStep } from "@space/mobile-shell/setup-step";
import { answerConsent, useSelfUpdate } from "./controller";
import { selfUpdateText, type SelfUpdateStringKey } from "./strings";

type Answer = "yes" | "no";

/**
 * The answer the consent step starts on. F-Droid Inclusion Policy §5 asks for the user's consent before an app updates
 * itself; if a reviewer finds a preselected Yes not enough, `null` makes the user pick before Next (REL-UPD-06).
 */
export const CONSENT_PRESELECTED: Answer | null = "yes";

/**
 * REL-UPD-06: "Keep Badger up to date?" on a hand-installed Android app, phone and TV, mounted once at each app's
 * root. It covers the app the first time it starts (and once for an install that predates it), as a setup step
 * without numbering, until the user answers; nothing reaches our repository before then. The answer is the
 * "Update automatically" switch in Settings › About. On a TV the remote starts on Next.
 */
export const SelfUpdateConsent = () => {
  const { i18n } = useTranslation();
  const { app, consentPending } = useSelfUpdate();
  const [answer, setAnswer] = useState<Answer | null>(CONSENT_PRESELECTED);
  const [busy, setBusy] = useState(false);
  if (!app || !consentPending) return null;
  const text = (key: SelfUpdateStringKey) => selfUpdateText(i18n.language, key, { app: app === "badger" ? "Badger" : "Parrot" });
  const next = () => {
    if (!answer) return;
    setBusy(true);
    void answerConsent(answer === "yes").finally(() => setBusy(false));
  };
  return (
    <Modal visible transparent={false} animationType="none" onRequestClose={() => undefined} supportedOrientations={["portrait", "landscape"]}>
      <MobileRenderBoundary name="modal:self-update-consent">
        <MobileSkyLayer>
          <View style={styles.fill} testID="self-update-consent">
            <MobileSetupStep
              step={0}
              total={0}
              header={null}
              title={text("consentTitle")}
              body={text("consentBody")}
              onNext={next}
              nextDisabled={!answer}
              busy={busy}
              nextPreferredFocus={Platform.isTV === true}
            >
              <MobileSetupChoices
                choices={[
                  { value: "yes", label: text("consentYes") },
                  { value: "no", label: text("consentNo") },
                ]}
                selected={answer}
                onSelect={setAnswer}
              />
            </MobileSetupStep>
          </View>
        </MobileSkyLayer>
      </MobileRenderBoundary>
    </Modal>
  );
};

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
