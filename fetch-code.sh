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
# ONNX Runtime for Windows (MIT licence), for stem separation in the Windows app. Only fetched on Windows.
if [ "${OS:-}" = "Windows_NT" ] && [ ! -d vendor/onnxruntime-win-x64-1.31.0 ]; then
  curl -fsSL --retry 3 -o vendor/ort-win.zip https://github.com/microsoft/onnxruntime/releases/download/v1.31.0/onnxruntime-win-x64-1.31.0.zip
  echo "3958d8a44984160692c1b4ffd0de3cb48f8c39f9d34bb31e433db06e30b82195  vendor/ort-win.zip" | sha256sum -c -
  unzip -q vendor/ort-win.zip -d vendor && rm vendor/ort-win.zip
fi
echo "Vendor code ready."
