import { useParams } from "react-router-dom";
import TopNav from "@/components/TopNav";
import MediaDetailsDialog from "@/components/MediaDetailsDialog";
import { useMediaDetailHistory } from "@/lib/mediaDetailHistory";

/**
 * A film or show opens as its own page (LIB-DETAIL-01), not a modal. Back returns to where it was opened from, or to
 * the library when the page was the first one shown (a restored route).
 */
export default function MediaDetail() {
  const { id } = useParams();
  const { back } = useMediaDetailHistory();
  return (
    <div className="min-h-screen">
      <TopNav />
      <MediaDetailsDialog selectedId={id ?? null} onClose={back} />
    </div>
  );
}
