/**
 * UX-SETUP-08: every first-setup step fits Badger desktop's smallest window (1200x600) with no scrolling, as the
 * library key and "Your profile" steps do. In a window under 700 px high the page starts just under the mascot's
 * overlap, the card is wider (fewer wrapped lines) and its header closer, as on "Your profile"; each step tightens its
 * own rows on top of this.
 */
export const SETUP_PAGE_FIT = "pb-8 pt-32 [@media(max-height:700px)]:pb-4 [@media(max-height:700px)]:pt-16";
export const SETUP_CARD_FIT = [
  "max-w-2xl",
  "[@media(max-height:700px)]:max-w-4xl",
  "[@media(max-height:700px)]:[&_[data-testid=setup-step-bar]]:space-y-2",
  "[@media(max-height:700px)]:[&_div:has(>[data-testid=setup-step-bar])]:pb-3",
].join(" ");
