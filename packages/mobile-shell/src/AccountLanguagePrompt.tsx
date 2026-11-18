/**
 * "Which language do you want?" after a sign-in, sign-up or pairing whose account speaks another language than the
 * device (UX-I18N-07, `@space/shared/accountLanguage`). Mount `AccountLanguagePromptHost` once near the app root;
 * `askAccountLanguage` is the `ask` of `reconcileAccountLanguage`. The texts are shown in the device's language and
 * each option is named in itself ("Français", "English") after its flag (UX-I18N-10); closing the dialog keeps the
 * account's language.
 */
import React, { useSyncExternalStore } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import {
  accountLanguageNativeName,
  accountLanguagePrompt,
} from "@space/shared/accountLanguage";
import type { AccountLanguage } from "@space/shared/i18n";
import { useMobileShellTheme } from "./theme";
import { MobileButtonFace } from "./components/mobile-button-face";
import { MobileRenderBoundary } from "./components/mobile-render-boundary";
import { MobileFlag } from "./components/mobile-flag";

export type AccountLanguageChoice = { device: AccountLanguage; account: AccountLanguage };

type PendingAsk = AccountLanguageChoice & { resolve: (language: AccountLanguage) => void };

let pending: PendingAsk | null = null;
let hosts = 0;
const listeners = new Set<() => void>();

const setPending = (next: PendingAsk | null) => {
  pending = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Shows the prompt and resolves with the language picked. Without a mounted host (or with another ask open, which
 * keeps its dialog) it resolves with the account's language: nothing changes.
 */
export const askAccountLanguage = (choice: AccountLanguageChoice): Promise<AccountLanguage> => {
  if (hosts === 0 || pending) {
    console.info("account_language.ask_skipped", JSON.stringify({ ...choice, reason: hosts === 0 ? "no_host" : "busy" }));
    return Promise.resolve(choice.account);
  }
  const { promise, resolve } = Promise.withResolvers<AccountLanguage>();
  setPending({ ...choice, resolve });
  return promise;
};

const answer = (language: AccountLanguage, how: "pick" | "dismiss") => {
  const current = pending;
  if (!current) return;
  console.info("account_language.answered", JSON.stringify({ language, how, device: current.device, account: current.account }));
  setPending(null);
  current.resolve(language);
};

/** The dialog for the pending `askAccountLanguage`. Mount once, above the navigator. */
export const AccountLanguagePromptHost = () => {
  const ask = useSyncExternalStore(subscribe, () => pending);
  const theme = useMobileShellTheme();
  React.useEffect(() => {
    hosts += 1;
    return () => {
      hosts -= 1;
      // The last host left with a question open: keep the account's language.
      if (hosts === 0 && pending) answer(pending.account, "dismiss");
    };
  }, []);
  if (!ask) return null;
  const texts = accountLanguagePrompt(ask.device, ask);
  const dismiss = () => answer(ask.account, "dismiss");
  return (
    <Modal visible transparent animationType="fade" onRequestClose={dismiss}>
      <MobileRenderBoundary name="modal:account-language" onDismiss={dismiss}>
        <Pressable style={styles.backdrop} onPress={dismiss} accessible={false}>
          <Pressable
            testID="account-language-prompt"
            style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}
            onPress={() => {}}
            accessible={false}
          >
            <Text accessibilityRole="header" style={[styles.title, { color: theme.colors.text }]}>
              {texts.title}
            </Text>
            <Text style={[styles.body, { color: theme.colors.textMuted }]}>{texts.body}</Text>
            <View style={styles.actions}>
              <MobileButtonFace
                testID="account-language-device"
                label={accountLanguageNativeName(ask.device)}
                leading={<MobileFlag code={ask.device} />}
                onPress={() => answer(ask.device, "pick")}
              />
              <MobileButtonFace
                testID="account-language-account"
                variant="secondary"
                label={accountLanguageNativeName(ask.account)}
                leading={<MobileFlag code={ask.account} />}
                onPress={() => answer(ask.account, "pick")}
              />
            </View>
          </Pressable>
        </Pressable>
      </MobileRenderBoundary>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 440,
    borderRadius: 20,
    borderWidth: 1,
    padding: 20,
    gap: 14,
  },
  title: {
    fontSize: 18,
    fontWeight: "800",
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
  },
  actions: {
    gap: 10,
    marginTop: 4,
  },
});
