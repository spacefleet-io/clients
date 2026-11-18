import React, { useCallback, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Globe } from "lucide-react-native";
import { useTranslation } from "../i18n";
import { useMobileShellTheme } from "../theme";
import { MobileRenderBoundary } from "./mobile-render-boundary";
import { MobileFlag } from "./mobile-flag";

type LanguageOption = {
  code: string;
  nativeName: string;
};

type MobileLanguageMenuProps = {
  current: string;
  onSelect: (code: string) => void;
  /** Each language with its own name, shown with its flag (UX-I18N-10). */
  languages: readonly LanguageOption[];
};

export const MobileLanguageMenu = ({
  current,
  onSelect,
  languages,
}: MobileLanguageMenuProps) => {
  const theme = useMobileShellTheme();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const handleSelect = useCallback(
    (code: string) => {
      onSelect(code);
      setOpen(false);
    },
    [onSelect],
  );

  return (
    <>
      <Pressable
        style={[styles.trigger, { borderColor: theme.colors.border }]}
        onPress={() => setOpen(true)}
        accessibilityLabel={t("shell.language")}
      >
        <Globe size={16} color={theme.colors.textMuted} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        {/* UX-CRASH-01: a crash inside the menu closes it; the window guard says why. */}
        <MobileRenderBoundary name="modal:language" onDismiss={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={[styles.dropdown, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
            {languages.map((lang) => {
              const isActive = lang.code === current;
              return (
                <Pressable
                  key={lang.code}
                  style={[
                    styles.item,
                    isActive && { backgroundColor: `${theme.colors.accent}22` },
                  ]}
                  onPress={() => handleSelect(lang.code)}
                  testID={`language-option-${lang.code}`}
                  accessibilityRole="button"
                  accessibilityLabel={lang.nativeName}
                >
                  <MobileFlag code={lang.code} width={21} />
                  <Text
                    style={[
                      styles.itemLabel,
                      { color: isActive ? theme.colors.accent : theme.colors.textMuted },
                    ]}
                  >
                    {lang.nativeName}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Pressable>
        </MobileRenderBoundary>
      </Modal>
    </>
  );
};

const styles = StyleSheet.create({
  trigger: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-start",
    alignItems: "flex-end",
    paddingTop: 60,
    paddingRight: 16,
  },
  dropdown: {
    width: 180,
    borderRadius: 14,
    borderWidth: 1,
    padding: 6,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 8,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
  },
  itemLabel: {
    fontSize: 13,
    fontWeight: "700",
  },
});
