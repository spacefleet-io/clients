/** The params the detail page reads itself: the open trailer and a playback deep link. */
const DETAIL_PAGE_PARAMS = ["trailer", "player", "episode"] as const;

/**
 * The detail page of a film or show (LIB-DETAIL-01). Library and Home still open a title by setting `?media=<id>`
 * (old links, restored routes and tests keep working); they redirect here, carrying the params the page reads.
 */
export const mediaDetailPath = (id: string, params?: URLSearchParams): string => {
  const carried = new URLSearchParams();
  for (const key of DETAIL_PAGE_PARAMS) {
    const value = params?.get(key);
    if (value) carried.set(key, value);
  }
  const query = carried.toString();
  return `/media/${encodeURIComponent(id)}${query ? `?${query}` : ""}`;
};
