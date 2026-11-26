import type { SpawnOptions } from "node:child_process";
import type { Socket } from "node:net";

/**
 * The desktop platform contract (ADR 2026-10-13-desktop-platform-layer).
 *
 * ONE interface, one implementation per OS (`@space/desktop-platform-linux`,
 * `-windows`, later `-macos`), one conformance suite every implementation must
 * pass (`./conformance`). The platform packages are the ONLY code allowed to
 * ask "which OS is this?": desktop main, the runtime and every shared package
 * call this interface and never look at `process.platform`
 * (`tests/tools/no_os_branching.test.ts` enforces it).
 *
 * Everything an OS can do differently is a member here. A feature that needs
 * an OS check anywhere else is a missing member of this interface: add it here
 * (and to every implementation + the conformance suite), never branch outside.
 */

export type PlatformId = "linux" | "windows" | "macos";
export type PlatformArch = "x64" | "arm64";
export type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Bundled binaries
// ---------------------------------------------------------------------------

/** The external programs every desktop OS ships (one shared feature list, see ADR 2026-10-13-own-mpv-ffmpeg-builds). */
export type BundledBinary = "ffmpeg" | "ffprobe" | "mpv";

export type BinaryResolveContext = {
  /** Packaged app code root (Electron `app.getAppPath()`); `<resources>/app.asar` when packaged. */
  appRoot?: string;
  /** `<resources>` of a packaged app (`process.resourcesPath`). */
  resourcesPath?: string;
  /** Defaults to `process.cwd()`. */
  cwd?: string;
  env?: Env;
};

export type ResolvedBinary = {
  /** Absolute path of the executable. */
  path: string;
  /** Directory that holds it (shared libraries sit next to it in the bundled layout). */
  dir: string;
  /** Shared-library directories the binary needs on the loader path (see `BinaryLayer.launchEnv`). */
  libDirs?: string[];
  /** Which lookup found it. */
  source: "packaged-deps" | "vendor-deps";
};

export type BinaryLayer = {
  /** `mpv` -> `mpv` (POSIX) / `mpv.exe` (Windows). */
  executableName: (base: BundledBinary | string) => string;
  /**
   * Directories searched for the bundled `bin/` (`<resources>/deps/bin` when
   * packaged, `vendor/deps/<os>-<arch>/bin` in a checkout), best first.
   */
  searchDirs: (ctx?: BinaryResolveContext) => string[];
  /** First existing bundled binary, or `undefined` (callers decide whether that is fatal). */
  resolve: (name: BundledBinary, ctx?: BinaryResolveContext) => ResolvedBinary | undefined;
  /**
   * Every bundled candidate for `name`, best first (the packaged layout, then a
   * checkout's `vendor/deps`). `resolve` is the first.
   */
  resolveAll: (name: BundledBinary, ctx?: BinaryResolveContext) => ResolvedBinary[];
  /** Environment that lets `binary` start: its library dirs (as `withLibraryPath`). Returns a copy. */
  launchEnv: (binary: Pick<ResolvedBinary, "libDirs">, env: Env) => Env;
  /**
   * Environment for launching a bundled binary whose shared libraries live in
   * `libDirs` (Linux: `LD_LIBRARY_PATH`; Windows: `PATH`; macOS:
   * `DYLD_FALLBACK_LIBRARY_PATH`, a safety net behind the binaries' LC_RPATH). Returns a copy.
   */
  withLibraryPath: (env: Env, libDirs: readonly string[]) => Env;
  /**
   * Where `name` sits below the deps directory (`vendor/deps/<os>-<arch>`, `<resources>/deps`) when
   * that is not `bin/<executableName(name)>`: macOS wraps mpv in its own app bundle
   * (`Badger Player.app/Contents/MacOS/mpv`, MPV-MODEL-03). Omitted: every binary is in `bin/`.
   */
  bundledPath?: (name: BundledBinary) => string;
};

// ---------------------------------------------------------------------------
// Directories
// ---------------------------------------------------------------------------

/** Log sink for {@link PathLayer.prepareRuntimeDataDir} (the guardian's logger, else the console). */
export type PathLog = (level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) => void;

export type PathLayer = {
  /**
   * Where the runtime keeps its pid file, log, job/key/event stores, library
   * databases and offline staging: `SPACEFLEET_RUNTIME_DATA_DIR` when set, else
   * the OS default, a persistent per-user directory (Linux
   * `$XDG_DATA_HOME/SpaceFleet/runtime`, else `~/.local/share/SpaceFleet/runtime`;
   * Windows `%LOCALAPPDATA%\SpaceFleet\runtime`; macOS
   * `~/Library/Application Support/SpaceFleet/runtime`). Pure: creates nothing.
   */
  runtimeDataDir: (env?: Env) => string;
  /**
   * Make the runtime data dir ready and return it ({@link runtimeDataDir} of
   * `env`). Creates it owner-only (it holds keys and databases) and, when it is
   * the OS default and holds no data yet, carries over the data a previous
   * default location left behind (Linux: `/tmp/spacefleet-runtime`, only when
   * this user owns it). Idempotent and never throws for a failed carry-over (it
   * logs it). Synchronous: while another process carries the data over, it
   * waits for it (bounded) so it never starts on an empty dir meanwhile. Every
   * process that uses the dir (the guardian, the runtime) calls it before
   * reading or writing anything there.
   */
  prepareRuntimeDataDir: (options?: { env?: Env; log?: PathLog }) => string;
  /**
   * Make an existing file readable and writable by the current user only
   * (POSIX: mode 0600; Windows: the inherited ACL is dropped and only the
   * current user's SID keeps access). Throws when it cannot, or when the
   * result is not owner-only: the caller must then not put a secret in the
   * file. Call it on the empty file BEFORE writing the secret into it.
   */
  restrictFileToOwner: (path: string) => void;
  /**
   * Make an existing directory owner-only (POSIX: mode 0700, tightened only
   * when group/other bits are set). Windows: a no-op, the runtime data dir
   * sits under `%LOCALAPPDATA%`, which the OS already limits to the user; a
   * secret there is protected by {@link restrictFileToOwner} on the file.
   */
  restrictDirToOwner: (path: string) => void;
  /** Per-user directory the OS wants application state in (not created). */
  userDataBase: (env?: Env) => string;
  /**
   * Electron `userData` of a desktop app, below Electron's `appData` (`app.getPath("appData")`).
   * Linux / Windows: `appData/...legacyDir` (existing installs keep their directory, today
   * `@sf/desktop`); macOS: `appData/productName` (`~/Library/Application Support/Badger`, PLAT-DESK-07).
   */
  appUserDataDir: (options: { appData: string; productName: string; legacyDir: string[] }) => string;
  /**
   * Where the desktop's trash keeps a deleted file of that name (`basename(filename)`), to tell "the user deleted it"
   * from "it is gone": Linux `$XDG_DATA_HOME/Trash/files/<name>` (else `~/.local/share`); macOS `~/.Trash/<name>`;
   * Windows none (the Recycle Bin renames what it keeps, so there is no plain path).
   */
  trashPaths: (filename: string, env?: Env) => string[];
};

// ---------------------------------------------------------------------------
// mpv JSON IPC endpoint
// ---------------------------------------------------------------------------

export type MpvIpcLayer = {
  /** A fresh endpoint for `token` (unix socket path / `\\.\pipe\...`). Pass it to `--input-ipc-server=`. */
  endpoint: (token: string) => string;
  /**
   * Cheap "is something there" check; true does not mean it accepts connections. MUST NOT connect to
   * or open the endpoint: a probe that does takes a connection from the server (mpv serves one client
   * per pipe instance), so a check run before a request makes the request itself fail. Conformance-checked.
   */
  exists: (endpoint: string) => boolean;
  /** Connect to a listening mpv. Same contract as `net.createConnection(endpoint, onConnect)`. */
  connect: (endpoint: string, onConnect?: () => void) => Socket;
  /** Best-effort removal of a stale / finished endpoint. Never throws. */
  remove: (endpoint: string) => void;
};

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

/** One operating-system process, as the playback gate drives it. Methods throw on failure. */
export type ProcessHandle = {
  suspend: () => void;
  resume: () => void;
  /** Throttle (see `ProcessControlBackend.throttleKind`). Idempotent. */
  throttle: () => void;
  /** Undo the throttle: the cores / scheduling band the process had when it was opened. */
  unthrottle: () => void;
  /** Re-apply the throttle to threads created since it was applied (Linux). */
  refresh?: () => void;
  /** Number of logical cores the process may run on right now (conformance of a "one-core" throttle + diagnostics). */
  allowedCpuCount?: () => number | null;
  /** Whether the process runs in the OS background band right now, read back from the OS (conformance of a "background-band" throttle); null when unreadable. */
  inBackgroundBand?: () => boolean | null;
  close: () => void;
};

export type ProcessControlBackend = {
  name: string;
  /**
   * What `throttle` does (INGS-LANE-02). `one-core`: the process may run on exactly one logical core
   * (Linux affinity, Windows affinity mask; handles report `allowedCpuCount`). `background-band`: the
   * process moves to the OS background scheduling band (macOS `PRIO_DARWIN_BG`: lowest priority,
   * throttled I/O, efficiency cores), as macOS has no affinity API (handles report `inBackgroundBand`).
   */
  throttleKind: "one-core" | "background-band";
  /** > 0: call `refresh` on every throttled child this often (ms). */
  reconcileMs: number;
  open: (pid: number) => ProcessHandle;
};

export type GroupSignal = "terminate" | "kill";

export type ProcessLayer = {
  /**
   * Spawn options for a child that must outlive its parent or lead its own
   * process group (the runtime, mpv). `detached: false` keeps it attached.
   */
  spawnOptions: (options: { detached: boolean }) => Pick<SpawnOptions, "detached" | "windowsHide">;
  /**
   * Argv to spawn for `command args` so the child holds none of the handles
   * its parent has open beyond the stdio the spawner gives it. Electron's
   * `--remote-debugging-port` listener has no CLOEXEC and neither libuv nor
   * Node closes fds above 2 on spawn, so every child (the runtime, mpv) kept
   * that port bound after Electron let go. Linux starts the program through a
   * shell prelude that closes every fd >= 3 and then `exec`s, so pid, command
   * line and parent are the program's own; Windows only passes the stdio
   * handles, so it returns the argv unchanged. A command that does not resolve
   * is returned unchanged so the spawn still fails with ENOENT.
   *
   * Every fd >= 3 is closed, including ones the spawner passed on purpose, so
   * it must not be used for a spawn with extra `stdio` entries (`'ipc'`, a
   * 4th pipe). `childLifetime.wrap` applies it as well; use this directly for
   * children that must outlive their parent and so cannot use `childLifetime`.
   */
  withoutInheritedHandles: (command: string, args: string[], env?: Env) => { command: string; args: string[] };
  /** Groups: the whole tree of a detached child, addressed by the leader's pid. */
  group: {
    /** True while any process of the group can still run (zombies do not count). */
    isAlive: (leaderPid: number) => boolean;
    /**
     * Deliver `terminate` (ask) or `kill` (force) to every process of the
     * group. `terminate` also wakes a stopped member so it can act on it.
     * True when the signal reached at least one process.
     */
    signal: (leaderPid: number, signal: GroupSignal) => boolean;
  };
  /**
   * Ask a process to stop gracefully, so its drain runs. A plain
   * `process.kill(pid, 'SIGTERM')` is a forced TerminateProcess on Windows and
   * runs no handler, hence the pair: `install` runs in the process that wants
   * to be stoppable (the runtime), `request` in the stopper (the guardian).
   * Forcing the process down after a grace stays the caller's job.
   */
  gracefulStop: {
    /**
     * Make this process stoppable. `onRequest` runs once per request with its
     * source (`SIGTERM`, `SIGINT`, `pipe`, ...), for the OS stop request and
     * for console Ctrl+C. Never keeps the process alive. Returns the uninstall
     * function.
     *
     * When the OS channel cannot be set up (Windows: the stop pipe's name is
     * held by another process, or the runtime has no `bun:ffi`), `install`
     * does not throw: it calls `onUnavailable` with the reason (default: a
     * console warning) and the process stays stoppable only by the stopper's
     * forced-kill escalation; `request` then reports false for it.
     */
    install: (onRequest: (source: string) => void, onUnavailable?: (reason: string) => void) => () => void;
    /**
     * Deliver a stop request to `pid` (which called `install`). Synchronous, so
     * it also works in an `exit` handler. True when the request was delivered;
     * false when it could not be (no such process, not stoppable): the caller
     * then relies on its forced-kill escalation.
     */
    request: (pid: number) => boolean;
  };
  /** Suspend / resume / one-core throttle of a running process (the playback gate backend). */
  control: ProcessControlBackend;
  /** Kernel thread ids of `pid` when niceness is per thread (Linux); `[pid]` elsewhere. */
  listThreadIds: (pid: number) => number[];
  /** Full command line of `pid` (argv joined by spaces), or null when the OS cannot tell. */
  readCommandLine: (pid: number) => Promise<string | null>;
  readCommandLineSync: (pid: number) => string | null;
  /** Identity of this process's PID namespace (Linux inode) or null where there is none. */
  ownPidNamespace: () => string | null;
  /**
   * Tie a spawned child's life to this process's, so it dies when this process
   * is SIGKILLed / crashes. `wrap` runs BEFORE the spawn (Linux: `setpriv
   * --pdeathsig`), `afterSpawn` right after it with the child's pid (Windows:
   * Job Object kill-on-close). Either may be a no-op for an OS that does the
   * other. `supported` says whether the guarantee holds on this host. `wrap`
   * also applies `withoutInheritedHandles`, so wrapped children keep no
   * inherited fd either. The caller MUST spawn the returned argv itself, from
   * this same process: on Linux the child checks its parent is the wrapping
   * process and exits without running the program when it is not (a parent
   * that died before the death signal was armed).
   */
  childLifetime: {
    supported: () => Promise<boolean>;
    wrap: (command: string, args: string[], env?: Env) => Promise<{ command: string; args: string[] }>;
    afterSpawn: (pid: number | undefined) => void;
    /**
     * Put THIS process in the same kill-on-close group before it spawns anything, so every descendant is
     * a member from creation (no spawn/assign race: a process that spawns a launcher which spawns the app
     * is covered whole, and a SIGKILLed / crashed process takes the entire tree). Resolves true once
     * membership is confirmed, false when the OS has no such mechanism (Linux: per-child `wrap` is the
     * mechanism) or it failed (logged). The caller MUST await it before its first spawn.
     */
    adoptCurrentProcess: () => Promise<boolean>;
    /**
     * Start `command args` so that it is NOT tied to this process: it keeps running after this process exits or is
     * killed, also after `adoptCurrentProcess` (a cleanup that must finish, such as the e2e harness's
     * `docker compose down` started from an exit handler). Windows: created with CREATE_BREAKAWAY_FROM_JOB, outside
     * the kill-on-close job, which allows breakaway only for a process that asks for it. Elsewhere: a detached spawn
     * (only wrapped children are tied). It gets `env` as its whole environment, this process's working folder and NO
     * stdio: it writes its own log. Synchronous (safe in `exit` handlers); the pid, or null when it could not start
     * (logged on Windows; elsewhere a spawn error arrives later and is ignored).
     */
    spawnSurvivor: (command: string, args: string[], env: Env) => number | null;
  };
};

// ---------------------------------------------------------------------------
// Hardware and host resources
// ---------------------------------------------------------------------------

export type HardwareEncoder = "vaapi" | "qsv" | "nvenc" | "amf" | "videotoolbox";

export type EncoderPolicy = {
  /** Encoders this OS can use, in fallback order (first = preferred when the GPU vendor decides nothing). */
  order: readonly HardwareEncoder[];
  /** Lower-case GPU-vendor substrings that make `encoder` the pick for that vendor. */
  vendors: Partial<Record<HardwareEncoder, readonly string[]>>;
};

export type CpuQuota = {
  /** quota / period, in CPUs (fractional). */
  cpus: number;
  /** Where the limit came from (file / API). */
  source: string;
  raw: string;
};

/** What the OS says limits this process's CPUs, beyond `os.availableParallelism()`. */
export type CpuLimits = {
  /** Raw allowed-CPU list (Linux `Cpus_allowed_list`), null when the OS has none / unread. */
  affinityList: string | null;
  /** CPUs this process may run on (affinity / cpuset), null when unknown. */
  affinityCount: number | null;
  /** Tightest CPU quota (cgroup `cpu.max`), null when none is set. */
  quota: CpuQuota | null;
  /** Every source consulted, for the one diagnostic log line. */
  checked: Array<{ file: string; content: string | null }>;
};

export type CpuPressureSample = {
  /** Share of wall time at least one task waited for a CPU, 0..1. */
  some: number;
  source: "cgroup-psi" | "host-psi";
};

export type HardwareLayer = {
  encoderPolicy: EncoderPolicy;
  /**
   * `amd` | `intel` | `nvidia` | `apple` | `` (unknown). Cached per process. Async: Windows and macOS spawn a
   * PowerShell CIM / system_profiler query that takes seconds on a slow machine and must not block the caller's
   * event loop (#928: a sync query stalled the runtime 4 s at the first ingest on a Celeron).
   */
  detectGpuVendor: () => Promise<string>;
  /** Device node / handle an encoder needs (`vaapi` -> render node), null when none applies or none exists. */
  deviceFor: (encoder: HardwareEncoder, env?: Env) => string | null;
  /** Hard memory limit this process lives under (container / cgroup), null when unlimited / unknown. */
  memoryLimitBytes: () => number | null;
  /**
   * The host's graphics stack as text that changes when the GPU, its kernel
   * driver or the user-space graphics libraries (Mesa, the GPU vendor's) change.
   * The mpv GPU probe memory keys on it (#25). null when the OS gives no such
   * signal (Windows: nothing keys on it there). Never throws.
   */
  graphicsStack: () => string | null;
  readCpuLimits: () => CpuLimits;
  /** A reader for CPU pressure, or null when the OS has no such signal (callers fall back to load average). */
  createCpuPressureReader: () => (() => CpuPressureSample | null) | null;
};

/**
 * Both readers are async: the guardian calls them from the Electron main
 * process on a failed health probe, and a Windows read spawns PowerShell for
 * seconds — it must never block the event loop (#928).
 */
export type DiagnosticsLayer = {
  /** Out-of-process state dump of `pid` for a failed health probe. Best-effort, never rejects; always includes `platform`. */
  readProcess: (pid: number) => Promise<Record<string, unknown>>;
  /** Who holds a listening TCP port. Best-effort, never rejects; always includes `platform`. */
  readPortHolders: (port: number) => Promise<Record<string, unknown>>;
};

// ---------------------------------------------------------------------------
// Desktop shell (Electron main)
// ---------------------------------------------------------------------------

/** The slice of Electron's `app` the shell hook touches (structural, so no electron import here). */
export type ShellApp = {
  setAppUserModelId: (id: string) => void;
  commandLine: { appendSwitch: (name: string, value?: string) => void };
};

/** The window-system part of mpv's command line ({@link ShellLayer.mpvWindow}). */
export type MpvWindow = {
  /** The vo list used when the caller does not pick one: GPU first, then the platform's CPU fallback. */
  defaultVo: string;
  /**
   * The CPU entry of `defaultVo` (Linux: `wlshm` in a Wayland session, `x11` in an X11 one), the vo a launch
   * goes straight to when this machine's GPU vo is remembered to fail (#25). null
   * when the CPU path lives inside the GPU vo (Windows d3d11 WARP) or no CPU vo
   * can open: every launch then probes.
   */
  cpuVo: string | null;
  /** Flags that give the window its app id. */
  args: string[];
  /**
   * Variables removed from mpv's environment. Linux Wayland session with a Wayland mpv: `DISPLAY`, so neither the
   * gpu vo's context probe (`x11egl` after a rejected `wayland`) nor anything else can open an XWayland window
   * (MPV-GPU-04). Empty elsewhere.
   */
  unsetEnv: string[];
  /**
   * Why no mpv window can open in this session, or null when one can. Linux: a
   * Wayland-only session (no X display) with an mpv built without Wayland (a
   * system mpv set through SF_MPV_SYSTEM_BIN, `mpv_no_display`). The launch reports it to the user
   * instead of starting an mpv that exits at once. Windows / macOS: always null.
   */
  noWindow: string | null;
};

export type ShellLayer = {
  /** One-time per-OS app setup right after `app.setName` (Windows AUMID, Linux WM class, macOS nothing). */
  prepareApp: (app: ShellApp, options: { appUserModelId: string; linuxWindowClass: string }) => void;
  /**
   * Environment for the external mpv window, with its identity registered with
   * the OS shell and its data kept in `dataDir` (Linux: a `.desktop` entry +
   * icon so the window manager groups it, `XDG_DATA_HOME=dataDir`, `MALLOC_ARENA_MAX=1` unless the
   * operator set one: glibc's per-thread arenas fragment under mpv's threads, #265; Windows and macOS:
   * none needed, macOS takes the window's identity from the mpv helper app bundle).
   * Returns a copy of `env`.
   */
  prepareMpvWindow: (options: { appId: string; iconPath?: string; dataDir: string; env: Env }) => Env;
  /**
   * The window-system part of mpv's command line: the video output list used
   * when the caller does not pick one (GPU first; mpv falls through to the
   * next entry when a GPU vo cannot start, #25: Linux `gpu,wlshm` in a Wayland
   * session with a Wayland mpv and `gpu,x11` otherwise, Windows
   * `gpu` whose d3d11 falls back to a WARP device, macOS `gpu-next` on
   * Vulkan/MoltenVK, MPV-GPU-03), the flags that give the window its app
   * id or graphics API (Linux: `--x11-name` / `--wayland-app-id`; Windows:
   * none, the id comes from the AppUserModelId; macOS: `--gpu-api=vulkan
   * --gpu-context=macvk`, the id comes from the helper app), and the variables
   * taken out of mpv's environment (`unsetEnv`). Reads the window-system
   * hints from `env`. `mpvHasWayland` says whether the mpv in use can open a
   * native Wayland window (it lists a `wayland*` gpu context); it is called only
   * when the answer matters (Linux, Wayland session), and omitted means no.
   */
  mpvWindow: (options: { appId: string; env?: Env; mpvHasWayland?: () => boolean }) => MpvWindow;
  /**
   * Whether closing the last window quits the app once a quit is under way. Linux / Windows: true;
   * macOS: false (PLAT-DESK-06: the app stays in the Dock and the menu bar; every explicit quit
   * calls `app.quit()` itself).
   */
  quitWhenAllWindowsClosed: boolean;
  /** Whether a display is available (headless Linux CI has none; Windows/macOS always do). */
  hasDisplay: (env?: Env) => boolean;
  /**
   * Name passed to `app.setName`. Linux / Windows: `legacyName` (Linux safeStorage keys its keyring
   * entry "<name> Safe Storage" by it; renaming would lose the sign-in); macOS: `productName`
   * (REL-MAC-05: Dock, app menu, "Quit Badger").
   */
  appName: (options: { productName: string; legacyName: string }) => string;
  /** Whether the OS has a global app menu bar the app must fill (macOS: app menu with Hide / Quit, Edit, Window). */
  applicationMenu: boolean;
  /** Tray / menu-bar icon style: `color` (the app icon) or `template` (macOS monochrome menu-bar template image). */
  trayIcon: "color" | "template";
};

// ---------------------------------------------------------------------------
// The platform
// ---------------------------------------------------------------------------

export type DesktopPlatform = {
  id: PlatformId;
  arch: PlatformArch;
  binaries: BinaryLayer;
  paths: PathLayer;
  mpvIpc: MpvIpcLayer;
  processes: ProcessLayer;
  hardware: HardwareLayer;
  diagnostics: DiagnosticsLayer;
  shell: ShellLayer;
};
