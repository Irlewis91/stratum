#!/bin/bash
# Fetches STRATUM's built-in sound library: public-domain (CC0) sounds that may be redistributed, converted to FLAC and
# sorted into vendor/library/<collection>/<category>/, with vendor/library/library.json listing every sound.
#   Stargate sample pack (CC0) - github.com/stargatedaw/stargate-sample-pack, pinned commit
#   Producer Space (CC0)       - archive.org/details/producer-space-cc0-sample-library, selected packs
set -euo pipefail
cd "$(dirname "$0")"
LIB=vendor/library
WORK=build-cache/library-src
mkdir -p "$LIB" "$WORK"

# Stargate: only the folders STRATUM uses (drums, percussion, one-shots, found sounds), fetched sparsely.
SG_COMMIT=dbfd6ec52d4ed53b60bdbea5fc6adf295127c027
if [ ! -d "$WORK/stargate/.git" ]; then
  git clone -q --filter=blob:none --no-checkout https://github.com/stargatedaw/stargate-sample-pack.git "$WORK/stargate"
  git -C "$WORK/stargate" sparse-checkout set --no-cone LICENSE \
    'stargate-sample-pack/freesound/drums/*' 'stargate-sample-pack/fugue-state-audio/drums/*' 'stargate-sample-pack/fugue-state-audio/found-sounds/*' \
    'stargate-sample-pack/karoryfer/hihats/*' 'stargate-sample-pack/karoryfer/kicks/*' 'stargate-sample-pack/karoryfer/percussion/*' \
    'stargate-sample-pack/karoryfer/snares/*' 'stargate-sample-pack/karoryfer/toms/*' 'stargate-sample-pack/microlag/One-Shots/*' \
    'stargate-sample-pack/stargate/hats/*' 'stargate-sample-pack/stargate/kicks/*' 'stargate-sample-pack/sgossner/VCSL/*'
  git -C "$WORK/stargate" checkout -q "$SG_COMMIT"
fi

# Producer Space: vocal shouts, vocal percussion, and the chord and piano MIDI kits.
PS="$WORK/producer-space"
mkdir -p "$PS"
if [ ! -f "$PS/.done" ]; then
  curl -fsSL "https://archive.org/metadata/producer-space-cc0-sample-library" | python3 -I -c '
import sys, json, urllib.parse
keep = ("Packs/Vocal Percussion FX/", "Packs/Dance Vocal Shouts/", "Packs/Dance Vocal Shouts 2/", "Packs/Pop Progressions/", "Packs/House Piano Riffs/")
for f in json.load(sys.stdin)["files"]:
    n = f["name"]
    if f.get("source") == "original" and (n.endswith("LICENSE.txt") or any(k in n for k in keep)) and n.lower().endswith((".wav", ".mid", ".txt")):
        print(n + "\t" + "https://archive.org/download/producer-space-cc0-sample-library/" + urllib.parse.quote(n))
' | while IFS=$'\t' read -r name url; do
    mkdir -p "$PS/$(dirname "$name")"
    [ -f "$PS/$name" ] || curl -fsSL --retry 3 -o "$PS/$name" "$url"
  done
  touch "$PS/.done"
fi

# Sort, convert and index.
python3 -I - "$WORK" "$LIB" <<'PY'
import json, os, re, subprocess, sys, shutil
work, lib = sys.argv[1], sys.argv[2]
def category(path):
    p = path.lower()
    for words, cat in [(("vocal percussion",), "Vocal Percussion"), (("shout",), "Vocal Shouts"), (("vocals",), "Vocals"),
                       (("kick", "bassdrum", "bass drum", "bd"), "Kicks"), (("snare",), "Snares"), (("clap",), "Claps"),
                       (("hihat", "hi-hat", "hats", "closed", "open"), "Hats"), (("cymbal", "crash", "ride"), "Cymbals"),
                       (("tom",), "Toms"), (("rimshot", "rim"), "Percussion"), (("bongo", "conga", "percussion", "membranophone", "drum"), "Percussion"),
                       (("found-sounds",), "Found Sounds"), (("fx",), "FX"), (("progression", "piano riff"), "MIDI")]:
        if any(re.search(r"(^|[^a-z])" + re.escape(w), p) for w in words): return cat
    return "Other"
entries = []
sources = [(os.path.join(work, "stargate", "stargate-sample-pack"), "Stargate (CC0)"), (os.path.join(work, "producer-space", "Producer Space", "Packs"), "Producer Space (CC0)")]
for root, coll in sources:
    for d, _, files in os.walk(root):
        for f in sorted(files):
            src = os.path.join(d, f); rel = os.path.relpath(src, root); ext = f.lower().rsplit(".", 1)[-1]
            if ext not in ("wav", "flac", "aif", "aiff", "mid"): continue
            cat = category(rel)
            name = os.path.splitext(f)[0]
            out_rel = os.path.join(coll, cat, re.sub(r"[^\w\-. ]", "_", os.path.dirname(rel).replace(os.sep, " - ")) + " - " + name if os.path.dirname(rel) else name)
            out_rel = out_rel.replace("/ - ", "/") + (".mid" if ext == "mid" else ".flac")
            dst = os.path.join(lib, out_rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if not os.path.exists(dst):
                if ext == "mid": shutil.copyfile(src, dst)
                else: subprocess.run(["afconvert", "-f", "flac", "-d", "flac", src, dst], check=True, capture_output=True)
            entries.append({"path": out_rel, "name": name, "category": cat, "collection": coll})
for coll, lic in [("Stargate (CC0)", os.path.join(work, "stargate", "LICENSE")), ("Producer Space (CC0)", os.path.join(work, "producer-space", "Producer Space", "LICENSE.txt"))]:
    if os.path.exists(lic): shutil.copyfile(lic, os.path.join(lib, coll, "LICENSE.txt"))
json.dump(entries, open(os.path.join(lib, "library.json"), "w"), indent=0)
from collections import Counter
print(len(entries), "sounds", dict(Counter((e["collection"], e["category"]) for e in entries)))
PY
du -sh "$LIB"
