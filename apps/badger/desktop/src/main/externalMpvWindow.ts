export const shouldCreateWindowOnExternalMpvShow = ({
  hasWindow,
  isDestroyed,
}: {
  hasWindow: boolean;
  isDestroyed: boolean;
}) => !hasWindow || isDestroyed;

