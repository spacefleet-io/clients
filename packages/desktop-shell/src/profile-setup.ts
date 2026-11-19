/** UX-SETUP-10 / UX-UPDATE-01: the "Your profile" step, the "New in this update" windows and their feature registry. */
export {
  AVATARS_FEATURE_ART,
  AvatarRowArt,
  ProfileSetupStep,
  WhatsNewWindow,
  saveProfileSetup,
  withBoldName,
  type ProfileSetupAnswer,
  type ProfileSetupStepProps,
  type WhatsNewWindowProps,
} from "./components/profile-setup";
export {
  AVATARS_UPDATE_FEATURE,
  UPDATE_FEATURES,
  UpdateFeaturesHost,
  needsProfileSetupStep,
  pendingUpdateWindows,
  useUpdateFeatures,
  type UpdateFeature,
  type UpdateFeatureScreenProps,
  type UpdateFeaturesHostProps,
} from "./components/update-features";
