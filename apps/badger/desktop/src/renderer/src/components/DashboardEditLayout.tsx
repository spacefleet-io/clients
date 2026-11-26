import { useEffect, useRef, useState, type ReactNode } from "react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Film, Pencil, Plus, Tv, X } from "lucide-react";

import { Button, Card, CardContent, CardHeader } from "@space/ui";
import type { HomeLibraryScope, HomeSectionConfig } from "@space/shared/homeLayout";

type SortableSectionProps = {
  section: HomeSectionConfig;
  title: string;
  icon: ReactNode;
  isEditing: boolean;
  children: ReactNode;
  moviesLabel: string;
  tvLabel: string;
  onRemove: (id: string) => void;
  onEdit: (id: string) => void;
  onToggleLibrary: (section: HomeSectionConfig, library: HomeLibraryScope) => void;
  onSetStyle: (section: HomeSectionConfig, styleId: number) => void;
  styleOptions: { id: number; label: string }[];
};

type DashboardEditLayoutProps = {
  sections: HomeSectionConfig[];
  editingSectionId: string | null;
  moviesLabel: string;
  tvLabel: string;
  styleOptions: { id: number; label: string }[];
  openAddSection: (index: number) => void;
  onRemoveSection: (id: string) => void;
  onToggleLibrary: (section: HomeSectionConfig, library: HomeLibraryScope) => void;
  onSetStyle: (section: HomeSectionConfig, styleId: number) => void;
  onToggleEditingSection: (id: string) => void;
  onReorderSections: (updater: (items: HomeSectionConfig[]) => HomeSectionConfig[]) => void;
  sectionLabel: (section: HomeSectionConfig) => string;
  sectionIcon: (section: HomeSectionConfig) => ReactNode;
  renderSectionRows: (section: HomeSectionConfig) => ReactNode;
};

const SortableSection = ({
  section,
  title,
  icon,
  isEditing,
  children,
  moviesLabel,
  tvLabel,
  onRemove,
  onEdit,
  onToggleLibrary,
  onSetStyle,
  styleOptions,
}: SortableSectionProps) => {
  const [canRender, setCanRender] = useState(false);
  const sectionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (canRender) return;
    const target = sectionRef.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setCanRender(true);
        observer.disconnect();
      },
      { rootMargin: "600px" }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [canRender]);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: section.id,
  });
  const normalizedTransform = transform ? { ...transform, scaleX: 1, scaleY: 1 } : null;
  const style = {
    transform: CSS.Transform.toString(normalizedTransform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} className={`min-w-0 ${isDragging ? "opacity-80" : ""}`}>
      <Card
        className="dashboard-section space-panel relative w-full min-w-0 text-white"
        data-style={section.styleId}
      >
        <div ref={sectionRef} className="absolute inset-0 pointer-events-none" />
        <CardHeader className="space-y-3">
          <div
            className="flex items-center justify-between gap-3 rounded-xl border border-[#30363d] bg-[#0f141b]/80 px-3 py-2 text-xs uppercase tracking-[0.2em] text-[#8b949e] shadow-sm cursor-grab active:cursor-grabbing select-none"
            {...attributes}
            {...listeners}
            aria-label="Reorder section"
          >
            <div className="flex items-center gap-2 text-xs font-semibold">
              {icon}
              <span>{title}</span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="icon"
                variant="secondary"
                className="border border-[#30363d] bg-[#161b22] text-[#ffaa54] hover:bg-[#1a212a]"
                onClick={(event) => {
                  event.stopPropagation();
                  onEdit(section.id);
                }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="secondary"
                className="border border-[#30363d] bg-[#1a1416] text-[#ff7b72] hover:bg-[#221517]"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(section.id);
                }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
          {isEditing ? (
            <div className="space-y-3">
              {section.type !== "genre" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={section.libraries.includes("movies") ? "secondary" : "ghost"}
                    className={section.libraries.includes("movies") ? "border border-[#30363d] bg-[#161b22] text-white" : "text-[#8b949e] hover:text-white"}
                    onClick={() => onToggleLibrary(section, "movies")}
                  >
                    <Film className="mr-2 h-4 w-4" />
                    {moviesLabel}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={section.libraries.includes("tv") ? "secondary" : "ghost"}
                    className={section.libraries.includes("tv") ? "border border-[#30363d] bg-[#161b22] text-white" : "text-[#8b949e] hover:text-white"}
                    onClick={() => onToggleLibrary(section, "tv")}
                  >
                    <Tv className="mr-2 h-4 w-4" />
                    {tvLabel}
                  </Button>
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                {styleOptions.map((option) => (
                  <Button
                    key={option.id}
                    type="button"
                    size="sm"
                    variant={section.styleId === option.id ? "secondary" : "ghost"}
                    className={section.styleId === option.id ? "border border-[#30363d] bg-[#161b22] text-white" : "text-[#8b949e] hover:text-white"}
                    onClick={() => onSetStyle(section, option.id)}
                  >
                    <span className="dashboard-style-dot mr-2" data-style={option.id} />
                    {option.label}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="min-w-0">{canRender ? children : <div className="h-36" />}</CardContent>
      </Card>
    </div>
  );
};

export default function DashboardEditLayout({
  sections,
  editingSectionId,
  moviesLabel,
  tvLabel,
  styleOptions,
  openAddSection,
  onRemoveSection,
  onToggleLibrary,
  onSetStyle,
  onToggleEditingSection,
  onReorderSections,
  sectionLabel,
  sectionIcon,
  renderSectionRows,
}: DashboardEditLayoutProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={(event) => {
        const { active, over } = event;
        if (active.id !== over?.id) {
          onReorderSections((items) => {
            const oldIndex = items.findIndex((item) => item.id === active.id);
            const newIndex = items.findIndex((item) => item.id === over?.id);
            return arrayMove(items, oldIndex, newIndex);
          });
        }
      }}
    >
      <SortableContext items={sections.map((section) => section.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-6">
          {sections.map((section, index) => (
            <div key={section.id} className="space-y-3">
              <div className="flex items-center justify-center">
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-9 w-9 rounded-full border-dashed border-[#30363d] bg-[#0f141b] text-white hover:border-[#ffaa54]/60"
                  onClick={() => openAddSection(index)}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              <SortableSection
                section={section}
                title={sectionLabel(section)}
                icon={sectionIcon(section)}
                isEditing={editingSectionId === section.id}
                moviesLabel={moviesLabel}
                tvLabel={tvLabel}
                onRemove={onRemoveSection}
                onEdit={onToggleEditingSection}
                onToggleLibrary={onToggleLibrary}
                onSetStyle={onSetStyle}
                styleOptions={styleOptions}
              >
                {renderSectionRows(section)}
              </SortableSection>
            </div>
          ))}
          <div className="flex items-center justify-center">
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="h-9 w-9 rounded-full border-dashed border-[#30363d] bg-[#0f141b] text-white hover:border-[#ffaa54]/60"
              onClick={() => openAddSection(sections.length)}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </SortableContext>
    </DndContext>
  );
}
