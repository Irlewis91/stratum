#!/bin/bash
# Fetches the third-party source code STRATUM compiles in, pinned to the commits it was built against:
# Steinberg's VST3 SDK (MIT licence) and Airwindows Consolidated (MIT licence).
set -euo pipefail
cd "$(dirname "$0")"
sdk() {
  [ -d "vendor/vst3sdk/$1" ] && return
  git clone -q "https://github.com/steinbergmedia/$2.git" "vendor/vst3sdk/$1"
  git -C "vendor/vst3sdk/$1" checkout -q "$3"
}
mkdir -p vendor/vst3sdk
sdk pluginterfaces vst3_pluginterfaces 4f547e8e102b47de4a8b8aaf343c73b700786372
sdk base vst3_base fcf9da0bd27a16f7f03773a3a39822f28f5c8477
sdk public.sdk vst3_public_sdk 586dc5e6c8012c3e4b01c79389375cbe96bdb1da
if [ ! -d vendor/airwin2rack ]; then
  git clone -q https://github.com/baconpaul/airwin2rack.git vendor/airwin2rack
  git -C vendor/airwin2rack checkout -q 8a67b80e04230a5cf40e84d6e8b9a2fd70b13a75
fi
echo "Vendor code ready."
