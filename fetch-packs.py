#!/usr/bin/env python3
"""Builds vendor/library/packs.json: an index of every sound in the CC0 sample packs below. The sounds are not bundled
(about 50,000 files, over 20 GB). The app streams each one from its pinned commit the first time it is used."""
import json, os, re, urllib.request

REPOS = [
    ("sfzinstruments/dsmolken.double-bass", "c2985eb647109d2a8f30a70071e3e163339d7396"),
    ("sfzinstruments/ganjo", "ccff5cd5cd3b513873a48994c07724d9d3c39e1c"),
    ("sfzinstruments/karoryfer-bigcat.cello", "6fd75fbfc1dbb3109bf26220ba1adea46188a18b"),
    ("sfzinstruments/karoryfer.272-merry-orks", "a437e2c02014e02710a104a6692193eab8672d0a"),
    ("sfzinstruments/karoryfer.bear-sax", "7abb3c652525a15dfac80e1b5dfbba9964ee568f"),
    ("sfzinstruments/karoryfer.big-little-bass", "4e92bdf54dcd2d6cfad968cc90542d5461c9b9fc"),
    ("sfzinstruments/karoryfer.big-rusty-drums", "f07ce00df34a46b6b08375be56fe116cf15782bc"),
    ("sfzinstruments/karoryfer.black-and-blue-basses", "6e7d674cdb41be7a54dbccb15472401ad01099b9"),
    ("sfzinstruments/karoryfer.black-and-green-guitars", "b3b3249d37dc977a1a297bd2dc053e6d9b6b805c"),
    ("sfzinstruments/karoryfer.caveman-cosmonaut", "9de9bcfcbc6d2b20bea5c1116cd07a310febc339"),
    ("sfzinstruments/karoryfer.cowsynth", "5a5b5afc2dabbe54cf9d75ab64711ce01862b42c"),
    ("sfzinstruments/karoryfer.emilyguitar", "b4920dc662fd9cad6dcaccdeecffdd91c8725d8c"),
    ("sfzinstruments/karoryfer.ergo", "c3232f03608e07e4e274c8ad9a1a4c32885f75c4"),
    ("sfzinstruments/karoryfer.fashionbass", "0703973b300a6bacb837602be9b588ab64732a72"),
    ("sfzinstruments/karoryfer.frankensnare", "9151c2d79fcbb73c65d63f78918d4ba7abc91a81"),
    ("sfzinstruments/karoryfer.gogodze-phu-vol-i", "7452f62060cd3a468c78bc361d96a4dfb30879c9"),
    ("sfzinstruments/karoryfer.gogodze-phu-vol-ii", "69a0274cdc39c99c3098cde1bc3789690de86d62"),
    ("sfzinstruments/karoryfer.growlybass", "4f483268fc66b5a6d5781d421c0d11b8d08d3fc6"),
    ("sfzinstruments/Karoryfer.HorsePulse", "6f4749d54512d762098ca726a3cbd13444562904"),
    ("sfzinstruments/karoryfer.meatbass", "ac9e859564bda286ab5ec672d00ff1aa2fef2895"),
    ("sfzinstruments/karoryfer.pastabass", "90135cd026db5d4fa0fe538240b4203f085f5244"),
    ("sfzinstruments/karoryfer.scarypiano", "46305e8cb71239bfa861fbe8487dd12b8d8de40c"),
    ("sfzinstruments/karoryfer.shinyguitar", "57243cca85277dbcc120ce17c6178032f93c80f3"),
    ("sfzinstruments/karoryfer.sneakybass", "cc1a67e5c913678b85eaad1a3b5cb180d3be3e2d"),
    ("sfzinstruments/karoryfer.squidpipes", "b258528c8f49d6389ec2b4ec04a8b10013169dd9"),
    ("sfzinstruments/karoryfer.string-cyborgs", "f2238b3e36ae64c6383356221dc89c9c476c7b11"),
    ("sfzinstruments/karoryfer.swagbass", "9d10fcae71af1975988ddecd5af1c95d372c7355"),
    ("sfzinstruments/karoryfer.swirly-drums", "c40dafe0011cb2e54c0c220ff0fa308a11fc60f5"),
    ("sfzinstruments/Karoryfer.TheHatWithThePhat", "afa76f2c9c88e2e27d72a0c2216b1eae3c47b835"),
    ("sfzinstruments/karoryfer.unruly-drums", "9bf75c2a1392f190cd1c264645653629f0b3a097"),
    ("sfzinstruments/karoryfer.war-tuba", "5b62dd6ef6b00281bb734769e44a63f5e013018a"),
    ("sfzinstruments/karoryfer.weresax", "a4d756b21d2a573aca0d840cce7e71ba5effd4c6"),
    ("sfzinstruments/virtuosity_drums", "9f04cf9a734527edfbb0a4eee1f674e45bbf71bc"),
    ("sgossner/VCSL", "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e"),
    ("sgossner/VSCO-2-CE", "440300901dfe9275fd84e0b7763af1f8443ae62e"),
]
STARGATE = ("stargatedaw/stargate-sample-pack", "dbfd6ec52d4ed53b60bdbea5fc6adf295127c027")
ARCHIVE = "producer-space-cc0-sample-library"
BUNDLED_PS = ("Vocal Percussion FX", "Dance Vocal Shouts", "Pop Progressions", "House Piano Riffs")

# Category from the words in a sound's path, then from the pack.
WORDS = [
    (r"sax", "Saxophone"), (r"kick|bass ?drum|bdrum|(^|[^a-z])kd([^a-z]|$)", "Kicks"), (r"snare|(^|[^a-z])sn([^a-z]|$)", "Snares"),
    (r"hi-?hat|(^|[^a-z])hh|(^|[^a-z])hat", "Hats"), (r"tom([^a-z]|$)", "Toms"), (r"cymbal|crash|ride|splash|china", "Cymbals"),
    (r"clap", "Claps"), (r"piano|harpsichord|clavi", "Piano and Keys"), (r"organ", "Organ"), (r"guitar|banjo|strumstick", "Guitar"),
    (r"harp|dan tranh|zither|tagelharpa", "Harp and Plucked"), (r"violin|viola|cello|string", "Strings"),
    (r"trumpet|trombone|horn|tuba", "Brass"), (r"flute|oboe|clarinet|bassoon|recorder|piccolo|ocarina|harmonica", "Woodwinds"),
    (r"marimba|xylophone|vibraphone|glock|tubular|chime|bell", "Mallets and Bells"),
    (r"kalimba|mbira|nyunga|balafon|darbuka|didgeridoo|slit drum|frame drum|bobobo|bagpipe|pipes", "World"),
    (r"conga|bongo|quinto|cajon|shaker|tamb|cowbell|agogo|guiro|clave|cabasa|triangle|woodblock|vibraslap|perc", "Percussion"),
]
DEFAULT = [(r"bass", "Bass"), (r"guitar", "Guitar"), (r"orks|vocal|words|whisper|quote", "Vocals"), (r"synth|cosmonaut", "Synths"), (r"drum|snare|hat", "Percussion")]


def category(pack, path):
    p = path.lower()
    if re.search(r"\b(bass|basses)\b", pack.lower()) and "drum" not in p:
        return "Bass"
    for rx, c in WORDS:
        if re.search(rx, p):
            return c
    for rx, c in DEFAULT:
        if re.search(rx, pack.lower()):
            return c
    return "Other Instruments"


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "stratum-fetch-packs", "Accept": "application/json"})
    if os.environ.get("GH_TOKEN"):
        req.add_header("Authorization", "Bearer " + os.environ["GH_TOKEN"])
    return json.load(urllib.request.urlopen(req, timeout=120))


AUDIO = re.compile(r"\.(wav|flac|aiff?)$", re.I)


def repo_pack(repo, sha, keep=lambda p: True):
    name = re.sub(r"^(karoryfer[-.]|Karoryfer\.)", "", repo.split("/")[1]).replace("bigcat.", "").replace(".", " ").replace("-", " ").replace("_", " ")
    name = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", name).title().replace("Vsco 2 Ce", "VSCO 2 CE").replace("Vcsl", "VCSL")
    tree = get(f"https://api.github.com/repos/{repo}/git/trees/{sha}?recursive=1")
    files = [e["path"] for e in tree["tree"] if e["type"] == "blob" and AUDIO.search(e["path"]) and "/._" not in e["path"] and keep(e["path"])]
    return {"name": name, "base": f"https://raw.githubusercontent.com/{repo}/{sha}/", "license": "CC0-1.0", "source": f"https://github.com/{repo}", "files": [[f, category(name, f)] for f in sorted(files)]}


packs = [repo_pack(r, s) for r, s in REPOS]
packs.append(repo_pack(*STARGATE, keep=lambda p: re.search(r"/(guitar-fx|loops|Loops|synth-fx|noise)/", p) is not None))
packs[-1]["name"] = "Stargate Extras"
meta = get(f"https://archive.org/metadata/{ARCHIVE}")
ps = [f["name"] for f in meta["files"] if f.get("source") == "original" and AUDIO.search(f["name"]) and "Packs/" in f["name"] and not any(("Packs/" + b + "/") in f["name"] for b in BUNDLED_PS)]
packs.append({"name": "Producer Space", "base": f"https://archive.org/download/{ARCHIVE}/", "license": "CC0-1.0", "source": f"https://archive.org/details/{ARCHIVE}", "files": [[f, "Vocals"] for f in sorted(ps)]})
os.makedirs("vendor/library", exist_ok=True)
json.dump(packs, open("vendor/library/packs.json", "w"), separators=(",", ":"))
print(sum(len(p["files"]) for p in packs), "sounds in", len(packs), "packs")
