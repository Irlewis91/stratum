#!/bin/bash
# Downloads the two third-party files the stem separator needs (both MIT-licensed) and verifies their checksums.
# Without them the app still builds; "Separate stems (AI)" then reports that the model is not included.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p vendor/model

MODEL_URL="https://huggingface.co/StemSplitio/htdemucs-onnx/resolve/d54ed9eb60e258ea82131c6ee14578628816456a/htdemucs.onnx"
MODEL_SHA="68d0bf16428ef66e692cdff8a9ccf28f1ef3f69440d57e58605a4cc55fcc5e74"
ORT_URL="https://github.com/microsoft/onnxruntime/releases/download/v1.31.0/onnxruntime-osx-arm64-1.31.0.tgz"
ORT_SHA="1031b36dd3bdaa8d976a6130d9cf2a05e9be320b93ae804f8427b91dc3432afc"

check() { echo "$2  $1" | shasum -a 256 -c -; }

[ -f vendor/model/htdemucs.onnx ] || curl -fL --retry 3 -o vendor/model/htdemucs.onnx "$MODEL_URL"
check vendor/model/htdemucs.onnx "$MODEL_SHA"

if [ ! -d vendor/onnxruntime-osx-arm64-1.31.0 ]; then
  curl -fL --retry 3 -o vendor/ort.tgz "$ORT_URL"
  check vendor/ort.tgz "$ORT_SHA"
  tar -xzf vendor/ort.tgz -C vendor
  rm vendor/ort.tgz
fi
# Steinberg VST3 SDK (MIT licence), pinned to the commits STRATUM was built against.
sdk() {
  [ -d "vendor/vst3sdk/$1" ] && return
  git clone -q "https://github.com/steinbergmedia/$2.git" "vendor/vst3sdk/$1"
  git -C "vendor/vst3sdk/$1" checkout -q "$3"
}
mkdir -p vendor/vst3sdk
sdk pluginterfaces vst3_pluginterfaces 4f547e8e102b47de4a8b8aaf343c73b700786372
sdk base vst3_base fcf9da0bd27a16f7f03773a3a39822f28f5c8477
sdk public.sdk vst3_public_sdk 586dc5e6c8012c3e4b01c79389375cbe96bdb1da
./fetch-library.sh
echo "Vendor files ready."
