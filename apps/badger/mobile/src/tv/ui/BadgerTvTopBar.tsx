import React from "react";
import { ListVideo } from "lucide-react-native";
import { TvTopBar, type TvTopBarProps } from "@space/mobile-shell/tv/TvTopBar";

const BADGER_ICON = require("../../assets/badger-icon.png");

/** The family's TV top bar (UX-TV-09) with Badger's mark and its video-list Playlists icon. */
export const BadgerTvTopBar = (props: Omit<TvTopBarProps, "brandIcon" | "playlistsIcon">) => (
  <TvTopBar brandIcon={BADGER_ICON} playlistsIcon={ListVideo} {...props} />
);
