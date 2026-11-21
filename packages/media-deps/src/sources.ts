import { FFMPEG_VERSION, LIBPLACEBO_REF, MPV_VERSION } from "./features";

/**
 * THE pin list of every upstream library the media builds use. Nothing is built from upstream: each library
 * has a fork on GitHub (`spacefleet-io/<repo>`) and a recipe fetches EXACTLY `sha` from it (`recipes/_shared/fetch-source.sh` refuses any other commit).
 *
 * `sha` is always the tip of the fork branch `sf/<version>` (`sfBranchName`). It is either the upstream commit
 * of `upstreamRef` itself, or ONE commit of ours on top of it: the upstream release artifact's tree (`release`:
 * the tarball the build consumed before the forks, with generated `configure` scripts / `VERSION` stamps) and/or
 * fork-relative `.gitmodules` urls, or a source patch (`mpvmobile`, documented at its entry). So moving to a new
 * upstream version is a deliberate PR: pin the new commit
 * with `bun packages/media-deps/scripts/forks.ts pin <id> --ref <tag>`, paste the printed entry, let CI rebuild.
 * The nightly sync (`scripts/forks.ts sync`) only mirrors upstream branches/tags into the forks; it
 * never moves a pin.
 */
export type UpstreamSpec =
  /** A git upstream: every branch and tag is mirrored. */
  | { kind: "git"; url: string }
  /** An upstream that only publishes release tarballs: each new release becomes one commit + tag `v<version>` on `main`. */
  | {
      kind: "release-tarballs";
      /** SourceForge-style RSS listing of the release files. */
      index: string;
      /** Regex over each listed file path; group 1 is the version. */
      versionPattern: string;
      /** Tarball url of one version. */
      downloadUrl: string;
      /** Only versions >= this are imported. */
      since: string;
    };

export type SourceSpec = {
  /** Human version, informational (also lands in deps-manifest.json); names the fork branch `sf/<version>`. */
  version: string;
  /** Fork repository name inside the `spacefleet-io` GitHub org. */
  repo: string;
  upstream: UpstreamSpec;
  /** The upstream tag (or commit) this version is built from; for release-tarballs upstreams the tag our importer makes. */
  upstreamRef: string;
  /** The EXACT commit built: tip of `sf/<version>` in the fork. */
  sha: string;
  /** SPDX expression of what the build ships (source archive manifest). */
  license: string;
  /** What the MOBILE / TV targets ship from it when that differs from `license` (`MOBILE_FEATURES` has no GPL part,
   * so ffmpeg and mpv are LGPL there). `targetSources` hands mobile targets this one as their `license`. */
  mobileLicense?: string;
  /** Set when `sha` is a commit of ours holding the upstream release artifact's tree instead of the tagged tree. */
  release?: { url: string; sha256: string };
  /** Submodules the build consumes, by checkout path; the fork's `.gitmodules` points at their forks. */
  submodules?: Readonly<Record<string, Omit<SourceSpec, "submodules">>>;
};

export const SOURCES = {
  ffmpeg: {
    version: FFMPEG_VERSION,
    repo: "ffmpeg",
    upstream: { kind: "git", url: "https://github.com/FFmpeg/FFmpeg.git" },
    upstreamRef: "n8.1.3",
    sha: "30c5a782a65ad3a2351704b5a0eb973465995e31",
    license: "GPL-2.0-or-later",
    release: { url: `https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz`, sha256: "7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3" },
  },
  // The phone / TV ffmpeg (REL-DEPS-11): the 8.1.3 release tree (`ffmpeg`'s sf/8.1.3) plus ONE commit of ours,
  // `avformat/hls: seek non-primary playlists to the requested time`: after a backward video seek the separate
  // audio playlist starts at the target instead of the video segment start, so a timeline seek does not decode and
  // drop up to a whole segment of audio. Desktop keeps `ffmpeg`, so its builds do not move. `forks.ts pin` would
  // rebuild sf/8.1.3-mobile WITHOUT that commit: a new ffmpeg version means cherry-picking it onto the new
  // version's sf/ branch and pasting the new tip here.
  ffmpegmobile: {
    version: `${FFMPEG_VERSION}-mobile`,
    repo: "ffmpeg",
    upstream: { kind: "git", url: "https://github.com/FFmpeg/FFmpeg.git" },
    upstreamRef: "n8.1.3",
    sha: "85ed917ac0f7bd62b25535920c25680754f9c91a",
    license: "LGPL-2.1-or-later",
    release: { url: `https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz`, sha256: "7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3" },
  },
  mpv: {
    version: MPV_VERSION,
    repo: "mpv",
    upstream: { kind: "git", url: "https://github.com/mpv-player/mpv.git" },
    upstreamRef: "v0.41.0",
    sha: "41f6a645068483470267271e1d09966ca3b9f413",
    license: "GPL-2.0-or-later",
    mobileLicense: "LGPL-2.1-or-later",
  },
  // The phone / TV libmpv (REL-DEPS-11): v0.41.0 plus TWO commits of ours: the `moltenvk` gpu context that renders
  // into the CAMetalLayer an iOS / tvOS app passes as --wid (0.41.0's only Vulkan-on-Metal context needs cocoa), and
  // its fix keeping the vo display size when a new file reconfigures without a layer resize (else drawn native-size
  // in the corner). Desktop keeps `mpv`, so its builds do not move. `forks.ts pin` would rebuild sf/0.41.0-mobile
  // WITHOUT those commits: a new mpv version means cherry-picking them onto the new tag's branch and pasting the tip.
  mpvmobile: {
    version: `${MPV_VERSION}-mobile`,
    repo: "mpv",
    upstream: { kind: "git", url: "https://github.com/mpv-player/mpv.git" },
    upstreamRef: "v0.41.0",
    sha: "5cacc356551773f0286e9ef220f9dbf176af93b1",
    license: "LGPL-2.1-or-later",
  },
  x264: {
    version: "stable@b35605a",
    repo: "x264",
    upstream: { kind: "git", url: "https://code.videolan.org/videolan/x264.git" },
    upstreamRef: "b35605ace3ddf7c1a5d67a2eb553f034aef41d55",
    sha: "b35605ace3ddf7c1a5d67a2eb553f034aef41d55",
    license: "GPL-2.0-or-later",
  },
  x265: {
    version: "4.1",
    repo: "x265",
    upstream: { kind: "git", url: "https://bitbucket.org/multicoreware/x265_git.git" },
    upstreamRef: "4.1",
    sha: "5e5e47b5f9bb1a97e1eef3a0c05dea1fdf1db419",
    license: "GPL-2.0-or-later",
    release: { url: "https://bitbucket.org/multicoreware/x265_git/downloads/x265_4.1.tar.gz", sha256: "a31699c6a89806b74b0151e5e6a7df65de4b49050482fe5ebf8a4379d7af8f29" },
  },
  lame: {
    version: "3.100",
    repo: "lame",
    upstream: {
      kind: "release-tarballs",
      index: "https://sourceforge.net/projects/lame/rss?path=/lame",
      versionPattern: "^/lame/([0-9]+(?:\\.[0-9]+)+)/lame-\\1\\.tar\\.gz$",
      downloadUrl: "https://downloads.sourceforge.net/project/lame/lame/{version}/lame-{version}.tar.gz",
      since: "3.100",
    },
    upstreamRef: "v3.100",
    sha: "8bf7a3bcf7ceba65a0e1e6b6afd37d5937f98ce7",
    license: "LGPL-2.0-or-later",
    release: { url: "https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz", sha256: "ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e" },
  },
  dav1d: {
    version: "1.5.1",
    repo: "dav1d",
    upstream: { kind: "git", url: "https://code.videolan.org/videolan/dav1d.git" },
    upstreamRef: "1.5.1",
    sha: "42b2b24fb8819f1ed3643aa9cf2a62f03868e3aa",
    license: "BSD-2-Clause",
  },
  nvcodec: {
    version: "n13.0.19.0",
    repo: "nv-codec-headers",
    upstream: { kind: "git", url: "https://github.com/FFmpeg/nv-codec-headers.git" },
    upstreamRef: "n13.0.19.0",
    sha: "e844e5b26f46bb77479f063029595293aa8f812d",
    license: "MIT",
  },
  amf: {
    version: "1.4.36",
    repo: "amf",
    upstream: { kind: "git", url: "https://github.com/GPUOpen-LibrariesAndSDKs/AMF.git" },
    upstreamRef: "v1.4.36",
    sha: "31d558cc1fd8fe63de3c8cef29faed9269500e8a",
    license: "MIT",
    release: { url: "https://github.com/GPUOpen-LibrariesAndSDKs/AMF/releases/download/v1.4.36/AMF-headers-v1.4.36.tar.gz", sha256: "ec07ee21b820a73f5bae224e92fd3c492f52732d4885f0637f48189afdd87564" },
  },
  libvpl: {
    version: "2.15.0",
    repo: "libvpl",
    upstream: { kind: "git", url: "https://github.com/intel/libvpl.git" },
    upstreamRef: "v2.15.0",
    sha: "c45b5d786bf7cdabbe49ff1bab78693ad78feb78",
    license: "MIT",
  },
  libdrm: {
    version: "2.4.124",
    repo: "libdrm",
    upstream: { kind: "git", url: "https://gitlab.freedesktop.org/mesa/drm.git" },
    upstreamRef: "libdrm-2.4.124",
    sha: "38ec7dbd4df3141441afafe5ac62dfc9df36a77e",
    license: "MIT",
  },
  libva: {
    // Mesa's VA drivers export only `__vaDriverInit_<their libva's API>`, and libva tries its own API version down to
    // 1.0: the bundled libva must be at least the one the user's Mesa was built against (Mesa 26 needs 1.24).
    version: "2.24.1",
    repo: "libva",
    upstream: { kind: "git", url: "https://github.com/intel/libva.git" },
    upstreamRef: "2.24.1",
    sha: "809612ca0b4a95eb4845c14d72357b02d40d0896",
    license: "MIT",
    release: { url: "https://github.com/intel/libva/releases/download/2.24.1/libva-2.24.1.tar.bz2", sha256: "eec6050b52876f229bd35e9df17cd31a06785e18e6f7990c445b584628483d67" },
  },
  libplacebo: {
    version: LIBPLACEBO_REF,
    repo: "libplacebo",
    upstream: { kind: "git", url: "https://github.com/haasn/libplacebo.git" },
    upstreamRef: "v7.360.0",
    sha: "5ce8f9cb61a98a26fde99689db0b7ad160b838bc",
    license: "LGPL-2.1-or-later",
    submodules: {
      "3rdparty/glad": {
        version: "73db193",
        repo: "glad",
        upstream: { kind: "git", url: "https://github.com/Dav1dde/glad" },
        upstreamRef: "73db193f853e2ee079bf3ca8a64aa2eaf6459043",
        sha: "73db193f853e2ee079bf3ca8a64aa2eaf6459043",
        license: "MIT",
      },
      "3rdparty/jinja": {
        version: "1520688",
        repo: "jinja",
        upstream: { kind: "git", url: "https://github.com/pallets/jinja" },
        upstreamRef: "15206881c006c79667fe5154fe80c01c65410679",
        sha: "15206881c006c79667fe5154fe80c01c65410679",
        license: "BSD-3-Clause",
      },
      "3rdparty/markupsafe": {
        version: "297fc8e",
        repo: "markupsafe",
        upstream: { kind: "git", url: "https://github.com/pallets/markupsafe" },
        upstreamRef: "297fc8e356e6836a62087949245d09a28e9f1b13",
        sha: "297fc8e356e6836a62087949245d09a28e9f1b13",
        license: "BSD-3-Clause",
      },
      "3rdparty/Vulkan-Headers": {
        version: "450bd22",
        repo: "vulkan-headers",
        upstream: { kind: "git", url: "https://github.com/KhronosGroup/Vulkan-Headers" },
        upstreamRef: "450bd2232225d6c7728a4108055ac2e37cef6475",
        sha: "450bd2232225d6c7728a4108055ac2e37cef6475",
        license: "Apache-2.0 OR MIT",
      },
      "3rdparty/fast_float": {
        version: "97b54ca",
        repo: "fast-float",
        upstream: { kind: "git", url: "https://github.com/fastfloat/fast_float.git" },
        upstreamRef: "97b54ca9e75f5303507699d27c6b4f4efe4641a1",
        sha: "97b54ca9e75f5303507699d27c6b4f4efe4641a1",
        license: "Apache-2.0 OR MIT OR BSL-1.0",
      },
      "demos/3rdparty/nuklear": {
        version: "242f35e",
        repo: "nuklear",
        upstream: { kind: "git", url: "https://github.com/Immediate-Mode-UI/Nuklear.git" },
        upstreamRef: "242f35efa067a46c595645eeda7b1771ea1f83b1",
        sha: "242f35efa067a46c595645eeda7b1771ea1f83b1",
        license: "MIT OR Unlicense",
      },
    },
  },
  luajit: {
    version: "v2.1@634daf2",
    repo: "luajit",
    upstream: { kind: "git", url: "https://github.com/LuaJIT/LuaJIT.git" },
    upstreamRef: "634daf2453559fd5e0ec282f3b7aedaa09e9f344",
    sha: "634daf2453559fd5e0ec282f3b7aedaa09e9f344",
    license: "MIT",
  },
  zlib: {
    version: "1.3.1",
    repo: "zlib",
    upstream: { kind: "git", url: "https://github.com/madler/zlib.git" },
    upstreamRef: "v1.3.1",
    sha: "d9d4081f378d71d5934fe2a8dfeee1d2df86c07f",
    license: "Zlib",
    release: { url: "https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz", sha256: "9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23" },
  },
  freetype: {
    version: "2.13.3",
    repo: "freetype",
    upstream: { kind: "git", url: "https://gitlab.freedesktop.org/freetype/freetype.git" },
    upstreamRef: "VER-2-13-3",
    sha: "415b4ce30caea2785fd83483f6170d39121d6d29",
    license: "FTL OR GPL-2.0-or-later",
    release: { url: "https://download.savannah.gnu.org/releases/freetype/freetype-2.13.3.tar.xz", sha256: "0550350666d427c74daeb85d5ac7bb353acba5f76956395995311a9c6f063289" },
  },
  harfbuzz: {
    version: "11.2.1",
    repo: "harfbuzz",
    upstream: { kind: "git", url: "https://github.com/harfbuzz/harfbuzz.git" },
    upstreamRef: "11.2.1",
    sha: "33a3f8de60dcad7535f14f07d6710144548853ac",
    license: "MIT",
  },
  fribidi: {
    version: "1.0.16",
    repo: "fribidi",
    upstream: { kind: "git", url: "https://github.com/fribidi/fribidi.git" },
    upstreamRef: "v1.0.16",
    sha: "b9345a57819afc0bed051bcfc9323d5f16842ad1",
    license: "LGPL-2.1-or-later",
    release: { url: "https://github.com/fribidi/fribidi/releases/download/v1.0.16/fribidi-1.0.16.tar.xz", sha256: "1b1cde5b235d40479e91be2f0e88a309e3214c8ab470ec8a2744d82a5a9ea05c" },
  },
  libass: {
    version: "0.17.4",
    repo: "libass",
    upstream: { kind: "git", url: "https://github.com/libass/libass.git" },
    upstreamRef: "0.17.4",
    sha: "6d4ab6e20aef531bb5e00a8ec259cdcee5ac5cbb",
    license: "ISC",
    release: { url: "https://github.com/libass/libass/releases/download/0.17.4/libass-0.17.4.tar.xz", sha256: "78f1179b838d025e9c26e8fef33f8092f65611444ffa1bfc0cfac6a33511a05a" },
  },
  zimg: {
    version: "3.0.5",
    repo: "zimg",
    upstream: { kind: "git", url: "https://github.com/sekrit-twc/zimg.git" },
    upstreamRef: "release-3.0.5",
    sha: "e5b0de6bebbcbc66732ed5afaafef6b2c7dfef87",
    license: "WTFPL",
  },
  spirvcross: {
    version: "vulkan-sdk-1.4.350.1",
    repo: "spirv-cross",
    upstream: { kind: "git", url: "https://github.com/KhronosGroup/SPIRV-Cross.git" },
    upstreamRef: "vulkan-sdk-1.4.350.1",
    sha: "1a6169566c73d3da552748fc372fe2bbb856e46e",
    license: "Apache-2.0",
  },
  // macOS: SPIR-V -> Metal shading language inside MoltenVK, at the exact revision MoltenVK v1.4.2 pins
  // (its ExternalRevisions/SPIRV-Cross_repo_revision). Same fork as `spirvcross`, another sf/ branch.
  moltenvkspirvcross: {
    version: "vulkan-sdk-1.4.357.0",
    repo: "spirv-cross",
    upstream: { kind: "git", url: "https://github.com/KhronosGroup/SPIRV-Cross.git" },
    upstreamRef: "vulkan-sdk-1.4.357.0",
    sha: "6c09849fe88c48eaed08413aa022aaa136a3a057",
    license: "Apache-2.0",
  },
  // macOS: the Vulkan implementation on Metal that mpv's gpu-next output draws through (MPV-GPU-03).
  moltenvk: {
    version: "v1.4.2",
    repo: "moltenvk",
    upstream: { kind: "git", url: "https://github.com/KhronosGroup/MoltenVK.git" },
    upstreamRef: "v1.4.2",
    sha: "db66022459ffb663aa2b50f6b018bc2e124f5edf",
    license: "Apache-2.0",
  },
  // macOS: the Vulkan API headers MoltenVK, libplacebo's Vulkan backend and mpv compile against, at the revision
  // MoltenVK pins (ExternalRevisions/Vulkan-Headers_repo_revision). Same fork as libplacebo's 3rdparty submodule.
  vulkanheaders: {
    version: "vulkan-sdk-1.4.357.0",
    repo: "vulkan-headers",
    upstream: { kind: "git", url: "https://github.com/KhronosGroup/Vulkan-Headers" },
    upstreamRef: "vulkan-sdk-1.4.357.0",
    sha: "e3b1eec08173d6b825cd3ac88c885a63b621504a",
    license: "Apache-2.0 AND MIT",
  },
  // macOS: MoltenVK's pipeline-cache serialisation, at the commit MoltenVK v1.4.2 pins
  // (ExternalRevisions/cereal_repo_revision). Without it vkCreatePipelineCache fails and libplacebo renders nothing.
  // Header-only: compiled into libMoltenVK.
  cereal: {
    version: "a56bad8bbb770ee266e930c95d37fff2a5be7fea",
    repo: "cereal",
    upstream: { kind: "git", url: "https://github.com/USCiLab/cereal.git" },
    upstreamRef: "a56bad8bbb770ee266e930c95d37fff2a5be7fea",
    sha: "a56bad8bbb770ee266e930c95d37fff2a5be7fea",
    license: "BSD-3-Clause",
  },
  // macOS: x265 4.2, the first release whose CMakeLists configures with CMake 4 (the Mac runner's Homebrew CMake;
  // 4.1 sets policies CMP0025/CMP0054 to OLD, which CMake 4 refuses) and that passes `-arch` to its AArch64
  // assembly on Apple targets. Same fork as `x265`, another sf/ branch; Linux and Windows stay on 4.1.
  x265macos: {
    version: "4.2",
    repo: "x265",
    upstream: { kind: "git", url: "https://bitbucket.org/multicoreware/x265_git.git" },
    upstreamRef: "4.2",
    sha: "9cda3a4d3aa92e6b8386394e9953fb3ac38e4646",
    license: "GPL-2.0-or-later",
    release: { url: "https://bitbucket.org/multicoreware/x265_git/downloads/x265_4.2.tar.gz", sha256: "40b1ea0453e0309f0eba934e0ddf533f8f6295966679e8894e8f1c1c8d5e1210" },
  },
  shaderc: {
    version: "v2026.4",
    repo: "shaderc",
    upstream: { kind: "git", url: "https://github.com/google/shaderc.git" },
    upstreamRef: "v2026.4",
    sha: "b64fd42c4a2a9d501c47aca5d3571f7673a5e9cc",
    license: "Apache-2.0",
  },
  glslang: {
    version: "e1b562a",
    repo: "glslang",
    upstream: { kind: "git", url: "https://github.com/KhronosGroup/glslang.git" },
    upstreamRef: "e1b562a8bed273a02f30b59b66a5d499793cede5",
    sha: "e1b562a8bed273a02f30b59b66a5d499793cede5",
    license: "BSD-3-Clause AND BSD-2-Clause AND MIT AND Apache-2.0 AND GPL-3.0-or-later WITH Bison-exception-2.2",
  },
  spirvtools: {
    version: "ef96ed7",
    repo: "spirv-tools",
    upstream: { kind: "git", url: "https://github.com/KhronosGroup/SPIRV-Tools.git" },
    upstreamRef: "ef96ed763b43b59b33b31b362f09a02b729fa1c9",
    sha: "ef96ed763b43b59b33b31b362f09a02b729fa1c9",
    license: "Apache-2.0",
  },
  spirvheaders: {
    version: "04fd3ca",
    repo: "spirv-headers",
    upstream: { kind: "git", url: "https://github.com/KhronosGroup/SPIRV-Headers.git" },
    upstreamRef: "04fd3caa1e8267e4d95c806cad901181728e1006",
    sha: "04fd3caa1e8267e4d95c806cad901181728e1006",
    license: "MIT",
  },
  // Android-only (recipes/android-*): libass has no Android font provider, so it reaches the system fonts through
  // fontconfig (the app writes its fonts.conf, see packages/mobile-mpv-playback MpvFontConfig.kt); expat is
  // fontconfig's XML parser.
  expat: {
    version: "2.7.5",
    repo: "expat",
    upstream: { kind: "git", url: "https://github.com/libexpat/libexpat.git" },
    upstreamRef: "R_2_7_5",
    sha: "f31adfd584b7f6c50bbf4d22eb928538ffc9145a",
    license: "MIT",
  },
  fontconfig: {
    version: "2.17.1",
    repo: "fontconfig",
    upstream: { kind: "git", url: "https://gitlab.freedesktop.org/fontconfig/fontconfig.git" },
    upstreamRef: "2.17.1",
    sha: "6d0a98982ec351c165c9224c8b7dbdfca3010e47",
    license: "HPND AND MIT AND Unicode-DFS-2016",
  },
} as const satisfies Record<string, SourceSpec>;

export type SourceId = keyof typeof SOURCES;
