#!/bin/sh
# The Windows release, built on Linux: vibeoffice.exe (mingw) and VibeOfficeSetup.exe, the installer that
# carries it (setup/), zipped alone. Needs: rustup target x86_64-pc-windows-gnu, mingw-w64, zip.
# Output: desktop/target/dist/
set -eu
cd "$(dirname "$0")"

# v2026.10.11-02d794 (tools/current-tree-version.sh): the pages show it (VO.VERSION), the release is tagged with it.
# Windows wants numbers: the exes' file version is 2026.10.11.
VERSION=$(../tools/current-tree-version.sh)
y=$(echo "$VERSION" | cut -c2-5); m=$(echo "$VERSION" | cut -c7-8); d=$(echo "$VERSION" | cut -c10-11)
m=${m#0}; d=${d#0}
OUT=target/x86_64-pc-windows-gnu/release
DIST=target/dist

VO_VERSION=$VERSION TAURI_CONFIG="{\"version\":\"$y.$m.$d\"}" cargo build --release --locked
VO_VERSION=$VERSION cargo build --release --locked -p vibeoffice-setup

# The installer runs from Downloads: it may import only Known DLLs and API sets, which Windows never
# looks for beside it (setup/src/main.rs)
for dll in $(x86_64-w64-mingw32-objdump -p "$OUT/vibeoffice-setup.exe" | sed -n 's/^\tDLL Name: //p' | tr A-Z a-z | sort -u); do
  case $dll in
    advapi32.dll|combase.dll|gdi32.dll|kernel32.dll|msvcrt.dll|ntdll.dll|ole32.dll|oleaut32.dll|shell32.dll|shlwapi.dll|user32.dll|api-ms-win-*) ;;
    *) echo "VibeOfficeSetup.exe imports $dll, which is not a Known DLL" >&2; exit 1 ;;
  esac
done

# Explorer, the shortcuts and Apps & features show the exe's first icon: the app's (32512), not a document's
first_icon=$(python3 - "$OUT/vibeoffice.exe" <<'PY'
import struct, sys
d = open(sys.argv[1], "rb").read()
pe = struct.unpack_from("<I", d, 0x3C)[0]
sections, opt_size = struct.unpack_from("<H", d, pe + 6)[0], struct.unpack_from("<H", d, pe + 20)[0]
opt = pe + 24
rva = struct.unpack_from("<I", d, opt + (112 if struct.unpack_from("<H", d, opt)[0] == 0x20B else 96) + 16)[0]
for i in range(sections):
    vsize, va, _, raw = struct.unpack_from("<IIII", d, opt + opt_size + i * 40 + 8)
    if va <= rva < va + vsize:
        base = raw + rva - va
def entries(off):
    named, ids = struct.unpack_from("<HH", d, base + off + 12)
    return [struct.unpack_from("<II", d, base + off + 16 + 8 * i) for i in range(named + ids)]
print(next(entries(o & 0x7FFFFFFF)[0][0] for t, o in entries(0) if t == 14))
PY
)
[ "$first_icon" = 32512 ] || { echo "vibeoffice.exe's first icon is $first_icon, not the app's (32512)" >&2; exit 1; }

rm -rf "$DIST"
mkdir -p "$DIST"
cp "$OUT/vibeoffice-setup.exe" "$DIST/VibeOfficeSetup.exe"
(cd "$DIST" && zip -q -9 VibeOffice-Windows-x64.zip VibeOfficeSetup.exe)   # one name for every version

ls -l "$DIST"
