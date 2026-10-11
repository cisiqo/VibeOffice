#!/bin/sh
# The Windows release, built on Linux: vibeoffice.exe (mingw), a portable zip and an MSI (wixl).
# Needs: rustup target x86_64-pc-windows-gnu, mingw-w64, wixl (msitools), zip. Output: desktop/target/dist/
set -eu
cd "$(dirname "$0")"

# v2026.10.11-02d794 (tools/current-tree-version.sh): the pages show it (VO.VERSION), the files are named by it.
# Windows wants numbers: the MSI gets 26.10.11 (each field below 256), the exe's file version 2026.10.11.
VERSION=$(../tools/current-tree-version.sh)
y=$(echo "$VERSION" | cut -c2-5); m=$(echo "$VERSION" | cut -c7-8); d=$(echo "$VERSION" | cut -c10-11)
m=${m#0}; d=${d#0}
MSI_VERSION=$((y - 2000)).$m.$d
OUT=target/x86_64-pc-windows-gnu/release
DIST=target/dist

VO_VERSION=$VERSION TAURI_CONFIG="{\"version\":\"$y.$m.$d\"}" cargo build --release --locked

rm -rf "$DIST"
mkdir -p "$DIST/VibeOffice"
cp "$OUT/vibeoffice.exe" "$OUT/WebView2Loader.dll" "$DIST/VibeOffice/"
cp ../LICENSE "$DIST/VibeOffice/LICENSE.txt"

(cd "$DIST" && zip -q -9 -r "VibeOffice-$VERSION-x64.zip" VibeOffice)
wixl -a x64 -D Version="$MSI_VERSION" -D Dist="$DIST/VibeOffice" -D Icon=icons/icon.ico \
  -o "$DIST/VibeOffice-$VERSION-x64.msi" vibeoffice.wxs

ls -l "$DIST"
