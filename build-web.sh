#!/bin/bash
# Builds the STRATUM web app (phones, tablets, browsers, and the inside of the Windows app) into dist-web/.
set -euo pipefail
cd "$(dirname "$0")"
OUT="dist-web"
rm -rf "$OUT"
cp -R web "$OUT"
[ -d vendor/library ] && cp -R vendor/library "$OUT/library"
[ -f "docs/STRATUM Owner's Manual.pdf" ] && cp "docs/STRATUM Owner's Manual.pdf" "$OUT/manual.pdf"
mkdir -p "$OUT/licenses"
cp vendor/library/*LICENSE* vendor/library/*NOTICE* "$OUT/licenses/" 2>/dev/null || true
# Offline cache list: everything except the library sounds, which are cached as they are used.
python3 - "$OUT" <<'PY'
import os, sys, json, time
out = sys.argv[1]
files = ['./']
for root, _, names in os.walk(out):
    for n in names:
        rel = os.path.relpath(os.path.join(root, n), out).replace(os.sep, '/')
        if rel.startswith('library/') and rel != 'library/library.json': continue
        if rel in ('sw.js', 'manual.pdf') or n.startswith('.'): continue
        files.append(rel)
sw = open(os.path.join(out, 'sw.js')).read().replace('__BUILD__', time.strftime('%Y%m%d%H%M%S')).replace('__SHELL__', json.dumps(sorted(files)))
open(os.path.join(out, 'sw.js'), 'w').write(sw)
PY
touch "$OUT/.nojekyll"
echo "Web app built in $OUT ($(du -sh "$OUT" | cut -f1))"
