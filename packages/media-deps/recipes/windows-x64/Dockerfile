# windows-x64 recipe: reduced ffmpeg.exe + ffprobe.exe + mpv.exe from the shared feature list,
# CROSS-BUILT with mingw-w64 (UCRT) on Linux. The Windows VM only RUNS the result.
#
# Output (`--target out`): /bin holding ffmpeg.exe, ffprobe.exe, mpv.exe and ffmpeg's own DLLs, all flat.
# Codec libraries (x264, x265, lame, dav1d, libvpl) are linked statically into avcodec-*.dll; libass,
# zimg, libplacebo, luajit and the shader compilers (shaderc, SPIRV-Cross) are linked statically into
# mpv.exe, and so is the mingw runtime (winpthread, libstdc++, libgcc) everywhere. assemble.sh fails the
# build on any import that is neither a Windows system DLL nor one of ffmpeg's DLLs.
#
# Build args are produced by `bun run --cwd packages/media-deps build --target windows-x64`
# (src/plan.ts); do not call `docker build` by hand.
FROM debian:trixie AS base

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates xz-utils bzip2 tar file findutils git \
    build-essential pkg-config nasm yasm cmake ninja-build python3 python3-jinja2 python3-mako meson \
    autoconf automake libtool autopoint gettext gperf clang llvm \
    gcc-mingw-w64-ucrt64 g++-mingw-w64-ucrt64 binutils-mingw-w64-ucrt64 mingw-w64-ucrt64-dev \
  && rm -rf /var/lib/apt/lists/*

# The ucrt64 compilers are named x86_64-w64-mingw32ucrt-*; every build system below (autotools,
# cmake, meson, ffmpeg --cross-prefix) uses the plain x86_64-w64-mingw32- prefix.
RUN for tool in /usr/bin/x86_64-w64-mingw32ucrt-*; do \
      name="$(basename "$tool")"; \
      ln -sf "$tool" "/usr/local/bin/x86_64-w64-mingw32-${name#x86_64-w64-mingw32ucrt-}"; \
    done \
  # Link the mingw runtime statically: without these import libraries `-lpthread` (GCC's posix thread model
  # adds it to every link) and `-lstdc++` (Libs.private of the static C++ libraries mpv links with the C
  # driver, where -static-libstdc++ does not apply) resolve to libwinpthread.a / libstdc++.a, not the DLLs.
  && find /usr/x86_64-w64-mingw32ucrt /usr/lib/gcc/x86_64-w64-mingw32ucrt \
       \( -name 'libwinpthread*.dll.a' -o -name 'libpthread.dll.a' -o -name 'libstdc++.dll.a' \) -print -delete \
  && x86_64-w64-mingw32-gcc --version | head -1

COPY recipes/_shared/fetch-source.sh /usr/local/bin/fetch-source
COPY recipes/windows-x64/pkg-config.sh /usr/local/bin/x86_64-w64-mingw32-pkg-config
COPY recipes/windows-x64/toolchain.cmake recipes/windows-x64/meson-cross.ini /opt/recipe/
RUN chmod 755 /usr/local/bin/fetch-source /usr/local/bin/x86_64-w64-mingw32-pkg-config
WORKDIR /work
ENV PREFIX=/opt/win
ENV HOST=x86_64-w64-mingw32
ENV CROSS_CMAKE="-DCMAKE_TOOLCHAIN_FILE=/opt/recipe/toolchain.cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/win -DCMAKE_POLICY_VERSION_MINIMUM=3.5"
ENV CROSS_MESON="--cross-file /opt/recipe/meson-cross.ini --prefix=/opt/win --libdir=lib --buildtype=release"

# ---- small static libraries --------------------------------------------------------------------
FROM base AS codecs

ARG SRC_ZLIB_URL
ARG SRC_ZLIB_SHA
RUN --mount=type=secret,id=forge_auth fetch-source zlib "$SRC_ZLIB_URL" "$SRC_ZLIB_SHA" /work/zlib \
  && cd /work/zlib \
  && CHOST=$HOST CROSS_PREFIX=x86_64-w64-mingw32- ./configure --prefix=$PREFIX --static \
  && make -j"$(nproc)" && make install

ARG SRC_X264_URL
ARG SRC_X264_SHA
RUN --mount=type=secret,id=forge_auth fetch-source x264 "$SRC_X264_URL" "$SRC_X264_SHA" /work/x264 \
  && cd /work/x264 \
  && ./configure --host=$HOST --cross-prefix=x86_64-w64-mingw32- --prefix=$PREFIX --enable-static --disable-cli \
       --disable-opencl --bit-depth=8 --chroma-format=420 \
  && make -j"$(nproc)" && make install

ARG SRC_X265_URL
ARG SRC_X265_SHA
RUN --mount=type=secret,id=forge_auth fetch-source x265 "$SRC_X265_URL" "$SRC_X265_SHA" /work/x265 \
  && cmake -S /work/x265/source -B /work/x265/build -G Ninja $CROSS_CMAKE \
       -DENABLE_SHARED=OFF -DENABLE_CLI=OFF -DENABLE_ASSEMBLY=ON \
  && cmake --build /work/x265/build && cmake --install /work/x265/build

ARG SRC_LAME_URL
ARG SRC_LAME_SHA
RUN --mount=type=secret,id=forge_auth fetch-source lame "$SRC_LAME_URL" "$SRC_LAME_SHA" /work/lame \
  && cd /work/lame \
  && ./configure --host=$HOST --prefix=$PREFIX --enable-static --disable-shared --disable-frontend --disable-gtktest \
  && make -j"$(nproc)" && make install

ARG SRC_DAV1D_URL
ARG SRC_DAV1D_SHA
RUN --mount=type=secret,id=forge_auth fetch-source dav1d "$SRC_DAV1D_URL" "$SRC_DAV1D_SHA" /work/dav1d \
  && meson setup /work/dav1d/build /work/dav1d $CROSS_MESON --default-library=static \
       -Denable_tools=false -Denable_tests=false \
  && meson compile -C /work/dav1d/build && meson install -C /work/dav1d/build

# ---- hardware encoder plumbing -----------------------------------------------------------------
# NVENC/NVDEC (nvEncodeAPI64.dll / nvcuda.dll come from the user's driver) and AMF (amfrt64.dll) are
# header-only; Intel QSV goes through the oneVPL dispatcher (static), which loads the runtime
# from the Intel graphics driver.
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
  && cmake -S /work/libvpl -B /work/libvpl/build -G Ninja $CROSS_CMAKE -DCMAKE_INSTALL_LIBDIR=lib \
       -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_TOOLS=OFF \
       -DBUILD_PREVIEW=OFF -DINSTALL_EXAMPLE_CODE=OFF \
  && cmake --build /work/libvpl/build && cmake --install /work/libvpl/build \
  && sed -i 's/^Libs\.private:.*/Libs.private: -lstdc++/' $PREFIX/lib/pkgconfig/vpl.pc

# ---- ffmpeg + ffprobe (shared DLLs, shared with mpv) -------------------------------------------
FROM codecs AS ffmpeg

ARG SRC_FFMPEG_URL
ARG SRC_FFMPEG_SHA
ARG FFMPEG_FLAGS
RUN --mount=type=secret,id=forge_auth fetch-source ffmpeg "$SRC_FFMPEG_URL" "$SRC_FFMPEG_SHA" /work/ffmpeg \
  && cd /work/ffmpeg \
  && ./configure --prefix=/opt/ff --enable-shared --disable-static --pkg-config-flags=--static \
       --extra-cflags="-I$PREFIX/include" \
       --extra-ldflags="-L$PREFIX/lib -static-libgcc -static-libstdc++" \
       $FFMPEG_FLAGS \
  && make -j"$(nproc)" && make install \
  # mpv links the DLLs dynamically: their private (static) dependencies must not leak into its link line.
  && sed -i -e '/^Libs\.private:/d' -e '/^Requires\.private:/d' /opt/ff/lib/pkgconfig/*.pc

# ---- mpv's own dependencies: static libraries --------------------------------------------------
FROM ffmpeg AS mpvdeps

ARG SRC_FREETYPE_URL
ARG SRC_FREETYPE_SHA
RUN --mount=type=secret,id=forge_auth fetch-source freetype "$SRC_FREETYPE_URL" "$SRC_FREETYPE_SHA" /work/freetype \
  && meson setup /work/freetype/build /work/freetype $CROSS_MESON --default-library=static \
       -Dzlib=system -Dbzip2=disabled -Dpng=disabled -Dharfbuzz=disabled -Dbrotli=disabled \
  && meson compile -C /work/freetype/build && meson install -C /work/freetype/build

ARG SRC_HARFBUZZ_URL
ARG SRC_HARFBUZZ_SHA
RUN --mount=type=secret,id=forge_auth fetch-source harfbuzz "$SRC_HARFBUZZ_URL" "$SRC_HARFBUZZ_SHA" /work/harfbuzz \
  && meson setup /work/harfbuzz/build /work/harfbuzz $CROSS_MESON --default-library=static \
       -Dfreetype=enabled -Dglib=disabled -Dgobject=disabled -Dcairo=disabled -Dicu=disabled \
       -Dgdi=disabled -Ddirectwrite=disabled -Dtests=disabled -Ddocs=disabled -Dbenchmark=disabled \
  && meson compile -C /work/harfbuzz/build && meson install -C /work/harfbuzz/build

ARG SRC_FRIBIDI_URL
ARG SRC_FRIBIDI_SHA
RUN --mount=type=secret,id=forge_auth fetch-source fribidi "$SRC_FRIBIDI_URL" "$SRC_FRIBIDI_SHA" /work/fribidi \
  && meson setup /work/fribidi/build /work/fribidi $CROSS_MESON --default-library=static \
       -Dtests=false -Ddocs=false -Dbin=false \
  && meson compile -C /work/fribidi/build && meson install -C /work/fribidi/build

# libass renders subtitles with DirectWrite on Windows: no fontconfig, no font files shipped.
# The fork carries libass's generated autotools files, and a git checkout gives them arbitrary mtimes: make may then
# see aclocal.m4 as older than configure.ac / m4/*.m4 and call aclocal-1.17. Stamp them in dependency order
# (aclocal.m4, then configure, then Makefile.in / config.h.in) so make never regenerates.
ARG SRC_LIBASS_URL
ARG SRC_LIBASS_SHA
RUN --mount=type=secret,id=forge_auth fetch-source libass "$SRC_LIBASS_URL" "$SRC_LIBASS_SHA" /work/libass \
  && cd /work/libass \
  && touch aclocal.m4 && touch configure && find . \( -name Makefile.in -o -name config.h.in \) -exec touch {} + \
  && PKG_CONFIG=x86_64-w64-mingw32-pkg-config ./configure --host=$HOST --prefix=$PREFIX --enable-static --disable-shared \
       --disable-fontconfig --enable-directwrite --disable-require-system-font-provider \
  && make -j"$(nproc)" && make install

ARG SRC_ZIMG_URL
ARG SRC_ZIMG_SHA
RUN --mount=type=secret,id=forge_auth fetch-source zimg "$SRC_ZIMG_URL" "$SRC_ZIMG_SHA" /work/zimg \
  && cd /work/zimg \
  && ./autogen.sh \
  && ./configure --host=$HOST --prefix=$PREFIX --enable-static --disable-shared \
  && make -j"$(nproc)" && make install

ARG SRC_LUAJIT_URL
ARG SRC_LUAJIT_SHA
RUN --mount=type=secret,id=forge_auth fetch-source luajit "$SRC_LUAJIT_URL" "$SRC_LUAJIT_SHA" /work/luajit \
  && cd /work/luajit \
  && make -j"$(nproc)" HOST_CC="gcc" CROSS=x86_64-w64-mingw32- TARGET_SYS=Windows BUILDMODE=static \
  # `make install` copies src/luajit, but a Windows build produces src/luajit.exe.
  && cp src/luajit.exe src/luajit \
  && make install PREFIX=$PREFIX CROSS=x86_64-w64-mingw32- TARGET_SYS=Windows BUILDMODE=static HOST_CC="gcc" \
  # Windows has no libdl; the pkg-config file lists it as a private dependency.
  && sed -i '/^Libs\.private:/d' $PREFIX/lib/pkgconfig/luajit.pc

# ---- shader compilers for the Direct3D 11 renderer (static, into mpv.exe) ----------------------
# mpv and libplacebo look SPIRV-Cross up as `spirv-cross-c-shared` and shaderc as `shaderc`: both names
# point at the static libraries. Only the HLSL backend is used (GLSL is its base); MSL, C++ and reflection
# are off so the C API does not drag them in.
ARG SRC_SPIRVCROSS_URL
ARG SRC_SPIRVCROSS_SHA
RUN --mount=type=secret,id=forge_auth fetch-source spirvcross "$SRC_SPIRVCROSS_URL" "$SRC_SPIRVCROSS_SHA" /work/spirvcross \
  && cmake -S /work/spirvcross -B /work/spirvcross/build -G Ninja $CROSS_CMAKE \
       -DSPIRV_CROSS_SHARED=OFF -DSPIRV_CROSS_STATIC=ON -DSPIRV_CROSS_CLI=OFF -DSPIRV_CROSS_ENABLE_TESTS=OFF \
       -DSPIRV_CROSS_ENABLE_MSL=OFF -DSPIRV_CROSS_ENABLE_CPP=OFF -DSPIRV_CROSS_ENABLE_REFLECT=OFF -DSPIRV_CROSS_ENABLE_UTIL=OFF \
  && cmake --build /work/spirvcross/build && cmake --install /work/spirvcross/build \
  && version="$(sed -n 's/^set(spirv-cross-abi-\(major\|minor\|patch\) \([0-9]*\))$/\2/p' /work/spirvcross/CMakeLists.txt | paste -sd.)" \
  && echo "spirv-cross abi version: $version" && [ -n "$version" ] \
  && printf '%s\n' "prefix=$PREFIX" 'libdir=${prefix}/lib' 'includedir=${prefix}/include/spirv_cross' '' \
       'Name: spirv-cross-c-shared' 'Description: SPIRV-Cross C API (static: HLSL + GLSL backends)' "Version: $version" \
       'Libs: -L${libdir} -lspirv-cross-c -lspirv-cross-hlsl -lspirv-cross-glsl -lspirv-cross-core -lstdc++' \
       'Cflags: -I${includedir}' > $PREFIX/lib/pkgconfig/spirv-cross-c-shared.pc \
  && cat $PREFIX/lib/pkgconfig/spirv-cross-c-shared.pc

ARG SRC_SHADERC_URL
ARG SRC_SHADERC_SHA
ARG SRC_GLSLANG_URL
ARG SRC_GLSLANG_SHA
ARG SRC_SPIRVTOOLS_URL
ARG SRC_SPIRVTOOLS_SHA
ARG SRC_SPIRVHEADERS_URL
ARG SRC_SPIRVHEADERS_SHA
RUN --mount=type=secret,id=forge_auth fetch-source shaderc "$SRC_SHADERC_URL" "$SRC_SHADERC_SHA" /work/shaderc \
  && fetch-source glslang "$SRC_GLSLANG_URL" "$SRC_GLSLANG_SHA" /work/shaderc/third_party/glslang \
  && fetch-source spirv-tools "$SRC_SPIRVTOOLS_URL" "$SRC_SPIRVTOOLS_SHA" /work/shaderc/third_party/spirv-tools \
  && fetch-source spirv-headers "$SRC_SPIRVHEADERS_URL" "$SRC_SPIRVHEADERS_SHA" /work/shaderc/third_party/spirv-headers \
  && cmake -S /work/shaderc -B /work/shaderc/build -G Ninja $CROSS_CMAKE \
       -DSHADERC_SKIP_TESTS=ON -DSHADERC_SKIP_EXAMPLES=ON -DSHADERC_SKIP_COPYRIGHT_CHECK=ON \
       -DSHADERC_SKIP_EXECUTABLES=ON -DSPIRV_SKIP_TESTS=ON -DSPIRV_SKIP_EXECUTABLES=ON \
       -DSPIRV_WERROR=OFF -DENABLE_GLSLANG_BINARIES=OFF -DSHADERC_ENABLE_WERROR_COMPILE=OFF \
  && cmake --build /work/shaderc/build && cmake --install /work/shaderc/build \
  # shaderc_combined = shaderc + glslang + SPIRV-Tools in one static archive; the shared build is not shipped.
  # It is C++, and mpv links with the C driver: the static C++ runtime goes on its Libs line.
  && sed '/^Libs:/{/-lstdc++/!s/$/ -lstdc++/}' $PREFIX/lib/pkgconfig/shaderc_combined.pc > $PREFIX/lib/pkgconfig/shaderc.pc \
  && rm -f $PREFIX/bin/libshaderc_shared.dll $PREFIX/lib/libshaderc_shared.dll.a \
  && cat $PREFIX/lib/pkgconfig/shaderc.pc

# ---- libplacebo + mpv ------------------------------------------------------------------------------
FROM mpvdeps AS mpv

ARG SRC_LIBPLACEBO_URL
ARG SRC_LIBPLACEBO_SHA
ARG LIBPLACEBO_MESON_OPTIONS
RUN --mount=type=secret,id=forge_auth fetch-source --submodules libplacebo "$SRC_LIBPLACEBO_URL" "$SRC_LIBPLACEBO_SHA" /work/libplacebo \
  && meson setup /work/libplacebo/build /work/libplacebo $CROSS_MESON --default-library=static \
       -Db_lto=true -Db_ndebug=true $LIBPLACEBO_MESON_OPTIONS \
  && meson compile -C /work/libplacebo/build && meson install -C /work/libplacebo/build

ARG SRC_MPV_URL
ARG SRC_MPV_SHA
ARG MPV_MESON_OPTIONS
# MPV-MODEL-05: mpv.exe carries Badger's icon and the name "Badger Player" (brand-mpv.sh).
COPY recipes/windows-x64/brand-mpv.sh recipes/windows-x64/badger-player.ico /opt/recipe/
RUN --mount=type=secret,id=forge_auth fetch-source mpv "$SRC_MPV_URL" "$SRC_MPV_SHA" /work/mpv \
  && sh /opt/recipe/brand-mpv.sh /work/mpv /opt/recipe/badger-player.ico \
  && meson setup /work/mpv/build /work/mpv $CROSS_MESON --prefix=/opt/mpv -Db_lto=true -Db_ndebug=true $MPV_MESON_OPTIONS \
  && meson compile -C /work/mpv/build && meson install -C /work/mpv/build

# ---- assemble the flat bin/ ----------------------------------------------------------------------------
FROM mpv AS assemble
COPY recipes/windows-x64/assemble.sh /usr/local/bin/assemble
RUN chmod 755 /usr/local/bin/assemble && assemble

FROM scratch AS out
COPY --from=assemble /opt/out/ /
