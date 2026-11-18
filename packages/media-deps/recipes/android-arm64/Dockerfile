# Android libmpv (android-arm64, android-arm, android-x64 and android-ia32: the four Dockerfiles are identical; the
# architecture comes from the build args of recipes/_android/androidTarget.ts). Every step is
# recipes/_android/steps/<step>.sh, copied into its own stage, so editing one step rebuilds from that stage on.
#
# Output (`--target out`): /lib/<android abi>/ holding libmpv.so, libplayer.so (JNI bridge of is.xyz.mpv.MPVLib),
# libav{codec,filter,format,util}.so, libsw{resample,scale}.so and libc++_shared.so: the jniLibs tree
# packages/mobile-mpv-playback/android packages.
#
# Build args are produced by `bun run --cwd packages/media-deps build --target android-<arch>` (src/plan.ts);
# do not call `docker build` by hand.
FROM ubuntu:22.04 AS base

# build-essential: the BUILD machine's compiler, for the generators fribidi and mpv compile and run during the build
# (the libraries themselves are built only with the NDK).
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl unzip xz-utils file findutils git patchelf \
    build-essential pkg-config nasm cmake ninja-build python3 python3-pip gperf \
  && python3 -m pip install --no-cache-dir "meson>=1.3.0,<2" \
  && rm -rf /var/lib/apt/lists/*

COPY recipes/_shared/fetch-source.sh /usr/local/bin/fetch-source
COPY recipes/_android/env.sh /recipe/env.sh
RUN chmod 755 /usr/local/bin/fetch-source
WORKDIR /work

ARG NDK_VERSION
ARG NDK_URL
ARG NDK_SHA256
ARG ANDROID_API
ARG ANDROID_ABI
ARG ANDROID_TRIPLE
ARG MESON_CPU_FAMILY
ENV NDK_VERSION=$NDK_VERSION ANDROID_API=$ANDROID_API ANDROID_ABI=$ANDROID_ABI ANDROID_TRIPLE=$ANDROID_TRIPLE \
  MESON_CPU_FAMILY=$MESON_CPU_FAMILY
COPY recipes/_android/steps/toolchain.sh /recipe/steps/
RUN NDK_URL="$NDK_URL" NDK_SHA256="$NDK_SHA256" /recipe/steps/toolchain.sh

# ---- static libraries (dav1d into libavcodec; the libass stack into libmpv) ----------------------------------
FROM base AS libs
ARG SRC_DAV1D_URL
ARG SRC_DAV1D_SHA
ARG SRC_FREETYPE_URL
ARG SRC_FREETYPE_SHA
ARG SRC_HARFBUZZ_URL
ARG SRC_HARFBUZZ_SHA
ARG SRC_FRIBIDI_URL
ARG SRC_FRIBIDI_SHA
ARG SRC_EXPAT_URL
ARG SRC_EXPAT_SHA
ARG SRC_FONTCONFIG_URL
ARG SRC_FONTCONFIG_SHA
ARG SRC_LIBASS_URL
ARG SRC_LIBASS_SHA
COPY recipes/_android/steps/libs.sh /recipe/steps/
RUN --mount=type=secret,id=forge_auth /recipe/steps/libs.sh

# ---- ffmpeg (shared) -----------------------------------------------------------------------------------------
FROM libs AS ffmpeg
ARG SRC_FFMPEGMOBILE_URL
ARG SRC_FFMPEGMOBILE_SHA
ARG FFMPEG_FLAGS
COPY recipes/_android/steps/ffmpeg.sh /recipe/steps/
RUN --mount=type=secret,id=forge_auth /recipe/steps/ffmpeg.sh

# ---- libplacebo + libmpv.so ----------------------------------------------------------------------------------
FROM ffmpeg AS mpv
ARG SRC_LIBPLACEBO_URL
ARG SRC_LIBPLACEBO_SHA
ARG LIBPLACEBO_MESON_OPTIONS
ARG SRC_MPV_URL
ARG SRC_MPV_SHA
ARG MPV_MESON_OPTIONS
COPY recipes/_android/steps/mpv.sh /recipe/steps/
RUN --mount=type=secret,id=forge_auth /recipe/steps/mpv.sh

# ---- libplayer.so (JNI) + the jniLibs tree -------------------------------------------------------------------
FROM mpv AS assemble
COPY recipes/_android/jni/ /recipe/jni/
COPY recipes/_android/steps/player.sh recipes/_android/steps/assemble.sh /recipe/steps/
RUN /recipe/steps/player.sh && /recipe/steps/assemble.sh

FROM scratch AS out
COPY --from=assemble /opt/out/ /
