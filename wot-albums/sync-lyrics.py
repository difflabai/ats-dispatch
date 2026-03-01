#!/usr/bin/env python3
"""
Line-by-line lyric sync using Demucs vocal isolation + stable-ts forced alignment.

Pipeline: audio -> Demucs vocal separation -> Whisper forced alignment -> line timestamps

Usage:
    # Sync all tracks in an album (default: Demucs + medium model)
    python sync-lyrics.py --album wolves-and-hammers

    # Sync specific track
    python sync-lyrics.py --album wolves-and-hammers --track "The Forge Before Dawn"

    # Use variant B audio
    python sync-lyrics.py --album wolves-and-hammers --variant b

    # Skip Demucs (use raw audio — faster but less accurate)
    python sync-lyrics.py --album wolves-and-hammers --no-demucs

    # Use a different whisper model
    python sync-lyrics.py --album wolves-and-hammers --model small

    # Force re-process (ignore cached vocals/timings)
    python sync-lyrics.py --album wolves-and-hammers --force

    # Sync all albums
    python sync-lyrics.py --all

    # Dry run (show what would be processed)
    python sync-lyrics.py --album wolves-and-hammers --dry-run

    # Output as standalone JSON (not JS)
    python sync-lyrics.py --album wolves-and-hammers --format json
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
AUDIO_CACHE_DIR = SCRIPT_DIR / ".audio-cache"
JS_DIR = SCRIPT_DIR / "js"

B2_BASE = "https://f004.backblazeb2.com/file/adas-storage/music"


def load_albums():
    """Load album data from albums.js by evaluating with Node."""
    albums_js = JS_DIR / "albums.js"
    node_script = f"""
    const fs = require('fs');
    const src = fs.readFileSync({json.dumps(str(albums_js))}, 'utf8');
    const fn = new Function(src + '; return ALBUMS;');
    const albums = fn();
    console.log(JSON.stringify(albums));
    """
    result = subprocess.run(
        ["node", "-e", node_script],
        capture_output=True, text=True, timeout=10
    )
    if result.returncode != 0:
        print(f"Error loading albums.js: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    return json.loads(result.stdout)


def get_audio_url(track_url, variant):
    """Switch variant in a track URL."""
    if variant is None:
        return track_url
    return re.sub(r'-[ab]\.mp3$', f'-{variant}.mp3', track_url)


def download_audio(url, cache_dir):
    """Download audio file, using cache. Returns local path."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    filename = url.split("/")[-1]
    cached = cache_dir / filename
    if cached.exists() and cached.stat().st_size > 0:
        return str(cached)

    print(f"  Downloading: {filename}")
    result = subprocess.run(
        ["curl", "-sL", "-o", str(cached), url],
        capture_output=True, timeout=120
    )
    if result.returncode != 0 or not cached.exists() or cached.stat().st_size == 0:
        print(f"  ERROR: Failed to download {url}", file=sys.stderr)
        if cached.exists():
            cached.unlink()
        return None
    return str(cached)


def _load_demucs_model():
    """Load Demucs model (cached as module-level singleton)."""
    global _demucs_model
    if _demucs_model is not None:
        return _demucs_model

    import torch
    from demucs.pretrained import get_model

    print("  Loading Demucs htdemucs model...")
    model = get_model("htdemucs")
    model.eval()
    if torch.cuda.is_available():
        model = model.cuda()
    _demucs_model = model
    return model


_demucs_model = None


def separate_vocals(audio_path, cache_dir, force=False):
    """
    Use Demucs to separate vocals from the mix via Python API.
    Returns path to the isolated vocals WAV file.
    Caches results in cache_dir/vocals/.
    """
    audio_name = Path(audio_path).stem
    vocals_dir = Path(cache_dir) / "vocals"
    vocals_dir.mkdir(parents=True, exist_ok=True)
    vocals_path = vocals_dir / f"{audio_name}-vocals.wav"

    if vocals_path.exists() and vocals_path.stat().st_size > 0 and not force:
        print(f"  Using cached vocals: {vocals_path.name}")
        return str(vocals_path)

    print(f"  Separating vocals with Demucs (htdemucs)...")
    start = time.time()

    try:
        import torch
        import numpy as np
        import soundfile as sf
        from demucs.apply import apply_model

        model = _load_demucs_model()

        # Convert mp3 to wav with ffmpeg, then load with soundfile
        import tempfile
        tmp_fd, tmp_wav = tempfile.mkstemp(suffix=".wav")
        os.close(tmp_fd)
        try:
            result = subprocess.run(
                ["ffmpeg", "-y", "-i", audio_path, "-ar", str(model.samplerate),
                 "-ac", "2", tmp_wav],
                capture_output=True, timeout=30
            )
            if result.returncode != 0:
                print(f"  ERROR: ffmpeg conversion failed", file=sys.stderr)
                return None

            data, sr = sf.read(tmp_wav)
        finally:
            if os.path.exists(tmp_wav):
                os.unlink(tmp_wav)

        # Convert to torch tensor (channels, samples) and add batch dim
        wav = torch.from_numpy(data.T).float().unsqueeze(0)
        if torch.cuda.is_available():
            wav = wav.cuda()

        # Run separation
        with torch.no_grad():
            sources = apply_model(model, wav)

        # Extract vocals
        vocals_idx = model.sources.index("vocals")
        vocals = sources[0, vocals_idx].cpu().numpy().T

        # Save to cache
        sf.write(str(vocals_path), vocals, model.samplerate)

    except Exception as e:
        print(f"  ERROR: Demucs failed: {e}", file=sys.stderr)
        if vocals_path.exists():
            vocals_path.unlink()
        return None

    elapsed = time.time() - start
    print(f"  Vocals separated in {elapsed:.1f}s -> {vocals_path.name}")
    return str(vocals_path)


def parse_lyrics_lines(lyrics_text):
    """Extract content lines from lyrics, filtering section headers and blanks."""
    lines = []
    for raw in lyrics_text.split("\n"):
        stripped = raw.strip()
        if not stripped:
            continue
        if re.match(r'^\[.*\]$', stripped):
            continue
        lines.append(stripped)
    return lines


def get_audio_duration(audio_path):
    """Get audio duration in seconds using ffprobe."""
    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", audio_path],
        capture_output=True, text=True, timeout=10
    )
    if result.returncode == 0 and result.stdout.strip():
        return float(result.stdout.strip())
    return None


def _count_syllables(word):
    """English syllable estimation heuristic."""
    word = re.sub(r'[^a-z]', '', word.lower())
    if not word:
        return 0
    if len(word) <= 2:
        return 1
    matches = re.findall(r'[aeiouy]+', word)
    count = len(matches) if matches else 1
    if word.endswith('e') and count > 1 and not word.endswith('le'):
        count -= 1
    if re.search(r'(tion|sion)$', word):
        count = max(count, 2)
    return max(1, count)


def _line_syllables(text):
    """Count syllables in a line of text."""
    return sum(_count_syllables(w) for w in text.split())


def _min_duration_for_line(text):
    """Calculate minimum duration for a lyric line based on syllable count.
    Sung lyrics need ~0.2s per syllable minimum, with a floor of 1.5s."""
    syllables = _line_syllables(text)
    return max(1.5, syllables * 0.2)


def postprocess_alignment(lines, audio_duration=None):
    """
    Fix degenerate alignments: overlapping, zero-duration, or bunched-up lines.

    Passes:
    1. Detect & redistribute bunched regions using syllable-weighted spacing
    1b. Clamp over-long lines (>15s)
    2. Expand too-short low-confidence lines to syllable-based minimum
    3. Fix overlapping boundaries
    4. Ensure minimum line duration (1.5s or syllable-based)
    """
    if not lines or len(lines) < 2:
        return lines

    fixed = [dict(l) for l in lines]  # deep-ish copy
    n = len(fixed)

    # Pass 1: Detect bunched regions — syllable-weighted redistribution
    i = 0
    while i < n - 2:
        j = i
        while j < n - 1 and (fixed[j + 1]["time"] - fixed[j]["time"]) < 0.5:
            j += 1

        bunch_size = j - i + 1
        if bunch_size >= 3:
            region_start = fixed[i]["time"]
            if j + 1 < n:
                region_end = fixed[j + 1]["time"]
            elif audio_duration:
                region_end = audio_duration - 2.0
            else:
                region_end = region_start + bunch_size * 6.0

            span = region_end - region_start

            # Syllable-weighted distribution
            syllable_counts = []
            for k in range(bunch_size):
                idx = i + k
                syl = max(1, _line_syllables(fixed[idx]["text"]))
                syllable_counts.append(syl)
            total_syl = sum(syllable_counts)

            print(f"  [fix] Redistributing {bunch_size} bunched lines "
                  f"({region_start:.1f}s-{region_end:.1f}s, {total_syl} syllables)")

            cursor = region_start
            for k in range(bunch_size):
                idx = i + k
                line_dur = span * (syllable_counts[k] / total_syl)
                fixed[idx]["time"] = round(cursor, 2)
                fixed[idx]["endTime"] = round(cursor + line_dur, 2)
                fixed[idx]["confidence"] = min(fixed[idx].get("confidence", 0.5), 0.4)
                cursor += line_dur

            i = j + 1
        else:
            i += 1

    # Pass 1b: Fix over-long lines (>15s)
    MAX_LINE_DUR = 15.0
    for i in range(n):
        dur = fixed[i]["endTime"] - fixed[i]["time"]
        if dur > MAX_LINE_DUR:
            word_count = len(fixed[i]["text"].split())
            estimated_dur = max(3.0, min(8.0, word_count * 0.5))
            new_end = round(fixed[i]["time"] + estimated_dur, 2)
            print(f"  [fix] Clamping over-long line {i+1} from {dur:.1f}s to {estimated_dur:.1f}s")
            fixed[i]["endTime"] = new_end
            if fixed[i]["confidence"] > 0.4:
                fixed[i]["confidence"] = 0.4

    # Pass 2: Borrow time from neighbors for critically short lines
    # A line is "critical" if its duration < its syllable-based minimum.
    # We borrow from prev/next neighbors proportionally to their surplus.
    for i in range(n):
        dur = fixed[i]["endTime"] - fixed[i]["time"]
        min_dur = _min_duration_for_line(fixed[i]["text"])
        if dur >= min_dur:
            continue

        deficit = min_dur - dur
        borrowed = 0

        # Try borrowing from previous line
        if i > 0:
            prev_dur = fixed[i - 1]["endTime"] - fixed[i - 1]["time"]
            prev_min = _min_duration_for_line(fixed[i - 1]["text"])
            prev_surplus = prev_dur - prev_min
            if prev_surplus > 0.3:
                give = min(deficit * 0.5, prev_surplus * 0.5)
                fixed[i - 1]["endTime"] = round(fixed[i - 1]["endTime"] - give, 2)
                fixed[i]["time"] = round(fixed[i]["time"] - give, 2)
                borrowed += give

        # Try borrowing from next line
        if i + 1 < n and borrowed < deficit:
            next_dur = fixed[i + 1]["endTime"] - fixed[i + 1]["time"]
            next_min = _min_duration_for_line(fixed[i + 1]["text"])
            next_surplus = next_dur - next_min
            if next_surplus > 0.3:
                give = min(deficit - borrowed, next_surplus * 0.5)
                fixed[i]["endTime"] = round(fixed[i]["endTime"] + give, 2)
                fixed[i + 1]["time"] = round(fixed[i + 1]["time"] + give, 2)
                borrowed += give

        if borrowed > 0.1:
            new_dur = fixed[i]["endTime"] - fixed[i]["time"]
            print(f"  [fix] Borrowed {borrowed:.1f}s for line {i+1} "
                  f"({dur:.1f}s -> {new_dur:.1f}s): {fixed[i]['text'][:50]}")

    # Pass 3: Fix overlapping boundaries
    for i in range(n - 1):
        if fixed[i]["endTime"] > fixed[i + 1]["time"]:
            mid = (fixed[i]["endTime"] + fixed[i + 1]["time"]) / 2
            fixed[i]["endTime"] = round(mid, 2)
            fixed[i + 1]["time"] = round(mid, 2)

    # Pass 4: Ensure minimum line duration (syllable-based, floor 1.5s)
    for i in range(n):
        dur = fixed[i]["endTime"] - fixed[i]["time"]
        min_dur = _min_duration_for_line(fixed[i]["text"])
        if dur < min_dur:
            # Don't push past next line start
            max_end = fixed[i + 1]["time"] if i + 1 < n else (audio_duration or fixed[i]["time"] + min_dur)
            fixed[i]["endTime"] = round(min(fixed[i]["time"] + min_dur, max_end), 2)

    return fixed


def align_track(model, audio_path, lyrics_text, track_title, use_demucs=True,
                cache_dir=None, force=False):
    """
    Run forced alignment on a single track.
    Returns list of {time, endTime, text, confidence} per line.

    If use_demucs=True, separates vocals first for better alignment.
    """
    content_lines = parse_lyrics_lines(lyrics_text)
    if not content_lines:
        print(f"  WARNING: No lyrics lines found for '{track_title}'")
        return []

    # Separate vocals if requested
    align_audio = audio_path
    if use_demucs and cache_dir:
        vocals = separate_vocals(audio_path, cache_dir, force=force)
        if vocals:
            align_audio = vocals
        else:
            print(f"  WARNING: Vocal separation failed, using raw audio")

    text_for_alignment = "\n".join(content_lines)
    audio_duration = get_audio_duration(audio_path)  # Use original for duration

    print(f"  Aligning {len(content_lines)} lines against {audio_duration:.0f}s audio...")
    try:
        result = model.align(
            align_audio,
            text_for_alignment,
            language="en",
            original_split=True,
            verbose=False,
        )
    except Exception as e:
        print(f"  ERROR aligning '{track_title}': {e}", file=sys.stderr)
        return []

    # Extract line-level data from segments
    aligned_lines = []
    for segment in result.segments:
        word_probs = []
        if hasattr(segment, 'words') and segment.words:
            for w in segment.words:
                if hasattr(w, 'probability'):
                    word_probs.append(w.probability)

        confidence = round(sum(word_probs) / len(word_probs), 2) if word_probs else 0.8

        seg_text = segment.text.strip()
        if not seg_text:
            continue

        aligned_lines.append({
            "time": round(segment.start, 2),
            "endTime": round(segment.end, 2),
            "text": seg_text,
            "confidence": confidence,
        })

    # Post-process to fix degenerate alignments
    aligned_lines = postprocess_alignment(aligned_lines, audio_duration)

    return aligned_lines


def format_timings_js(all_data):
    """Format aligned data as lyrics-timings.js content (line-level only)."""
    output = "// Lyrics timing data for WoT albums\n"
    output += "// Line-by-line forced alignment via Demucs + stable-ts (Whisper)\n"
    output += f"// Generated: {time.strftime('%Y-%m-%d')}\n"
    output += "window.lyricsTimings = window.lyricsTimings || {};\n\n"

    for album_id, tracks in sorted(all_data.items()):
        album_timings = {}
        for track_title, lines in tracks.items():
            album_timings[track_title] = {
                "lines": [
                    {
                        "time": l["time"],
                        "endTime": l["endTime"],
                        "text": l["text"],
                    }
                    for l in lines
                ]
            }
        output += f'window.lyricsTimings["{album_id}"] = '
        output += json.dumps(album_timings, indent=2) + ";\n\n"

    return output


def format_reference_js(all_data):
    """Format aligned data as sync-reference.js content."""
    output = "// Reference (ground-truth) timing data for sync quality analysis\n"
    output += "// Generated from forced alignment via Demucs + stable-ts (Whisper)\n"
    output += f"// Generated: {time.strftime('%Y-%m-%d')}\n"
    output += "// confidence: model confidence score (0-1), 1.0 = manually verified\n"
    output += "window.syncReference = window.syncReference || {};\n\n"

    for album_id, tracks in sorted(all_data.items()):
        ref_data = {}
        for track_title, lines in tracks.items():
            ref_data[track_title] = {
                "lines": [
                    {
                        "time": l["time"],
                        "endTime": l["endTime"],
                        "text": l["text"],
                        "confidence": l["confidence"],
                    }
                    for l in lines
                ]
            }
        output += f'window.syncReference["{album_id}"] = '
        output += json.dumps(ref_data, indent=2) + ";\n\n"

    return output


def main():
    parser = argparse.ArgumentParser(
        description="Line-by-line lyric sync via Demucs + stable-ts forced alignment"
    )
    parser.add_argument("--album", help="Album ID to process (e.g. wolves-and-hammers)")
    parser.add_argument("--track", help="Specific track title to process")
    parser.add_argument("--variant", choices=["a", "b"], help="Audio variant (default: use URL as-is)")
    parser.add_argument("--model", default="medium", help="Whisper model size (tiny/base/small/medium/large)")
    parser.add_argument("--all", action="store_true", help="Process all albums")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be processed")
    parser.add_argument("--no-demucs", action="store_true", help="Skip vocal separation (faster but less accurate)")
    parser.add_argument("--force", action="store_true", help="Force re-process (ignore cached vocals)")
    parser.add_argument("--format", choices=["js", "json"], default="js", help="Output format")
    parser.add_argument("--output-dir", default=str(JS_DIR), help="Output directory")
    parser.add_argument("--cache-dir", default=str(AUDIO_CACHE_DIR), help="Audio cache directory")
    args = parser.parse_args()

    if not args.album and not args.all:
        parser.error("Specify --album ALBUM_ID or --all")

    albums = load_albums()
    album_map = {a["id"]: a for a in albums}

    # Determine which albums to process
    if args.all:
        target_albums = albums
    else:
        if args.album not in album_map:
            print(f"Unknown album: {args.album}", file=sys.stderr)
            print(f"Available: {', '.join(sorted(album_map.keys()))}", file=sys.stderr)
            sys.exit(1)
        target_albums = [album_map[args.album]]

    # Filter to albums with audio
    target_albums = [a for a in target_albums if any(t.get("url") for t in a["tracks"])]
    if not target_albums:
        print("No albums with audio URLs found.", file=sys.stderr)
        sys.exit(1)

    # Show plan
    total_tracks = 0
    for album in target_albums:
        tracks = [t for t in album["tracks"] if t.get("url")]
        if args.track:
            tracks = [t for t in tracks if t["title"] == args.track]
            if not tracks:
                print(f"Track '{args.track}' not found in {album['id']}", file=sys.stderr)
                titles = [t["title"] for t in album["tracks"]]
                print(f"Available: {', '.join(titles)}", file=sys.stderr)
                sys.exit(1)
        total_tracks += len(tracks)
        if args.dry_run:
            demucs_status = "raw" if args.no_demucs else "demucs"
            print(f"\n{album['title']} ({album['id']}) [{demucs_status}]:")
            for t in tracks:
                url = get_audio_url(t["url"], args.variant)
                n_lines = len(parse_lyrics_lines(t["lyrics"]))
                print(f"  - {t['title']} ({n_lines} lines) -> {url.split('/')[-1]}")

    if args.dry_run:
        demucs_str = "with Demucs vocal separation" if not args.no_demucs else "raw audio"
        print(f"\nTotal: {len(target_albums)} album(s), {total_tracks} track(s) ({demucs_str})")
        return

    # Load model
    print(f"Loading Whisper model '{args.model}'...")
    import stable_whisper
    model = stable_whisper.load_model(args.model)
    print("Model loaded.")
    if not args.no_demucs:
        print("Demucs vocal separation: ENABLED")
    print()

    cache_dir = Path(args.cache_dir)
    use_demucs = not args.no_demucs

    # Process
    all_data = {}
    stats = {"albums": 0, "tracks": 0, "lines": 0, "failed": 0}

    for album in target_albums:
        album_id = album["id"]
        print(f"=== {album['title']} ({album_id}) ===")
        all_data[album_id] = {}

        tracks = [t for t in album["tracks"] if t.get("url")]
        if args.track:
            tracks = [t for t in tracks if t["title"] == args.track]

        album_cache = cache_dir / album_id

        for track in tracks:
            title = track["title"]
            url = get_audio_url(track["url"], args.variant)
            print(f"\n[{title}]")

            # Download audio
            audio_path = download_audio(url, album_cache)
            if not audio_path:
                stats["failed"] += 1
                continue

            # Align (with optional vocal separation)
            lines = align_track(
                model, audio_path, track["lyrics"], title,
                use_demucs=use_demucs, cache_dir=str(album_cache),
                force=args.force,
            )
            if lines:
                all_data[album_id][title] = lines
                stats["tracks"] += 1
                stats["lines"] += len(lines)
                print(f"  -> {len(lines)} lines aligned")
                for l in lines[:3]:
                    print(f"     {l['time']:6.2f}s: {l['text'][:60]}")
                if len(lines) > 3:
                    print(f"     ... ({len(lines) - 3} more)")
            else:
                stats["failed"] += 1

        stats["albums"] += 1
        print()

    # Output
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.format == "json":
        out_path = output_dir / "sync-aligned.json"
        with open(out_path, "w") as f:
            json.dump(all_data, f, indent=2)
        print(f"Written: {out_path}")
    else:
        # Write lyrics-timings.js (merge with existing if processing subset)
        timings_path = output_dir / "lyrics-timings.js"
        if not args.all and timings_path.exists():
            print("Merging with existing lyrics-timings.js...")
            existing = load_existing_timings(timings_path)
            for album_id, tracks in all_data.items():
                if album_id not in existing:
                    existing[album_id] = {}
                for track_title, lines in tracks.items():
                    existing[album_id][track_title] = lines
            js_content = format_timings_js(existing)
        else:
            js_content = format_timings_js(all_data)

        with open(timings_path, "w") as f:
            f.write(js_content)
        print(f"Written: {timings_path}")

        # Write sync-reference.js (merge with existing if processing subset)
        ref_path = output_dir / "sync-reference.js"
        if not args.all and ref_path.exists():
            print("Merging with existing sync-reference.js...")
            existing_ref = load_existing_reference(ref_path)
            for album_id, tracks in all_data.items():
                if album_id not in existing_ref:
                    existing_ref[album_id] = {}
                for track_title, lines in tracks.items():
                    existing_ref[album_id][track_title] = lines
            ref_content = format_reference_js(existing_ref)
        else:
            ref_content = format_reference_js(all_data)

        with open(ref_path, "w") as f:
            f.write(ref_content)
        print(f"Written: {ref_path}")

    # Summary
    demucs_str = " (Demucs+Whisper)" if use_demucs else " (Whisper only)"
    print(f"\nDone{demucs_str}: {stats['albums']} album(s), {stats['tracks']} track(s), "
          f"{stats['lines']} lines aligned, {stats['failed']} failed")


def load_existing_timings(path):
    """Load existing lyrics-timings.js data by parsing with Node."""
    node_script = f"""
    const fs = require('fs');
    const src = fs.readFileSync({json.dumps(str(path))}, 'utf8');
    const window = {{}};
    eval(src);
    const result = {{}};
    for (const [key, val] of Object.entries(window.lyricsTimings || {{}})) {{
        result[key] = {{}};
        for (const [title, data] of Object.entries(val)) {{
            result[key][title] = data.lines || [];
        }}
    }}
    console.log(JSON.stringify(result));
    """
    result = subprocess.run(
        ["node", "-e", node_script],
        capture_output=True, text=True, timeout=30
    )
    if result.returncode != 0:
        print(f"Warning: could not parse existing timings: {result.stderr}", file=sys.stderr)
        return {}
    return json.loads(result.stdout)


def load_existing_reference(path):
    """Load existing sync-reference.js data by parsing with Node."""
    node_script = f"""
    const fs = require('fs');
    const src = fs.readFileSync({json.dumps(str(path))}, 'utf8');
    const window = {{}};
    eval(src);
    const result = {{}};
    for (const [key, val] of Object.entries(window.syncReference || {{}})) {{
        result[key] = {{}};
        for (const [title, data] of Object.entries(val)) {{
            result[key][title] = data.lines || [];
        }}
    }}
    console.log(JSON.stringify(result));
    """
    result = subprocess.run(
        ["node", "-e", node_script],
        capture_output=True, text=True, timeout=30
    )
    if result.returncode != 0:
        print(f"Warning: could not parse existing reference: {result.stderr}", file=sys.stderr)
        return {}
    return json.loads(result.stdout)


if __name__ == "__main__":
    main()
