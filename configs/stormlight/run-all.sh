#!/usr/bin/env bash
#
# run-all.sh — Generate all 6 Stormlight Archive concept albums serially.
#
# Usage:
#   ./run-all.sh                     # Run all 6 albums in order
#   ./run-all.sh kaladin dalinar     # Run only the named albums
#
# Prerequisites:
#   - generate-album.sh in PATH or ~/bin/
#   - ACE-Step API running on localhost:8000
#   - Qwen3-TTS running on localhost:5050
#   - B2 credentials sourced (source ~/env.vars)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GENERATE="${GENERATE_ALBUM:-$HOME/bin/generate-album.sh}"

ALL_ALBUMS=(kaladin dalinar shallan szeth jasnah adolin)

# Use arguments if provided, otherwise run all
if [[ $# -gt 0 ]]; then
  ALBUMS=("$@")
else
  ALBUMS=("${ALL_ALBUMS[@]}")
fi

echo "=== Stormlight Archive Albums — Variant 1 (Faithful Serial) ==="
echo "Albums to generate: ${ALBUMS[*]}"
echo ""

for album in "${ALBUMS[@]}"; do
  config="$SCRIPT_DIR/${album}.json"
  if [[ ! -f "$config" ]]; then
    echo "ERROR: Config not found: $config"
    exit 1
  fi
  echo "──────────────────────────────────────────"
  echo "▶ Starting album: $album"
  echo "  Config: $config"
  echo "  Time: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "──────────────────────────────────────────"
  "$GENERATE" "$config"
  echo ""
  echo "✓ Completed: $album ($(date '+%H:%M:%S'))"
  echo ""
done

echo "=== All ${#ALBUMS[@]} albums complete ==="
