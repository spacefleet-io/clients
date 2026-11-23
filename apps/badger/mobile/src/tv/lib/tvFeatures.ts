/**
 * What the TV app leaves out (PLAT-TV-02: it plays media and can delete it, nothing more). Pure, so the decision is
 * testable without a TV runtime: callers pass `Platform.isTV`.
 */
export type TvFeature =
  /** Scanning a pairing QR code with the camera (a TV has none; tvOS does not link the camera module). */
  | "cameraScan"
  /** Offline copies: download buttons, the Downloads screen, the downloads settings. */
  | "downloads"
  /**
   * The plan and storage screen. On the phone it is read-only (ACCT-PAY-02: no payment, no pointer to the website); the
   * TV leaves it out altogether (PLAT-TV-02: the subscription is not managed from the TV).
   */
  | "subscription";

/** Features the TV app never offers. */
export const TV_HIDDEN_FEATURES: readonly TvFeature[] = ["cameraScan", "downloads", "subscription"];

/** Whether a feature is offered on this device: everything is on the phone, `TV_HIDDEN_FEATURES` are off on TV. */
export const isFeatureAvailable = (feature: TvFeature, isTV: boolean): boolean =>
  !(isTV && TV_HIDDEN_FEATURES.includes(feature));

/** Every feature mapped to whether it is offered (for logging). */
export const featureAvailability = (isTV: boolean): Record<TvFeature, boolean> => ({
  cameraScan: isFeatureAvailable("cameraScan", isTV),
  downloads: isFeatureAvailable("downloads", isTV),
  subscription: isFeatureAvailable("subscription", isTV),
});

/** Stack routes of the phone app that belong to a hideable feature; every other route exists on TV too. */
export const ROUTE_FEATURE = {
  Subscription: "subscription",
  Downloads: "downloads",
  // PairDevice is not here: on TV it is the typed-code approver (TvApprovePairingScreen), not the camera scanner.
} as const satisfies Record<string, TvFeature>;

export type FeatureRoute = keyof typeof ROUTE_FEATURE;

/** Whether the navigator registers this route on this device. */
export const isRouteAvailable = (route: FeatureRoute, isTV: boolean): boolean =>
  isFeatureAvailable(ROUTE_FEATURE[route], isTV);
