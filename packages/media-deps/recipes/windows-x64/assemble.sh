#!/bin/bash
# Collect ffmpeg.exe, ffprobe.exe, mpv.exe and ffmpeg's DLLs into ONE flat directory (/opt/out/bin),
# stripped. Everything else (shader compilers, mingw runtime) is linked statically, so this fails when
# any PE file imports a DLL that is neither a Windows system DLL nor shipped in the directory.
set -euo pipefail

OUT=/opt/out/bin
mkdir -p "$OUT"
cp /opt/mpv/bin/mpv.exe /opt/ff/bin/ffmpeg.exe /opt/ff/bin/ffprobe.exe "$OUT/"
cp /opt/ff/bin/*.dll "$OUT/"

for f in "$OUT"/*; do
  x86_64-w64-mingw32-strip --strip-unneeded "$f"
done

# DLLs every Windows 10+ install provides (matched case-insensitively), plus the UCRT forwarders.
SYSTEM_DLLS='^(kernel32|kernelbase|user32|gdi32|gdi32full|advapi32|shell32|shlwapi|ole32|oleaut32|ws2_32|mswsock|iphlpapi|winmm|bcrypt|bcryptprimitives|crypt32|secur32|ntdll|ucrtbase|msvcrt|version|imm32|setupapi|cfgmgr32|userenv|uxtheme|dwmapi|dwrite|d3d11|d3d9|d3dcompiler_47|dxgi|dxva2|opengl32|glu32|comctl32|comdlg32|rpcrt4|wtsapi32|avrt|mmdevapi|propsys|shcore|netapi32|mpr|usp10|windowscodecs|powrprof|psapi|winspool|msimg32|avifil32|msacm32|wintrust|normaliz|wldap32|dnsapi|nvcuda|nvencodeapi64|amfrt64|libmfx64-gen|libvpl)\.dll$|^api-ms-win-.*\.dll$'
status=0
for f in "$OUT"/*; do
  while read -r dll; do
    lower="$(echo "$dll" | tr 'A-Z' 'a-z')"
    if echo "$lower" | grep -Eq "$SYSTEM_DLLS"; then continue; fi
    if [ -e "$OUT/$dll" ] || ls "$OUT" | tr 'A-Z' 'a-z' | grep -qx "$lower"; then continue; fi
    echo "unresolved_import: $(basename "$f") -> $dll" >&2
    status=1
  done < <(x86_64-w64-mingw32-objdump -p "$f" | sed -n 's/^\s*DLL Name: //p')
done
[ "$status" = 0 ] || exit 1
ls -l "$OUT"
