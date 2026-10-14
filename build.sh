#!/bin/bash
# Builds STRATUM.app (universal: Apple silicon + Intel) and packages it as STRATUM.dmg.
set -euo pipefail
cd "$(dirname "$0")"
VERSION="0.1.0"
OUT="dist"
APP="$OUT/STRATUM.app"
rm -rf "$OUT" build
mkdir -p build "$APP/Contents/MacOS" "$APP/Contents/Resources"

ORT="vendor/onnxruntime-osx-arm64-1.31.0"
for arch in arm64 x86_64; do
  clang -O2 -c -target "$arch-apple-macos12.0" -I "$ORT/include" shell/stems.c -o "build/stems-$arch.o"
  ./build-vst3.sh "$arch"
  swiftc -O -target "$arch-apple-macos12.0" -import-objc-header shell/bridge.h -I vendor/vst3sdk shell/main.swift shell/plugins.swift "build/stems-$arch.o" "build/libv3-$arch.a" -Xlinker -lc++ -o "build/stratum-$arch"
done
lipo -create build/stratum-arm64 build/stratum-x86_64 -output "$APP/Contents/MacOS/STRATUM"

cp -R web "$APP/Contents/Resources/web"

# Stem separation: ONNX Runtime (Apple silicon only) and the HT-Demucs model, both MIT-licensed.
if [ -f vendor/model/htdemucs.onnx ] && [ -f "$ORT/lib/libonnxruntime.1.31.0.dylib" ]; then
  mkdir -p "$APP/Contents/Frameworks" "$APP/Contents/Resources/models" "$APP/Contents/Resources/licenses"
  cp "$ORT/lib/libonnxruntime.1.31.0.dylib" "$APP/Contents/Frameworks/libonnxruntime.dylib"
  cp vendor/model/htdemucs.onnx "$APP/Contents/Resources/models/htdemucs.onnx"
  cp "$ORT/LICENSE" "$APP/Contents/Resources/licenses/onnxruntime-LICENSE.txt"
  cp "$ORT/ThirdPartyNotices.txt" "$APP/Contents/Resources/licenses/onnxruntime-ThirdPartyNotices.txt"
  printf 'HT-Demucs stem separation model (htdemucs.onnx)\nONNX export: https://huggingface.co/StemSplitio/htdemucs-onnx (MIT licence)\nOriginal model: Demucs, Meta Platforms, Inc. (MIT licence) https://github.com/facebookresearch/demucs\n' > "$APP/Contents/Resources/licenses/htdemucs-NOTICE.txt"
fi

mkdir -p "$APP/Contents/Resources/licenses"
cp vendor/vst3sdk/public.sdk/LICENSE.txt "$APP/Contents/Resources/licenses/vst3sdk-LICENSE.txt"

swift shell/icon.swift assets/stratum-icon.png build/icon.png
mkdir -p build/AppIcon.iconset
for s in 16 32 128 256 512; do
  sips -z $s $s build/icon.png --out "build/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) build/icon.png --out "build/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns build/AppIcon.iconset -o "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>STRATUM</string>
  <key>CFBundleDisplayName</key><string>STRATUM</string>
  <key>CFBundleIdentifier</key><string>com.stratum.daw</string>
  <key>CFBundleExecutable</key><string>STRATUM</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.music</string>
  <key>NSMicrophoneUsageDescription</key><string>STRATUM records audio from your microphone or audio interface onto the tracks you arm.</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
EOF

codesign --force --deep --sign - "$APP"

mkdir -p build/dmg
cp -R "$APP" build/dmg/
ln -s /Applications build/dmg/Applications
hdiutil create -volname "STRATUM" -srcfolder build/dmg -ov -format UDZO "$OUT/STRATUM.dmg" >/dev/null
echo "Built $APP and $OUT/STRATUM.dmg"
