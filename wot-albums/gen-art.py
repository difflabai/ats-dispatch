#!/usr/bin/env python3
"""Generate album cover art via nano-gpt gpt-image-2 API."""
import os, sys, json, base64, urllib.request

KEY = os.environ["NANOGPT_API_KEY"]
OUT = "/ml2/nanobot/projects/ada-dispatch/wot-albums/img"

ALBUMS = {
    "the-chosen": "Album cover art, square. The Forsaken, the Chosen of the Dark One from Wheel of Time. Thirteen dark robed figures wreathed in violet and black flame against a void, an epic dark symphonic metal aesthetic. Gothic cathedral of shadow, cracked obsidian throne, ominous purple light, a broken seal glowing. Painterly cinematic dramatic dark fantasy, deep blacks and amethyst purple, no text.",
    "the-taint-on-saidin": "Album cover art, square. The corruption of saidin, the male half of the One Power. An oily iridescent stain creeping over a crystalline source of light, madness and decay, a man's silhouette descending into insanity. Dark industrial doom aesthetic, dissonant oppressive atmosphere, sickly oily rainbow sheen over grey rot, cracked stone, a tainted glowing orb. Bleak painterly horror fantasy, desaturated with oily highlights, no text.",
    "the-bad-ending": "Album cover art, square. A dystopian cyberpunk noir vision of the compute divide. A lone disconnected figure outside a towering walled data-center city glowing with cold cyan server light, rain, neon, vinyl-crackle grain. Dark trip-hop aesthetic, Massive Attack meets cyberpunk. Moody teal and deep blue, isolation, a silicon ceiling overhead, no text.",
}

ENDPOINT = "https://nano-gpt.com/v1/images/generations"
MODELS = ["gpt-image-2", "gpt-image-1"]  # try requested model, fall back

os.makedirs(OUT, exist_ok=True)


def generate(prompt):
    last_err = None
    for model in MODELS:
        body = json.dumps({"model": model, "prompt": prompt, "n": 1,
                           "size": "1024x1024", "response_format": "b64_json"}).encode()
        req = urllib.request.Request(
            ENDPOINT, data=body,
            headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                print(f"  ok with model={model}", flush=True)
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            last_err = f"model={model} HTTP {e.code}: {e.read().decode()[:300]}"
            print(f"  {last_err}", flush=True)
    raise SystemExit(f"all models failed: {last_err}")


for name, prompt in ALBUMS.items():
    print(f"=== {name} ===", flush=True)
    data = generate(prompt)
    item = data["data"][0]
    out = f"{OUT}/{name}.jpg"
    if item.get("b64_json"):
        with open(out, "wb") as f:
            f.write(base64.b64decode(item["b64_json"]))
    elif item.get("url"):
        urllib.request.urlretrieve(item["url"], out)
    else:
        print(f"Unexpected response keys: {list(item.keys())}", flush=True)
        sys.exit(3)
    print(f"saved {out} ({os.path.getsize(out)} bytes)", flush=True)

print("ALL ART DONE", flush=True)
