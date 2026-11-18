export type DetailsLayers = {
  trailerOpen: boolean;
  trailerPickerOpen: boolean;
  playlistPickerOpen: boolean;
  seasonPickerOpen: boolean;
};

export type DetailsBackTarget = "trailer" | "trailerPicker" | "playlistPicker" | "seasonPicker" | "sheet";

/** What Android Back closes on the details page: the topmost open layer, else the page. */
export const detailsBackTarget = ({ trailerOpen, trailerPickerOpen, playlistPickerOpen, seasonPickerOpen }: DetailsLayers): DetailsBackTarget => {
  if (trailerOpen) return "trailer";
  if (trailerPickerOpen) return "trailerPicker";
  if (playlistPickerOpen) return "playlistPicker";
  if (seasonPickerOpen) return "seasonPicker";
  return "sheet";
};
