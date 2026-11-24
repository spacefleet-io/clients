/**
 * The profile screens shared by the apps on the web stack (REL-FAM-02): "Who's watching?" (UX-PROF-01), the
 * profiles manager that adds, edits and deletes (ACCT-PROF-01, ACCT-PROF-02) with the avatar chooser (ACCT-PROF-05),
 * and the top bar's avatar menu (UX-TOP-01). The app brings its profile store (`createProfileStore` of
 * `@space/shared/profileStore`), its delete (which runs the library's data moves), its log and its `t`; the words are
 * the `profiles.*` texts every app loads (`withProfilesTexts`).
 */
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from "react";
import { Check, ChevronDown, Plus } from "lucide-react";
import { PROFILE_AVATAR_URLS } from "@space/profile-avatars/web";
import { PROFILE_AVATAR_IDS, nextProfileAvatarId, profileAvatarIdOf, type ProfileAvatarId } from "@space/shared/profileAvatars";
import { MAX_PROFILES_FREE, MAX_PROFILES_PAID, PROFILE_ERRORS, canCreateProfile, canDeleteProfile, normalizeProfileName, type ApiProfile } from "@space/shared/profiles";
import { isClientUiLanguage } from "@space/shared/i18n";
import {
  NO_LIBRARY_MOVES,
  ProfileActionError,
  profileErrorKey,
  type ProfileErrorCode,
  type ProfileStore,
  type ProfilesSnapshot,
} from "@space/shared/profileStore";
import { profilesTranslator } from "@space/shared/profileTexts";
import { Button } from "./button";
import { Input } from "./input";
import { cn } from "./utils";

export type ProfilesText = (key: string, options?: Record<string, unknown>) => string;
export type ProfilesLog = (event: string, data: Record<string, unknown>) => void;

/** What the profile screens need from the app. */
export type ProfilesScreenDeps = {
  store: ProfileStore;
  /** ACCT-PROF-02: the API delete plus this device's library data move (refused `offline` without an open library). */
  deleteProfile: (profileId: string) => Promise<void>;
  log: ProfilesLog;
  t: ProfilesText;
};

export const useProfilesSnapshot = (store: ProfileStore): ProfilesSnapshot =>
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

export type ProfileAvatarSize = "sm" | "md" | "lg" | "xl";

/** 32px in menus and lists, 40px in the top bar's menu rows, 96px for the chooser's preview, 160px on "Who's watching?". */
const AVATAR_SIZE_CLASS: Record<ProfileAvatarSize, string> = {
  sm: "h-8 w-8 rounded-lg",
  md: "h-10 w-10 rounded-lg",
  lg: "h-24 w-24 rounded-2xl",
  xl: "h-40 w-40 rounded-3xl",
};

/**
 * A profile's avatar (ACCT-PROF-05): its picture from the pack, the 64px file up to 32px and the 256px one above. A
 * profile from before the pack reads as the avatar of its colour. The name is always written next to it, so the
 * picture itself is hidden from screen readers.
 */
export function ProfileAvatar({
  profile,
  size,
  className,
}: {
  profile: Pick<ApiProfile, "avatar"> & { avatarId?: ProfileAvatarId | null };
  size: ProfileAvatarSize;
  className?: string;
}) {
  const id = profileAvatarIdOf(profile);
  const urls = PROFILE_AVATAR_URLS[id];
  return (
    <img
      aria-hidden
      alt=""
      draggable={false}
      data-testid="profile-avatar"
      data-avatar={id}
      src={size === "sm" ? urls.small : urls.large}
      className={cn("shrink-0 select-none object-cover", AVATAR_SIZE_CLASS[size], className)}
    />
  );
}

/**
 * The avatar chooser (ACCT-PROF-05): the whole pack as one flat grid, no categories and no upload. Each tile is named
 * for screen readers ("Fox"). `tiles` (the manager): four columns of rounded squares, the picked one with an accent
 * ring and a tick. `round` (the "Your profile" step, UX-SETUP-10): rows of round avatars, the picked one with a thick
 * accent ring and no tick, as drawn for the phones; 52px, 44px with closer rows in a window 640px high or less, so the step
 * fits the smallest window (UX-SETUP-08); on a narrow phone browser the six columns shrink to the card's width.
 */
export function AvatarChooser({
  value,
  onChange,
  t,
  variant = "tiles",
  disabled,
}: {
  value: ProfileAvatarId;
  onChange: (id: ProfileAvatarId) => void;
  t: ProfilesText;
  variant?: "tiles" | "round";
  disabled?: boolean;
}) {
  const round = variant === "round";
  return (
    <ul
      aria-label={t("profiles.chooseAvatar")}
      className={
        round
          ? "grid grid-cols-6 justify-items-center gap-2.5 sm:grid-cols-11 sm:gap-3.5 [@media(max-height:640px)]:gap-2.5"
          : "grid grid-cols-4 gap-3"
      }
      data-testid="avatar-chooser"
      data-variant={variant}
    >
      {PROFILE_AVATAR_IDS.map((id) => {
        const picked = id === value;
        return (
          <li key={id} className={round ? "flex w-full justify-center" : undefined}>
            <button
              type="button"
              aria-pressed={picked}
              aria-label={t(`profiles.avatars.${id}`)}
              title={t(`profiles.avatars.${id}`)}
              data-testid={`avatar-option-${id}`}
              disabled={disabled}
              onClick={() => onChange(id)}
              className={cn(
                "relative block outline-none transition focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed",
                round ? "aspect-square w-full max-w-13 rounded-full [@media(max-height:640px)]:max-w-11" : "w-full rounded-2xl",
                picked
                  ? round
                    ? "ring-4 ring-primary ring-offset-[3px] ring-offset-card focus-visible:ring-4 focus-visible:ring-primary"
                    : "ring-[3px] ring-primary ring-offset-2 ring-offset-background"
                  : "hover:opacity-90",
              )}
            >
              <img
                src={PROFILE_AVATAR_URLS[id].large}
                alt=""
                draggable={false}
                className={cn("aspect-square w-full select-none object-cover", round ? "rounded-full" : "rounded-2xl")}
              />
              {picked && !round && (
                <span aria-hidden className="absolute -right-2 -top-2 grid h-6 w-6 place-items-center rounded-full bg-primary text-primary-foreground shadow">
                  <Check className="h-4 w-4" strokeWidth={3} />
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The steps of managing profiles (ACCT-PROF-01, ACCT-PROF-02), in Settings and from "Who's watching?". */
export type ProfilesManagerMode =
  | { name: "list" }
  | { name: "edit"; profileId: string | null }
  | { name: "confirmDelete"; profileId: string }
  | { name: "busy" };

/**
 * Create, edit (name and avatar) and delete, each profile treated the same (any one can be deleted while another
 * remains). A refused change shows the API's reason (`profiles.errors.*`, e.g. 409 `last_profile`) and goes back to
 * the step it came from. `startWith: "add"` opens straight on a new profile (the "Add profile" tile and menu item).
 */
export const useProfilesManager = ({ store, deleteProfile, log, startWith }: Omit<ProfilesScreenDeps, "t"> & { startWith?: "add" }) => {
  const snapshot = useProfilesSnapshot(store);
  const openOnAdd = startWith === "add" && store.canCreate();
  const [mode, setModeState] = useState<ProfilesManagerMode>(() => (openOnAdd ? { name: "edit", profileId: null } : { name: "list" }));
  const [draftName, setDraftName] = useState("");
  // A new profile starts with the first avatar in pack order that no profile of the account uses (ACCT-PROF-05).
  const [draftAvatarId, setDraftAvatarId] = useState<ProfileAvatarId>(() => nextProfileAvatarId(store.getSnapshot().profiles.map(profileAvatarIdOf)));
  // A full account never opens the form (the API would refuse it): the list shows why "Add profile" is unavailable.
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const setMode = useCallback(
    (next: ProfilesManagerMode) => {
      log("profiles.manager.mode", { mode: next.name, ...("profileId" in next ? { profileId: next.profileId } : {}) });
      setModeState(next);
    },
    [log],
  );

  const fail = useCallback(
    (error: unknown, back: ProfilesManagerMode, step: string) => {
      const code: ProfileErrorCode = error instanceof ProfileActionError ? error.code : "unknown";
      log("profiles.manager.failed", { step, code });
      setErrorKey(profileErrorKey(code));
      setMode(back);
    },
    [log, setMode],
  );

  const startAdd = useCallback(() => {
    setErrorKey(null);
    if (!store.canCreate()) {
      log("profiles.manager.add_refused", { count: snapshot.profiles.length, maxProfiles: snapshot.maxProfiles });
      return;
    }
    setDraftName("");
    setDraftAvatarId(nextProfileAvatarId(snapshot.profiles.map(profileAvatarIdOf)));
    setMode({ name: "edit", profileId: null });
  }, [log, setMode, snapshot.maxProfiles, snapshot.profiles, store]);

  const startEdit = useCallback(
    (profile: ApiProfile) => {
      setErrorKey(null);
      setDraftName(profile.name);
      setDraftAvatarId(profileAvatarIdOf(profile));
      setMode({ name: "edit", profileId: profile.id });
    },
    [setMode],
  );

  /** Resolves `true` once the profile is saved, `false` when it was refused (the reason is shown). */
  const save = useCallback(async (): Promise<boolean> => {
    if (mode.name !== "edit") return false;
    if (!normalizeProfileName(draftName)) {
      setErrorKey(profileErrorKey(PROFILE_ERRORS.invalid));
      return false;
    }
    const editing = mode;
    setErrorKey(null);
    setMode({ name: "busy" });
    try {
      if (editing.profileId) {
        await store.editProfile(editing.profileId, { name: draftName, avatarId: draftAvatarId });
        log("profiles.manager.edited", { profileId: editing.profileId, avatarId: draftAvatarId });
      } else {
        // The user picked the avatar here, so the profile never gets the avatars setup step or update window (UX-SETUP-10).
        const created = await store.createProfile(draftName, draftAvatarId, { avatars: "set" });
        log("profiles.manager.created", { profileId: created.id, avatarId: draftAvatarId, count: store.getSnapshot().profiles.length });
      }
      setMode({ name: "list" });
      return true;
    } catch (error) {
      fail(error, editing, editing.profileId ? "edit" : "create");
      return false;
    }
  }, [draftAvatarId, draftName, fail, log, mode, setMode, store]);

  const askDelete = useCallback(
    (profile: ApiProfile) => {
      setErrorKey(null);
      if (!canDeleteProfile(snapshot.profiles.length)) {
        log("profiles.manager.delete_refused", { profileId: profile.id });
        setErrorKey(profileErrorKey(PROFILE_ERRORS.last));
        return;
      }
      setMode({ name: "confirmDelete", profileId: profile.id });
    },
    [log, setMode, snapshot.profiles.length],
  );

  const confirmDelete = useCallback(async () => {
    if (mode.name !== "confirmDelete") return;
    const { profileId } = mode;
    setMode({ name: "busy" });
    try {
      await deleteProfile(profileId);
      log("profiles.manager.deleted", { profileId, remaining: store.getSnapshot().profiles.length });
      setMode({ name: "list" });
    } catch (error) {
      fail(error, { name: "list" }, "delete");
    }
  }, [deleteProfile, fail, log, mode, setMode, store]);

  const cancel = useCallback(() => {
    setErrorKey(null);
    setMode({ name: "list" });
  }, [setMode]);

  return {
    snapshot,
    mode,
    draftName,
    setDraftName,
    draftAvatarId,
    setDraftAvatarId,
    errorKey,
    profileOf: (id: string | null) => snapshot.profiles.find((p) => p.id === id) ?? null,
    startAdd,
    startEdit,
    save,
    askDelete,
    confirmDelete,
    cancel,
  };
};

/**
 * Where the manager is opened from: `startWith: "add"` opens on a new profile and `onAddDone` runs when it is saved or
 * cancelled. `plansLink`: where the app shows its plans (the website's billing page), linked from a free account's
 * limit note; without it the note only says why.
 */
export type ProfilesManagerProps = ProfilesScreenDeps & {
  startWith?: "add";
  onAddDone?: () => void;
  plansLink?: { href: string; onClick?: (event: MouseEvent<HTMLAnchorElement>) => void };
};

/**
 * Add, edit and delete the account's profiles (ACCT-PROF-01, ACCT-PROF-02); editing changes the name and the avatar
 * (ACCT-PROF-05). Every profile has the same actions and looks the same: nothing marks the one whose data the library
 * keeps in its own storage, and there is no kids mode. A delete always asks first.
 */
export function ProfilesManager({ t, onAddDone, plansLink, ...deps }: ProfilesManagerProps) {
  const manager = useProfilesManager(deps);
  const { snapshot, mode } = manager;
  const busy = mode.name === "busy";
  // A refused add on Free reads the free note: "its 1 profiles" says nothing about why.
  const errorText =
    manager.errorKey === profileErrorKey(PROFILE_ERRORS.limit) && snapshot.maxProfiles <= MAX_PROFILES_FREE
      ? t("profiles.limitFree", { paidMax: MAX_PROFILES_PAID })
      : manager.errorKey
        ? t(manager.errorKey, { max: snapshot.maxProfiles })
        : null;
  const error = errorText ? (
    <p data-testid="profiles-error" role="alert" className="text-sm text-destructive">
      {errorText}
    </p>
  ) : null;

  if (mode.name === "edit") {
    const editing = manager.profileOf(mode.profileId);
    const finishAdd = !editing && deps.startWith === "add" ? onAddDone : undefined;
    return (
      <form
        data-testid="profile-edit"
        className="mx-auto w-full max-w-lg space-y-5 rounded-xl border border-border bg-card/40 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void manager.save().then((saved) => {
            if (saved) finishAdd?.();
          });
        }}
      >
        <h3 className="text-center text-lg font-semibold">{editing ? t("profiles.editTitle") : t("profiles.addTitle")}</h3>
        <div className="flex justify-center">
          <img
            data-testid="profile-avatar-preview"
            data-avatar={manager.draftAvatarId}
            src={PROFILE_AVATAR_URLS[manager.draftAvatarId].large}
            alt={t("profiles.avatarLabel", { name: t(`profiles.avatars.${manager.draftAvatarId}`) })}
            draggable={false}
            className="h-24 w-24 select-none rounded-2xl object-cover"
          />
        </div>
        <label className="block space-y-1 text-sm">
          <span className="text-muted-foreground">{t("profiles.nameLabel")}</span>
          <Input
            data-testid="profile-name-input"
            autoFocus
            maxLength={40}
            value={manager.draftName}
            placeholder={t("profiles.namePlaceholder")}
            onChange={(event) => manager.setDraftName(event.target.value)}
          />
        </label>
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">{t("profiles.chooseAvatar")}</p>
          <AvatarChooser value={manager.draftAvatarId} onChange={manager.setDraftAvatarId} t={t} />
        </div>
        {error}
        <div className="flex gap-2">
          <Button data-testid="profile-save" type="submit" disabled={!manager.draftName.trim()}>
            {t("profiles.save")}
          </Button>
          <Button
            data-testid="profile-cancel"
            type="button"
            variant="ghost"
            onClick={() => {
              manager.cancel();
              finishAdd?.();
            }}
          >
            {t("profiles.cancel")}
          </Button>
        </div>
      </form>
    );
  }

  if (mode.name === "confirmDelete") {
    const target = manager.profileOf(mode.profileId);
    return (
      <div role="alertdialog" aria-labelledby="profile-delete-title" className="space-y-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4">
        <h3 id="profile-delete-title" className="font-semibold">
          {t("profiles.deleteTitle", { name: target?.name ?? "" })}
        </h3>
        <p className="text-sm text-muted-foreground">{t("profiles.deleteBody")}</p>
        <div className="flex gap-2">
          {/* Cancel first and focused: a stray Enter keeps the profile. */}
          <Button data-testid="profile-delete-cancel" type="button" variant="outline" autoFocus onClick={manager.cancel}>
            {t("profiles.cancel")}
          </Button>
          <Button data-testid="profile-delete-confirm" type="button" variant="destructive" onClick={() => void manager.confirmDelete()}>
            {t("profiles.deleteConfirm")}
          </Button>
        </div>
      </div>
    );
  }

  // From the snapshot, never `store.canCreate()` in render: the React Compiler keeps that call's first answer, since
  // `store` never changes.
  const full = !canCreateProfile(snapshot.profiles.length, snapshot.maxProfiles);
  // The last profile's Delete stays in view greyed (idle colour at half opacity); hovering it, or a tap, gives the reason
  // (ACCT-PROF-02).
  const lone = !canDeleteProfile(snapshot.profiles.length);
  const loneReason = lone ? t(profileErrorKey(PROFILE_ERRORS.last)) : undefined;
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card/40">
        {snapshot.profiles.map((profile) => (
          // On a narrow screen the actions go under the name rather than cutting it to a few letters.
          <li key={profile.id} data-testid={`profile-row-${profile.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
            <ProfileAvatar profile={profile} size="md" />
            <span className="min-w-32 flex-1 truncate font-medium">{profile.name}</span>
            <div className="ml-auto flex shrink-0 gap-1">
              <Button
                data-testid={`profile-edit-${profile.id}`}
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label={t("profiles.editA11y", { name: profile.name })}
                onClick={() => manager.startEdit(profile)}
              >
                {t("profiles.edit")}
              </Button>
              <Button
                data-testid={`profile-delete-${profile.id}`}
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-disabled={lone || undefined}
                title={loneReason}
                className="text-destructive aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-destructive"
                aria-label={t("profiles.deleteA11y", { name: profile.name })}
                onClick={() => manager.askDelete(profile)}
              >
                {t("profiles.delete")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {error}
      {/* A full account keeps "Add profile" in view, greyed, with the reason under it (ACCT-PROF-01). */}
      <Button data-testid="profile-add" type="button" variant="outline" disabled={busy || full} onClick={manager.startAdd}>
        {t("profiles.add")}
      </Button>
      {full ? (
        <p data-testid="profile-add-limit" className="text-sm text-muted-foreground">
          {snapshot.maxProfiles <= MAX_PROFILES_FREE
            ? t("profiles.limitFree", { paidMax: MAX_PROFILES_PAID })
            : t("profiles.errors.limit", { max: snapshot.maxProfiles })}
          {snapshot.maxProfiles <= MAX_PROFILES_FREE && plansLink ? (
            <>
              {" "}
              <a data-testid="profile-see-plans" href={plansLink.href} onClick={plansLink.onClick} className="font-medium text-primary underline-offset-4 hover:underline">
                {t("profiles.seePlans")}
              </a>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

/**
 * "Who's watching?" (UX-PROF-01): the profiles as avatar tiles, one click opens the app as that profile with no
 * sign-in; an "Add profile" tile while the account has room (ACCT-PROF-01) opens the manager on a new profile, and
 * "Manage profiles" turns the tiles into the manager. The app places it (the desktop over everything, the web player
 * under its top bar) and refreshes the list when it shows it.
 */
export function WhoIsWatchingPanel(deps: ProfilesScreenDeps) {
  const { store, log, t } = deps;
  const snapshot = useProfilesSnapshot(store);
  const [managing, setManaging] = useState<false | "list" | "add">(false);
  const tileClass = "group flex w-44 flex-col items-center gap-3 rounded-3xl p-1 outline-none";
  const ringClass =
    "rounded-3xl ring-offset-4 ring-offset-background transition group-hover:ring-[3px] group-hover:ring-foreground group-focus-visible:ring-[3px] group-focus-visible:ring-foreground";
  return (
    <>
      <h1 className="text-5xl font-bold">{managing ? t("profiles.manageTitle") : t("profiles.whoIsWatching")}</h1>
      {managing ? (
        <div className="w-full max-w-lg space-y-4">
          <ProfilesManager
            {...deps}
            startWith={managing === "add" ? "add" : undefined}
            onAddDone={() => setManaging(false)}
          />
          <Button data-testid="profiles-manage-done" type="button" onClick={() => setManaging(false)}>
            {t("profiles.done")}
          </Button>
        </div>
      ) : (
        <>
          <ul className="flex flex-wrap justify-center gap-8">
            {snapshot.profiles.map((profile) => (
              <li key={profile.id}>
                <button
                  type="button"
                  data-testid={`profile-tile-${profile.id}`}
                  data-profile={profile.id}
                  className={tileClass}
                  onClick={() => {
                    log("profiles.picker.selected", { profileId: profile.id, index: snapshot.profiles.indexOf(profile) });
                    void store.selectProfile(profile.id);
                  }}
                >
                  <span className={ringClass}>
                    <ProfileAvatar profile={profile} size="xl" />
                  </span>
                  <span className="w-full truncate text-center text-xl text-muted-foreground group-hover:text-foreground group-focus-visible:font-semibold group-focus-visible:text-foreground">
                    {profile.name}
                  </span>
                </button>
              </li>
            ))}
            {canCreateProfile(snapshot.profiles.length, snapshot.maxProfiles) && (
              <li>
                <button
                  type="button"
                  data-testid="profile-tile-add"
                  className={tileClass}
                  onClick={() => {
                    log("profiles.picker.add", { count: snapshot.profiles.length });
                    setManaging("add");
                  }}
                >
                  <span className={ringClass}>
                    <span className="grid h-40 w-40 place-items-center rounded-3xl border border-border bg-card/60 text-muted-foreground group-hover:text-foreground">
                      <Plus className="h-14 w-14" strokeWidth={1.5} aria-hidden />
                    </span>
                  </span>
                  <span className="w-full truncate text-center text-xl text-muted-foreground group-hover:text-foreground">{t("profiles.add")}</span>
                </button>
              </li>
            )}
          </ul>
          <Button data-testid="profiles-manage" type="button" variant="outline" onClick={() => setManaging("list")}>
            {t("profiles.manage")}
          </Button>
        </>
      )}
    </>
  );
}

export type ProfileMenuProps = {
  store: ProfileStore;
  log: ProfilesLog;
  t: ProfilesText;
  /** The app's own word for Sign out (`nav.signOut`) and its sign-out request, which asks about the library key first (ACCT-DEV-03). */
  signOutLabel: string;
  onSignOut: () => void;
  /** The app opens its manager on a new profile (`ProfilesManager startWith="add"`) or on the list. */
  onAddProfile: () => void;
  onManageProfiles: () => void;
};

/**
 * The top bar's avatar menu (UX-TOP-01, UX-TOP-02): the current profile's avatar, always shown (also with a single
 * profile), opening every profile with its avatar and name, the current one ticked (a pick switches at once, no
 * sign-in), then "Add profile", "Manage profiles" and "Sign out". The list closes on a pick, on Escape and on a click
 * outside it; arrow keys move between items.
 */
export function ProfileMenu({ store, log, t, signOutLabel, onSignOut, onAddProfile, onManageProfiles }: ProfileMenuProps) {
  const snapshot = useProfilesSnapshot(store);
  const current = snapshot.profiles.find((p) => p.id === snapshot.activeId) ?? null;
  const [open, setOpenState] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const setOpen = useCallback(
    (next: boolean) => {
      log(next ? "profiles.menu.opened" : "profiles.menu.closed", { count: snapshot.profiles.length });
      setOpenState(next);
    },
    [log, snapshot.profiles.length],
  );

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLButtonElement>("[role^=menuitem]")?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open, setOpen]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (!open) return;
    if (event.key === "Escape") {
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>("[aria-haspopup]")?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>("[role^=menuitem]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const label = t("profiles.menuA11y", { name: current?.name ?? "" });

  return (
    <div ref={root} className="relative inline-flex" onKeyDown={onKeyDown}>
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-testid="profile-menu"
        onClick={() => setOpen(!open)}
        className="group inline-flex items-center gap-1 rounded-xl p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="rounded-[10px] border-2 border-primary p-px">
          {/* Before the list arrives the pack's first avatar (the badger) holds the place. */}
          <ProfileAvatar profile={current ?? { avatar: 0, avatarId: PROFILE_AVATAR_IDS[0] }} size="sm" />
        </span>
        <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div
          ref={list}
          id={menuId}
          role="menu"
          aria-label={label}
          data-testid="profile-menu-list"
          className="absolute right-0 top-full z-50 mt-3 w-72 rounded-xl border border-border/60 bg-popover p-1.5 text-popover-foreground shadow-2xl shadow-black/50"
        >
          <ProfileMenuItems
            store={store}
            log={log}
            t={t}
            signOutLabel={signOutLabel}
            onSignOut={onSignOut}
            onAddProfile={onAddProfile}
            onManageProfiles={onManageProfiles}
            onPicked={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

const PROFILE_MENU_ITEM_CLASS =
  "flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-white/5 focus-visible:bg-white/10 focus-visible:outline-none";

/**
 * The avatar menu's entries (UX-TOP-01, UX-TOP-02): every profile with its avatar and name, the current one ticked (a
 * pick switches at once), then "Add profile", "Manage profiles" and "Sign out". `ProfileMenu` shows them in its popover;
 * a narrow window's navigation sheet shows the same entries, so both widths offer the same choices. `onPicked` runs
 * before each entry's action (the popover or sheet closes), `testIdPrefix` keeps the two places apart in tests.
 */
export function ProfileMenuItems({
  store,
  log,
  t,
  signOutLabel,
  onSignOut,
  onAddProfile,
  onManageProfiles,
  onPicked,
  testIdPrefix = "profile-menu",
}: ProfileMenuProps & { onPicked: () => void; testIdPrefix?: string }) {
  const snapshot = useProfilesSnapshot(store);
  const choose = (action: () => void) => {
    onPicked();
    action();
  };
  return (
    <>
      {snapshot.profiles.map((profile, index) => {
        const isCurrent = profile.id === snapshot.activeId;
        return (
          <button
            key={profile.id}
            type="button"
            role="menuitemradio"
            aria-checked={isCurrent}
            data-testid={`${testIdPrefix}-${profile.id}`}
            className={cn(PROFILE_MENU_ITEM_CLASS, "text-base", isCurrent && "bg-white/5")}
            onClick={() =>
              choose(() => {
                if (isCurrent) return;
                log("profiles.menu.selected", { profileId: profile.id, index });
                void store.selectProfile(profile.id);
              })
            }
          >
            <ProfileAvatar profile={profile} size="md" />
            <span className="min-w-0 flex-1 truncate">{profile.name}</span>
            {isCurrent && <Check className="h-5 w-5 text-primary" strokeWidth={2.5} aria-label={t("profiles.current")} />}
          </button>
        );
      })}
      <div role="separator" className="my-1.5 h-px bg-border/60" />
      <button type="button" role="menuitem" data-testid={`${testIdPrefix}-add`} className={cn(PROFILE_MENU_ITEM_CLASS, "text-base")} onClick={() => choose(onAddProfile)}>
        <span aria-hidden className="grid h-10 w-10 place-items-center rounded-lg border border-border bg-card/60">
          <Plus className="h-5 w-5" />
        </span>
        {t("profiles.add")}
      </button>
      <button type="button" role="menuitem" data-testid={`${testIdPrefix}-manage`} className={cn(PROFILE_MENU_ITEM_CLASS, "text-muted-foreground hover:text-foreground")} onClick={() => choose(onManageProfiles)}>
        {t("profiles.manage")}
      </button>
      <button type="button" role="menuitem" data-testid={`${testIdPrefix}-sign-out`} className={cn(PROFILE_MENU_ITEM_CLASS, "text-muted-foreground hover:text-foreground")} onClick={() => choose(onSignOut)}>
        {signOutLabel}
      </button>
    </>
  );
}

/**
 * Where nobody is asked "Who's listening?" (Parrot desktop and web player: playback names the account's main
 * profile, STOR-BW-11): when the store would ask (several profiles, none kept), the main profile becomes the current
 * one until another is picked in the top bar's menu.
 */
export const useMainProfileWhenUnchosen = (store: ProfileStore | null, log: ProfilesLog): void => {
  useEffect(() => {
    if (!store) return;
    const settle = () => {
      const snapshot = store.getSnapshot();
      if (snapshot.status !== "ready" || !snapshot.needsChoice) return;
      const main = snapshot.profiles.find((profile) => profile.isMain) ?? snapshot.profiles[0];
      if (!main) return;
      log("profiles.main_current", { profileId: main.id, count: snapshot.profiles.length });
      void store.selectProfile(main.id);
    };
    settle();
    return store.subscribe(settle);
  }, [store, log]);
};

/** Parrot's profile words ("Who's listening?", the listening delete warning) in `language`, English for one it lacks. */
export const parrotProfilesT = (language: string): ProfilesText =>
  profilesTranslator(isClientUiLanguage(language) ? language : "en", { listening: true });

/** Parrot's top bar avatar menu (UX-TOP-02) on desktop and the web player: the shared menu in Parrot's words. */
export function ParrotProfileMenu({ language, ...props }: Omit<ProfileMenuProps, "t"> & { language: string }) {
  return <ProfileMenu {...props} t={parrotProfilesT(language)} />;
}

/**
 * Parrot's Settings ▸ Account ▸ Profiles on desktop and the web player: the account's profiles with their avatars,
 * added, edited (ACCT-PROF-05) and deleted with the API's limits; a delete moves nothing (`NO_LIBRARY_MOVES`).
 * `startWith: "add"` opens straight on a new profile (the menu's "Add profile"). The list is read again when the page
 * opens, so a profile changed on another device or the website shows here, and again when the plan dialog over the
 * page (`planOpen`, desktop) closes, so its limit follows a plan change.
 */
export function ParrotProfilesSection({
  store,
  language,
  log,
  planOpen = false,
  startWith,
}: {
  store: ProfileStore;
  language: string;
  log: ProfilesLog;
  planOpen?: boolean;
  startWith?: "add";
}) {
  const refreshed = useRef(false);
  useEffect(() => {
    if (refreshed.current) return;
    refreshed.current = true;
    if (store.getSnapshot().status === "ready") void store.refresh();
  }, [store]);
  const planWasOpen = useRef(planOpen);
  useEffect(() => {
    if (planWasOpen.current && !planOpen) void store.refresh();
    planWasOpen.current = planOpen;
  }, [store, planOpen]);
  const t = parrotProfilesT(language);
  return (
    <section data-testid="settings-profiles" className="mt-6 space-y-2">
      <h3 className="text-sm font-semibold">{t("profiles.settingsGroup")}</h3>
      <ProfilesManager store={store} deleteProfile={(profileId) => store.deleteProfile(profileId, NO_LIBRARY_MOVES)} log={log} t={t} startWith={startWith} />
    </section>
  );
}
