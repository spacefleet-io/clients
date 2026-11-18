import React from "react";
import { Image, type ImageStyle, type StyleProp } from "react-native";
import { PROFILE_AVATAR_SOURCES } from "@space/profile-avatars/native";
import { profileAvatarIdOf, type ProfileAvatarId } from "@space/shared/profileAvatars";
import type { ApiProfile } from "@space/shared/profiles";

/** A rounded square, a fifth of the size: the avatar tiles' own shape (ACCT-PROF-05). */
export const profileAvatarRadius = (size: number) => Math.round(size / 5);

/**
 * One picture of the avatar pack (ACCT-PROF-05) on Badger's phone and TV and Parrot's phone: the profile's avatar
 * (`profile`, a row from before the pack reads as its colour's avatar) or one avatar by id (`avatarId`, the chooser).
 * `size` is on-screen; the TV passes it already scaled.
 */
export const ProfileAvatarImage = ({
  profile,
  avatarId,
  size,
  style,
  testID = "profile-avatar",
}: {
  profile?: Pick<ApiProfile, "avatar" | "avatarId">;
  avatarId?: ProfileAvatarId;
  size: number;
  style?: StyleProp<ImageStyle>;
  testID?: string;
}) => {
  const id = avatarId ?? (profile ? profileAvatarIdOf(profile) : "badger");
  return (
    <Image
      testID={testID}
      source={PROFILE_AVATAR_SOURCES[id]}
      // Decorative: the name next to it, or the chooser cell's own label, says who or what it is.
      accessible={false}
      style={[{ width: size, height: size, borderRadius: profileAvatarRadius(size) }, style]}
    />
  );
};
