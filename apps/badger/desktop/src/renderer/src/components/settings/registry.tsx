import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import {
  Clapperboard,
  Cog,
  Cpu,
  Database,
  Download,
  Film,
  Info,
  MonitorSmartphone,
  Play,
  Plug,
  ShieldCheck,
  SlidersHorizontal,
  User,
  Users,
  type LucideIcon,
} from "lucide-react";

export type SettingsSectionId =
  | "general"
  | "playback"
  | "trailers"
  | "downloads"
  | "transcoding"
  | "metadata"
  | "performance"
  | "account"
  | "profiles"
  | "security"
  | "devices"
  | "connectedTools"
  | "system"
  | "about";

export type SettingsGroupId = "player" | "library" | "account" | "system";

export interface SettingsSectionDef {
  id: SettingsSectionId;
  group: SettingsGroupId;
  icon: LucideIcon;
  /** The lazily-loaded section body (renders panels only; the shell renders the header). */
  Component: LazyExoticComponent<ComponentType>;
}

export interface SettingsGroupDef {
  id: SettingsGroupId;
  sections: SettingsSectionId[];
}

const GeneralSection = lazy(() => import("./sections/GeneralSection"));
const PlaybackSection = lazy(() => import("./sections/PlaybackSection"));
const TrailersSection = lazy(() => import("./sections/TrailersSection"));
const DownloadsSection = lazy(() => import("./sections/DownloadsSection"));
const TranscodingSection = lazy(() => import("./sections/TranscodingSection"));
const MetadataSection = lazy(() => import("./sections/MetadataSection"));
const PerformanceSection = lazy(() => import("./sections/PerformanceSection"));
const AccountSection = lazy(() => import("./sections/AccountSection"));
const ProfilesSection = lazy(() => import("./sections/ProfilesSection"));
const SecuritySection = lazy(() => import("./sections/SecuritySection"));
const DevicesSection = lazy(() => import("./sections/DevicesSection"));
const ConnectedToolsSection = lazy(() => import("./sections/ConnectedToolsSection"));
const SystemSection = lazy(() => import("./sections/SystemSection"));
const AboutSection = lazy(() => import("./sections/AboutSection"));

export const SETTINGS_SECTIONS: SettingsSectionDef[] = [
  { id: "general", group: "player", icon: SlidersHorizontal, Component: GeneralSection },
  { id: "playback", group: "player", icon: Play, Component: PlaybackSection },
  { id: "trailers", group: "player", icon: Clapperboard, Component: TrailersSection },
  { id: "downloads", group: "player", icon: Download, Component: DownloadsSection },
  { id: "transcoding", group: "library", icon: Film, Component: TranscodingSection },
  { id: "metadata", group: "library", icon: Database, Component: MetadataSection },
  { id: "performance", group: "library", icon: Cpu, Component: PerformanceSection },
  { id: "account", group: "account", icon: User, Component: AccountSection },
  { id: "profiles", group: "account", icon: Users, Component: ProfilesSection },
  { id: "security", group: "account", icon: ShieldCheck, Component: SecuritySection },
  { id: "devices", group: "account", icon: MonitorSmartphone, Component: DevicesSection },
  { id: "connectedTools", group: "account", icon: Plug, Component: ConnectedToolsSection },
  { id: "system", group: "system", icon: Cog, Component: SystemSection },
  { id: "about", group: "system", icon: Info, Component: AboutSection },
];

export const SETTINGS_GROUPS: SettingsGroupDef[] = [
  { id: "player", sections: ["general", "playback", "trailers", "downloads"] },
  { id: "library", sections: ["transcoding", "metadata", "performance"] },
  { id: "account", sections: ["account", "profiles", "security", "devices", "connectedTools"] },
  { id: "system", sections: ["system", "about"] },
];

export const DEFAULT_SECTION: SettingsSectionId = "general";

export const isSettingsSectionId = (value: unknown): value is SettingsSectionId =>
  typeof value === "string" && SETTINGS_SECTIONS.some((section) => section.id === value);

export const getSectionDef = (id: SettingsSectionId): SettingsSectionDef =>
  SETTINGS_SECTIONS.find((section) => section.id === id) ?? SETTINGS_SECTIONS[0];
