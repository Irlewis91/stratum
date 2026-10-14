#!/bin/bash
# Compiles the VST3 host wrapper and the parts of Steinberg's VST3 SDK it needs into build/libv3-<arch>.a.
# Usage: build-vst3.sh <arch>
set -euo pipefail
cd "$(dirname "$0")"
arch="$1"
SDK="vendor/vst3sdk"
OUT="build/v3-$arch"
mkdir -p "$OUT"
SOURCES=(
  shell/vst3host.mm
  shell/vst2host.mm
  $SDK/public.sdk/source/vst/hosting/module.cpp
  $SDK/public.sdk/source/vst/hosting/module_mac.mm
  $SDK/public.sdk/source/vst/hosting/plugprovider.cpp
  $SDK/public.sdk/source/vst/hosting/hostclasses.cpp
  $SDK/public.sdk/source/vst/hosting/eventlist.cpp
  $SDK/public.sdk/source/vst/hosting/parameterchanges.cpp
  $SDK/public.sdk/source/vst/hosting/pluginterfacesupport.cpp
  $SDK/public.sdk/source/vst/hosting/connectionproxy.cpp
  $SDK/public.sdk/source/vst/utility/stringconvert.cpp
  $SDK/public.sdk/source/vst/vstinitiids.cpp
  $SDK/public.sdk/source/common/memorystream.cpp
  $SDK/public.sdk/source/common/commoniids.cpp
  $SDK/public.sdk/source/common/commonstringconvert.cpp
  $SDK/public.sdk/source/common/threadchecker_mac.mm
  $SDK/pluginterfaces/base/funknown.cpp
  $SDK/pluginterfaces/base/coreiids.cpp
  $SDK/pluginterfaces/base/ustring.cpp
  $SDK/pluginterfaces/base/conststringtable.cpp
  $SDK/base/source/fobject.cpp
  $SDK/base/source/fstring.cpp
  $SDK/base/source/fdebug.cpp
  $SDK/base/source/fbuffer.cpp
  $SDK/base/source/fstreamer.cpp
  $SDK/base/source/baseiids.cpp
  $SDK/base/source/updatehandler.cpp
  $SDK/base/thread/source/flock.cpp
)
objs=()
for f in "${SOURCES[@]}"; do
  [ -f "$f" ] || continue
  o="$OUT/$(basename "$f").o"
  clang++ -std=c++17 -fobjc-arc -O2 -DRELEASE=1 -DNDEBUG -w -target "$arch-apple-macos12.0" -I "$SDK" -I shell -c "$f" -o "$o"
  objs+=("$o")
done
libtool -static -o "build/libv3-$arch.a" "${objs[@]}" 2>/dev/null
