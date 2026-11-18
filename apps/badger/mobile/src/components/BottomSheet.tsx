import React, { memo } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { MobileBottomSheet } from "@space/mobile-shell/bottom-sheet";
import type { PickerSheet } from "./usePickerSheet";

type BottomSheetProps = {
  sheet: PickerSheet;
  children: React.ReactNode;
  testID?: string;
  /** Keep the sheet at its full height whatever its content (a sheet with a search field at its top). */
  fullHeight?: boolean;
  /** The sheet's own look over the shared default. */
  sheetStyle?: StyleProp<ViewStyle>;
};

/**
 * The shared phone bottom sheet (UX-SHEET-01) driven by a `usePickerSheet` state: backdrop tap, Android Back or a drag
 * down closes it, and the `after` given to `sheet.close` runs once it has slid out.
 */
export const BottomSheet = memo(({ sheet, children, testID, fullHeight, sheetStyle }: BottomSheetProps) => (
  <MobileBottomSheet
    visible={sheet.visible}
    onClose={() => sheet.close()}
    onClosed={sheet.closed}
    testID={testID}
    fullHeight={fullHeight}
    sheetStyle={sheetStyle}
  >
    {children}
  </MobileBottomSheet>
));
BottomSheet.displayName = "BottomSheet";
