import React, { useMemo } from "react";
import type { SignOutKeyQuestionText } from "../libraryKey";
import { TvListDialog, type TvListDialogItem } from "./TvListDialog";

type TvSignOutKeyDialogProps = {
  /** The question's words, in the app's own term for the key (`account.signOutKey.*`, `parrot.settings.signOutKey.*`). */
  text: SignOutKeyQuestionText;
  /** Cancel, Back or Close: nothing changes. */
  onCancel: () => void;
  /** The danger confirm: the app signs out. */
  onConfirm: () => void;
};

/**
 * The TV's Sign out question (ACCT-DEV-03), shared by Badger TV and Parrot TV: a TV that holds the library key asks
 * whether it was saved before signing out (`asksKeySavedBeforeSigningOut` decides). A `TvListDialog` with Cancel first,
 * where the focus starts, then the danger confirm. Render it as the last child of a full-size container.
 */
export const TvSignOutKeyDialog = ({ text, onCancel, onConfirm }: TvSignOutKeyDialogProps) => {
  const items = useMemo<TvListDialogItem[]>(
    () => [
      { key: "cancel", label: text.cancel, testID: "tv-signout-key-cancel", onPress: onCancel },
      { key: "confirm", label: text.confirm, danger: true, testID: "tv-signout-key-confirm", onPress: onConfirm },
    ],
    [onCancel, onConfirm, text.cancel, text.confirm],
  );
  return (
    <TvListDialog
      testID="tv-signout-key-dialog"
      title={text.title}
      message={text.body}
      items={items}
      initialFocusKey="cancel"
      onClose={onCancel}
    />
  );
};
