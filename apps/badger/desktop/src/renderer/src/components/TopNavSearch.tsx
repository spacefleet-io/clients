import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BadgerIconButton, badgerTopBarIcons } from "@space/ui/badger";
import { useSearchPaletteShortcut } from "@space/ui";
import { BadgerSearchPalette } from "@space/ui/badger/search-palette";
import { useLibraryActions, useLibraryData } from "@/lib/libraryContext";
import { mediaDetailPath } from "@/lib/mediaDetailRoute";
import MediaImage from "@/components/MediaImage";

/**
 * UX-SEARCH-01: the top bar's Search button and Ctrl+K / Cmd+K open the search palette over the current page;
 * Enter opens the title's page. Its own component so the top bar does not re-render on library changes.
 */
export default function TopNavSearch() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { media } = useLibraryData();
  const { getMediaDetails } = useLibraryActions();
  const [open, setOpen] = useState(false);
  const openPalette = useCallback(() => setOpen(true), []);
  useSearchPaletteShortcut(openPalette);
  const peopleOf = useCallback((id: string) => getMediaDetails(id)?.cast?.map((member) => member.name), [getMediaDetails]);

  return (
    <>
      <BadgerIconButton label={t("nav.search")} icon={badgerTopBarIcons.search} onClick={openPalette} testId="top-nav-search" />
      <BadgerSearchPalette
        open={open}
        onOpenChange={setOpen}
        media={media}
        peopleOf={peopleOf}
        language={i18n.language}
        onOpenTitle={(id) => navigate(mediaDetailPath(id))}
        renderPoster={(path, title) => <MediaImage path={path} alt={title} className="h-full w-full object-cover" />}
      />
    </>
  );
}
