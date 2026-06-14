#!/usr/bin/env python3
"""Generate JS album entries for the 3 new Mureka-only albums and splice into js/albums.js."""
import json, re

BASE = "/ml2/nanobot/projects/ada-dispatch/wot-albums"

# durations (seconds) probed via ffprobe
DUR = {
    "the-chosen": {
        "i-betrayer": 188.79, "daughter-of-the-night": 175.44, "the-beautiful-voice": 165.75,
        "spiders-web": 186.51, "the-golden-general": 173.95, "the-art-of-serving": 178.76,
        "the-music-of-the-spheres": 187.66, "the-chosen": 214.31,
    },
    "the-taint-on-saidin": {
        "the-breaking": 156.58, "oily-light": 150.15, "voices-in-the-stone": 175.31,
        "gentled": 153.63, "hundred-companions": 221.44, "false-dragon": 149.11,
        "cleansing": 157.39, "clean": 180.98,
    },
    "the-bad-ending": {
        "the-divide": 173.27, "token-gate": 160.76, "silicon-ceiling": 188.24,
        "ghost-in-the-stack": 154.70, "the-subscription": 163.63, "shards": 198.50,
        "permissionless": 156.58, "last-seed": 192.18,
    },
}

# album id -> (config dir, character/performer label)
SPECS = [
    ("the-chosen", "the-chosen", "The Forsaken"),
    ("the-taint-on-saidin", "the-taint-on-saidin", "The Hundred Companions"),
    ("the-bad-ending", "the-bad-ending", "The Disconnected"),
]


def fmt_dur(sec):
    m = int(sec // 60)
    s = int(round(sec - m * 60))
    if s == 60:
        m += 1
        s = 0
    return f"{m}:{s:02d}"


def js_str(s):
    return json.dumps(s, ensure_ascii=False)


def build_album(album_id, cfg_dir):
    cfg = json.load(open(f"{BASE}/{cfg_dir}/config.json"))
    results = json.load(open(f"{BASE}/{cfg_dir}/results.json"))
    durs = DUR[album_id]

    # map slug -> url from results
    url_by_slug = {}
    for key, val in results.items():
        if "variants" in val:  # chosen / taint format
            slug = val.get("slug", key)
            url_by_slug[slug] = val["variants"][0]["url"]
        else:  # bad-ending format (key is slug)
            url_by_slug[key] = val["url"]

    tracks = []
    for t in cfg["tracks"]:
        slug = t["slug"]
        url = url_by_slug.get(slug)
        if not url:
            raise SystemExit(f"NO URL for {album_id}/{slug}; have {list(url_by_slug)}")
        dur = fmt_dur(durs[slug])
        tracks.append(
            "      { title: " + js_str(t["title"]) +
            ", duration: " + js_str(dur) +
            ", url: " + js_str(url) +
            ", lyrics: " + js_str(t["lyrics"]) + " }"
        )

    lines = []
    lines.append("  {")
    lines.append("    id: " + js_str(album_id) + ",")
    lines.append("    title: " + js_str(cfg["album_title"]) + ",")
    lines.append("    character: " + js_str(cfg["performer"]) + ",")
    lines.append("    color: " + js_str(cfg["color"]) + ",")
    lines.append("    accent: " + js_str(cfg["accent"]) + ",")
    lines.append("    murekaOnly: true,")
    lines.append("    description: " + js_str(cfg["description"]) + ",")
    lines.append("    tracks: [")
    lines.append(",\n".join(tracks))
    lines.append("    ]")
    lines.append("  }")
    return "\n".join(lines)


entries = [build_album(aid, cdir) for aid, cdir, _ in SPECS]
new_block = ",\n" + ",\n".join(entries) + "\n"

src = open(f"{BASE}/js/albums.js").read()

# Guard against re-running
for aid, _, _ in SPECS:
    if f'id: "{aid}"' in src:
        raise SystemExit(f"Album {aid} already present in albums.js — aborting to avoid dup")

# splice before the final "\n];"
m = re.search(r"\n\];\s*$", src)
if not m:
    raise SystemExit("Could not find closing '];' in albums.js")
src = src[: m.start()] + new_block + "];\n"
open(f"{BASE}/js/albums.js", "w").write(src)
print("Spliced 3 albums into albums.js")
for aid, _, _ in SPECS:
    print(" -", aid)
