/** "4:07": time left on a pairing code; never negative. */
export const formatCountdown = (remainingMs: number): string => {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};
