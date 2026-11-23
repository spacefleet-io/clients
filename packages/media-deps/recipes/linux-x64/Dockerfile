# linux-x64 recipe: reduced ffmpeg + ffprobe + mpv from the shared feature list.
#
# Output (`--target out`): /bin holding ffmpeg, ffprobe, mpv and the shared libraries they need,
# all flat, each with RUNPATH=$ORIGIN (no LD_LIBRARY_PATH needed). The HOST provides glibc and its graphics
# stack (HOST_LIBRARIES: GL/EGL, libdrm, X11/xcb, libstdc++, ... — a host GPU driver loads into mpv and must
# share them), so the bundle is built on an old base. Ubuntu 22.04 = glibc 2.35 / GCC 11, supported to 2027;
# minimum host glibc 2.35 with a GCC >= 11 libstdc++.
#
# Build args are produced by `bun run --cwd packages/media-deps build --target linux-x64`
# (src/plan.ts); do not call `docker build` by hand.
FROM ubuntu:22.04 AS base

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates xz-utils bzip2 tar file findutils git \
    build-essential pkg-config nasm yasm cmake ninja-build python3 python3-pip \
    patchelf pax-utils clang \
    libasound2-dev libpulse-dev libluajit-5.1-dev libx11-dev libxext-dev libxrandr-dev libxfixes-dev \
    libx11-xcb-dev libxcb1-dev libxcb-dri3-dev \
    libxpresent-dev libxss-dev libgl1-mesa-dev libegl1-mesa-dev libfreetype-dev \
    libfribidi-dev libharfbuzz-dev libjpeg-dev libass-dev libepoxy-dev libzimg-dev zlib1g-dev \
  && python3 -m pip install --no-cache-dir "meson>=1.3.0,<2" \
  && rm -rf /var/lib/apt/lists/*

COPY recipes/_shared/fetch-source.sh /usr/local/bin/fetch-source
RUN chmod 755 /usr/local/bin/fetch-source
WORKDIR /work
ENV PREFIX=/opt/deps
ENV PKG_CONFIG_PATH=/opt/deps/lib/pkgconfig:/opt/deps/lib/x86_64-linux-gnu/pkgconfig:/opt/deps/share/pkgconfig

# ---- static codec libraries (PIC, linked into libavcodec) -----------------------------------
FROM base AS codecs

ARG SRC_X264_URL
ARG SRC_X264_SHA
RUN --mount=type=secret,id=forge_auth fetch-source x264 "$SRC_X264_URL" "$SRC_X264_SHA" /work/x264 \
  && cd /work/x264 \
  && ./configure --prefix=$PREFIX --enable-static --disable-shared --enable-pic --disable-cli --disable-opencl \
       --bit-depth=8 --chroma-format=420 \
  && make -j"$(nproc)" && make install

ARG SRC_X265_URL
ARG SRC_X265_SHA
RUN --mount=type=secret,id=forge_auth fetch-source x265 "$SRC_X265_URL" "$SRC_X265_SHA" /work/x265 \
  && cmake -S /work/x265/source -B /work/x265/build -G Ninja -DCMAKE_BUILD_TYPE=Release \
       -DCMAKE_INSTALL_PREFIX=$PREFIX -DENABLE_SHARED=OFF -DENABLE_CLI=OFF \
       -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  && cmake --build /work/x265/build && cmake --install /work/x265/build

ARG SRC_LAME_URL
ARG SRC_LAME_SHA
RUN --mount=type=secret,id=forge_auth fetch-source lame "$SRC_LAME_URL" "$SRC_LAME_SHA" /work/lame \
  && cd /work/lame \
  && ./configure --prefix=$PREFIX --enable-static --disable-shared --with-pic --disable-frontend \
  && make -j"$(nproc)" && make install

ARG SRC_DAV1D_URL
ARG SRC_DAV1D_SHA
RUN --mount=type=secret,id=forge_auth fetch-source dav1d "$SRC_DAV1D_URL" "$SRC_DAV1D_SHA" /work/dav1d \
  && meson setup /work/dav1d/build /work/dav1d --prefix=$PREFIX --libdir=lib --buildtype=release \
       --default-library=static -Db_staticpic=true -Denable_tools=false -Denable_tests=false \
  && meson compile -C /work/dav1d/build && meson install -C /work/dav1d/build

# ---- hardware encoder plumbing -------------------------------------------------------------
# NVENC/NVDEC (dlopen'd at runtime: libnvidia-encode / libcuda come from the user's driver) and
# AMF are header-only; Intel QSV goes through the oneVPL dispatcher (static) which dlopens the
# runtime from the user's Intel media driver.
ARG SRC_NVCODEC_URL
ARG SRC_NVCODEC_SHA
RUN --mount=type=secret,id=forge_auth fetch-source nvcodec "$SRC_NVCODEC_URL" "$SRC_NVCODEC_SHA" /work/nvcodec \
  && make -C /work/nvcodec PREFIX=$PREFIX install

ARG SRC_AMF_URL
ARG SRC_AMF_SHA
RUN --mount=type=secret,id=forge_auth fetch-source amf "$SRC_AMF_URL" "$SRC_AMF_SHA" /work/amf \
  && mkdir -p $PREFIX/include/AMF && cp -r /work/amf/AMF/* $PREFIX/include/AMF/

ARG SRC_LIBVPL_URL
ARG SRC_LIBVPL_SHA
RUN --mount=type=secret,id=forge_auth fetch-source libvpl "$SRC_LIBVPL_URL" "$SRC_LIBVPL_SHA" /work/libvpl \
  && cmake -S /work/libvpl -B /work/libvpl/build -G Ninja -DCMAKE_BUILD_TYPE=Release \
       -DCMAKE_INSTALL_PREFIX=$PREFIX -DCMAKE_INSTALL_LIBDIR=lib -DBUILD_SHARED_LIBS=OFF \
       -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DBUILD_TESTS=OFF -DBUILD_EXAMPLES=OFF \
       -DBUILD_TOOLS=OFF -DBUILD_PREVIEW=OFF -DINSTALL_EXAMPLE_CODE=OFF \
  && cmake --build /work/libvpl/build && cmake --install /work/libvpl/build \
  && sed -i 's/^Libs\.private:.*/Libs.private: -lstdc++/' $PREFIX/lib/pkgconfig/vpl.pc

# libva ships as SHARED libraries inside the bundle (VA-API drivers are dlopen'd from the host and bind to the
# libva already loaded); newer than any driver's required VA-API version. libva-x11 gives mpv's vaapi hwdec an
# X11 display (x11egl). libdrm is built only to link against: at runtime it is the host's (HOST_LIBRARIES).
ARG SRC_LIBDRM_URL
ARG SRC_LIBDRM_SHA
RUN --mount=type=secret,id=forge_auth fetch-source libdrm "$SRC_LIBDRM_URL" "$SRC_LIBDRM_SHA" /work/libdrm \
  && meson setup /work/libdrm/build /work/libdrm --prefix=$PREFIX --libdir=lib --buildtype=release \
       -Dintel=disabled -Dradeon=disabled -Damdgpu=disabled -Dnouveau=disabled -Dvmwgfx=disabled \
       -Dfreedreno=disabled -Dvc4=disabled -Detnaviv=disabled -Dtests=false -Dcairo-tests=disabled \
       -Dvalgrind=disabled -Dman-pages=disabled -Dudev=false \
  && meson compile -C /work/libdrm/build && meson install -C /work/libdrm/build

ARG SRC_LIBVA_URL
ARG SRC_LIBVA_SHA
RUN --mount=type=secret,id=forge_auth fetch-source libva "$SRC_LIBVA_URL" "$SRC_LIBVA_SHA" /work/libva \
  && meson setup /work/libva/build /work/libva --prefix=$PREFIX --libdir=lib --buildtype=release \
       -Ddisable_drm=false -Dwith_x11=yes -Dwith_glx=no -Dwith_wayland=no -Denable_docs=false \
       -Ddriverdir=/usr/lib/x86_64-linux-gnu/dri:/usr/lib64/dri:/usr/lib/dri \
  && meson compile -C /work/libva/build && meson install -C /work/libva/build

# ---- ffmpeg + ffprobe (shared libs, shared with mpv) -----------------------------------------
FROM codecs AS ffmpeg

ARG SRC_FFMPEG_URL
ARG SRC_FFMPEG_SHA
ARG FFMPEG_FLAGS
RUN --mount=type=secret,id=forge_auth fetch-source ffmpeg "$SRC_FFMPEG_URL" "$SRC_FFMPEG_SHA" /work/ffmpeg \
  && cd /work/ffmpeg \
  && ./configure --prefix=/opt/ff \
       --pkg-config-flags=--static --enable-pic --enable-shared --disable-static \
       --extra-cflags="-I$PREFIX/include" \
       --extra-ldflags="-L$PREFIX/lib -Wl,--exclude-libs,ALL" \
       $FFMPEG_FLAGS \
  && make -j"$(nproc)" && make install

# ---- libplacebo + mpv ---------------------------------------------------------------------------
FROM ffmpeg AS mpv

ARG SRC_LIBPLACEBO_URL
ARG SRC_LIBPLACEBO_SHA
ARG LIBPLACEBO_MESON_OPTIONS
RUN --mount=type=secret,id=forge_auth fetch-source --submodules libplacebo "$SRC_LIBPLACEBO_URL" "$SRC_LIBPLACEBO_SHA" /work/libplacebo \
  && meson setup /work/libplacebo/build /work/libplacebo --prefix=/opt/placebo --libdir=lib --buildtype=release \
       --default-library=shared -Db_lto=true -Db_ndebug=true $LIBPLACEBO_MESON_OPTIONS \
  && meson compile -C /work/libplacebo/build && meson install -C /work/libplacebo/build

# mpv runs freshly built helper binaries during its own build (they link the bundled libs).
ENV LD_LIBRARY_PATH=/opt/ff/lib:/opt/placebo/lib:/opt/deps/lib:/opt/deps/lib/x86_64-linux-gnu
ARG SRC_MPV_URL
ARG SRC_MPV_SHA
ARG MPV_MESON_OPTIONS
RUN --mount=type=secret,id=forge_auth fetch-source mpv "$SRC_MPV_URL" "$SRC_MPV_SHA" /work/mpv \
  && cd /work/mpv \
  && PKG_CONFIG_PATH="/opt/placebo/lib/pkgconfig:/opt/ff/lib/pkgconfig:$PKG_CONFIG_PATH" meson setup build \
       --prefix=/opt/mpv --buildtype=release --default-library=shared -Db_lto=true -Db_ndebug=true \
       $MPV_MESON_OPTIONS \
  && meson compile -C build && meson install -C build

# ---- assemble the flat bin/ ---------------------------------------------------------------------
FROM mpv AS assemble
ARG HOST_LIBRARIES
COPY recipes/linux-x64/assemble.sh /usr/local/bin/assemble
RUN chmod 755 /usr/local/bin/assemble && assemble

FROM scratch AS out
COPY --from=assemble /opt/out/ /
