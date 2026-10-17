#!/bin/bash
# Packages the Windows download: STRATUM.exe (built by the "Windows build" GitHub workflow) plus the web app.
# Usage: ./package-windows.sh path/to/STRATUM.exe
set -euo pipefail
cd "$(dirname "$0")"
EXE="$1"
./build-web.sh >/dev/null
rm -rf dist-win && mkdir -p dist-win/STRATUM
cp "$EXE" dist-win/STRATUM/STRATUM.exe
cp -R dist-web dist-win/STRATUM/app
rm -f dist-win/STRATUM/app/sw.js dist-win/STRATUM/app/.nojekyll
cat > dist-win/STRATUM/READ\ ME.txt <<'TXT'
STRATUM for Windows (alpha)

1. Unzip this folder anywhere (for example Documents), keeping STRATUM.exe and the "app" folder together.
2. Double-click STRATUM.exe.
   Windows may show "Windows protected your PC" because STRATUM is not code-signed yet:
   choose "More info", then "Run anyway".

Needs Windows 10 or 11 (64-bit). STRATUM uses Microsoft Edge WebView2, which is already part of Windows 10 and 11.

This first Windows version has the full beat-making workspace, built-in sounds and effects, the sound library,
recording from your microphone, importing projects, exporting and branded share videos.
Not in the Windows version yet: VST plugins, STRATUM Wave, stem separation, recording from another app and Go live.
TXT
(cd dist-win && rm -f STRATUM-Windows.zip && zip -qr -X STRATUM-Windows.zip STRATUM)
echo "Packaged dist-win/STRATUM-Windows.zip ($(du -h dist-win/STRATUM-Windows.zip | cut -f1))"
