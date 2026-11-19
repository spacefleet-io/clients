import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import { Modal, StyleSheet, Text, View } from "react-native";
import { MobileRenderBoundary } from "@space/mobile-shell/render-boundary";
import { theme } from "../theme/theme";
import { LaunchingMascot } from "./LaunchingMascot";

type LoadingModalOptions = {
  title: string;
  subtitle?: string;
};

type LoadingModalContextValue = {
  showLoading: (options: LoadingModalOptions) => string;
  hideLoading: (token?: string) => void;
};

type LoadingModalState = {
  visible: boolean;
  title: string;
  subtitle?: string;
  token: string | null;
};

const LoadingModalContext = createContext<LoadingModalContextValue | undefined>(undefined);

export const LoadingModalProvider = ({ children }: { children: React.ReactNode }) => {
  const [state, setState] = useState<LoadingModalState>({
    visible: false,
    title: "",
    subtitle: undefined,
    token: null,
  });

  const showLoading = useCallback((options: LoadingModalOptions) => {
    const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setState({
      visible: true,
      title: options.title,
      subtitle: options.subtitle,
      token,
    });
    return token;
  }, []);

  const hideLoading = useCallback((token?: string) => {
    setState((prev) => {
      if (!prev.visible) return prev;
      if (token && prev.token !== token) return prev;
      return { ...prev, visible: false };
    });
  }, []);

  const value = useMemo(() => ({ showLoading, hideLoading }), [showLoading, hideLoading]);

  return (
    <LoadingModalContext.Provider value={value}>
      {children}
      <Modal
        transparent
        visible={state.visible}
        animationType="fade"
        onRequestClose={() => hideLoading(state.token ?? undefined)}
      >
        {/* UX-CRASH-01: a crash inside the loading card closes it; the window guard says why. */}
        <MobileRenderBoundary name="modal:loading" resetKey={state.token} onDismiss={() => hideLoading(state.token ?? undefined)}>
        <View style={styles.backdrop}>
          <LaunchingMascot testID="loading-modal">
            <Text style={styles.title}>{state.title}</Text>
            {state.subtitle ? <Text style={styles.subtitle}>{state.subtitle}</Text> : null}
          </LaunchingMascot>
        </View>
        </MobileRenderBoundary>
      </Modal>
    </LoadingModalContext.Provider>
  );
};

export const useLoadingModal = () => {
  const ctx = useContext(LoadingModalContext);
  if (!ctx) {
    throw new Error("LoadingModalProvider missing");
  }
  return ctx;
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
  },
  title: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
  },
  subtitle: {
    color: theme.colors.textMuted,
    fontSize: 13,
    textAlign: "center",
  },
});
