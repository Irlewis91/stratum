#!/bin/bash
# Compiles Airwindows Consolidated (vendor/airwin2rack, MIT licence) and STRATUM's wrapper into build/libaw-<arch>.a.
# The ~1000 effect sources are compiled in parallel and kept between builds. Usage: build-airwin.sh <arch>
set -euo pipefail
cd "$(dirname "$0")"
arch="$1"
AW="vendor/airwin2rack/src"
OUT="build-cache/airwin-$arch"
mkdir -p "$OUT"
compile() {
  local f="$1" o="$OUT/$(basename "$1").o"
  [ -f "$o" ] && [ "$o" -nt "$f" ] && [ "$o" -nt shell/wavesynth.h ] && return 0
  clang++ -std=c++17 -O2 -w -target "$arch-apple-macos12.0" -I "$AW" -I shell -c "$f" -o "$o"
}
export -f compile; export OUT AW arch
{ ls "$AW"/autogen_airwin/*.cpp; echo "$AW/airwin_consolidated_base.cpp"; echo shell/airwin.cpp; echo shell/wavesynth.cpp; } | xargs -P "$(sysctl -n hw.ncpu)" -I{} bash -c 'compile "{}"'
rm -f "build/libaw-$arch.a"
mkdir -p build
find "$OUT" -name '*.o' > "$OUT/list.txt"
libtool -static -o "build/libaw-$arch.a" -filelist "$OUT/list.txt" 2>/dev/null
