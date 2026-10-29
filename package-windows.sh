#!/bin/bash
# Packages the Windows download: STRATUM.exe (built by the "Windows build" GitHub workflow) plus the web app.
# Usage: ./package-windows.sh path/to/STRATUM.exe
set -euo pipefail
cd "$(dirname "$0")"
EXE="$1"
./build-web.sh >/dev/null
rm -rf dist-win && mkdir -p dist-win/STRATUM
cp "$EXE" dist-win/STRATUM/STRATUM.exe
# Stem separation: ONNX Runtime (from the same build) and the HT-Demucs model, both MIT-licensed.
ORT_DLL="$(dirname "$EXE")/onnxruntime.dll"
if [ -f "$ORT_DLL" ] && [ -f vendor/model/htdemucs.onnx ]; then
  cp "$ORT_DLL" dist-win/STRATUM/
  mkdir -p dist-win/STRATUM/models dist-win/STRATUM/licenses
  cp vendor/model/htdemucs.onnx dist-win/STRATUM/models/
  for d in vendor/onnxruntime-win-x64-1.31.0 vendor/onnxruntime-osx-arm64-1.31.0; do   # same project, same licence files
    [ -f "$d/LICENSE" ] && { cp "$d/LICENSE" dist-win/STRATUM/licenses/onnxruntime-LICENSE.txt; cp "$d/ThirdPartyNotices.txt" dist-win/STRATUM/licenses/onnxruntime-ThirdPartyNotices.txt; break; }
  done
  printf 'HT-Demucs stem separation model (htdemucs.onnx)\nONNX export: https://huggingface.co/StemSplitio/htdemucs-onnx (MIT licence)\nOriginal model: Demucs, Meta Platforms, Inc. (MIT licence) https://github.com/facebookresearch/demucs\nONNX Runtime for Windows (MIT licence) https://github.com/microsoft/onnxruntime\n' > dist-win/STRATUM/licenses/stems-NOTICE.txt
fi
cp -R dist-web dist-win/STRATUM/app
[ -f "docs/STRATUM Owner's Manual.pdf" ] && cp "docs/STRATUM Owner's Manual.pdf" "dist-win/STRATUM/STRATUM Owner's Manual.pdf"
rm -f dist-win/STRATUM/app/sw.js dist-win/STRATUM/app/.nojekyll
mkdir -p dist-win/STRATUM/licenses
cp vendor/vst3sdk/public.sdk/LICENSE.txt dist-win/STRATUM/licenses/vst3sdk-LICENSE.txt
cp vendor/airwin2rack/LICENSE.md dist-win/STRATUM/licenses/airwindows-consolidated-LICENSE.txt
cat > dist-win/STRATUM/READ\ ME.txt <<'TXT'
STRATUM for Windows (alpha)

1. Unzip this folder anywhere (for example Documents), keeping STRATUM.exe and the "app" folder together.
2. Double-click STRATUM.exe.
   Windows may show "Windows protected your PC" because STRATUM is not code-signed yet:
   choose "More info", then "Run anyway".

Needs Windows 10 or 11 (64-bit). STRATUM uses Microsoft Edge WebView2, which is already part of Windows 10 and 11.

Everything in the Mac version is here: the beat-making workspace, built-in sounds and effects, the sound library,
VST3 and VST2 plugins (with their own windows), STRATUM Wave, STRATUM Tune, 508 Airwindows effects, stem separation,
recording from your microphone or from another app, importing projects, exporting, branded share videos, Visuals,
Go live and syncing. (Audio Units are a Mac-only plugin format; on Windows the same plugins come as VST3 or VST2.)

VST3 plugins are found in C:\Program Files\Common Files\VST3, and VST2 plugins in the usual VST folders.
Go live and Record from another app may ask for camera and microphone access in Settings > Privacy & security.
TXT
(cd dist-win && rm -f STRATUM-Windows.zip && zip -qr -X STRATUM-Windows.zip STRATUM)
echo "Packaged dist-win/STRATUM-Windows.zip ($(du -h dist-win/STRATUM-Windows.zip | cut -f1))"
