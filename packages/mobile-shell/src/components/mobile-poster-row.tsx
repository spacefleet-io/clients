import React from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { MobileSectionHeader } from "./mobile-section-header";

type MobilePosterRowProps = {
  title: string;
  icon?: React.ComponentType<{ size?: number; color?: string }>;
  snapInterval?: number;
  onHorizontalTouchStart?: () => void;
  onHorizontalTouchEnd?: () => void;
  children: React.ReactNode;
};

export const MobilePosterRow = ({
  title,
  icon,
  snapInterval,
  onHorizontalTouchStart,
  onHorizontalTouchEnd,
  children,
}: MobilePosterRowProps) => {
  return (
    <View style={styles.section}>
      <MobileSectionHeader title={title} icon={icon} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scroller}
        onTouchStart={onHorizontalTouchStart}
        onTouchEnd={onHorizontalTouchEnd}
        onTouchCancel={onHorizontalTouchEnd}
        {...(snapInterval
          ? { snapToInterval: snapInterval, decelerationRate: "fast" }
          : undefined)}
      >
        {children}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  section: {
    gap: 14,
  },
  scroller: {
    gap: 14,
    paddingRight: 14,
  },
});
