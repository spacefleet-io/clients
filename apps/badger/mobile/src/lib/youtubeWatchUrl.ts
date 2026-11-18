/**
 * YouTube's public watch page for a trailer key (META-TRAILER-01): what the phone opens in the YouTube app or the browser
 * when the embedded player fails, and what the TV's "Watch on YouTube" QR code holds.
 */
export const youtubeWatchUrl = (key: string): string => `https://www.youtube.com/watch?v=${encodeURIComponent(key.trim())}`;
