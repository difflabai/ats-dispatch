#!/bin/bash
set -euo pipefail

# =============================================================================
# run-intensity-arc.sh -- Stormlight Archive: Emotional Intensity Arc
#
# Generates all 6 character albums plus 5 instrumental interludes in order
# from lightest to darkest emotional intensity.
#
# Order:
#   1. Adolin  -- 'Golden Son'              (lightest, most accessible)
#   |  Interlude: 'The Shattered Plains'
#   2. Shallan -- 'Three of Me'             (unsettling but beautiful)
#   |  Interlude: 'Urithiru Ascending'
#   3. Jasnah  -- 'Heretic\'s Theorem'       (intellectual intensity)
#   |  Interlude: 'Stormwall'
#   4. Kaladin -- 'Before the Storm'        (emotional gut-punch)
#   |  Interlude: 'The Thrill'
#   5. Dalinar -- 'The Blackthorn\'s Requiem' (epic devastation)
#   |  Interlude: 'Shin Silence'
#   6. Szeth   -- 'Truthless'               (darkest, most harrowing)
#
# Usage:
#   ./run-intensity-arc.sh [--interludes-only] [--skip-interludes] [--album NAME]
#
# Requires: ~/bin/generate-album.sh
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GENERATE_ALBUM="${HOME}/bin/generate-album.sh"

if [ ! -f "$GENERATE_ALBUM" ]; then
  echo "ERROR: generate-album.sh not found at $GENERATE_ALBUM"
  exit 1
fi

# Parse arguments
INTERLUDES_ONLY=false
SKIP_INTERLUDES=false
SINGLE_ALBUM=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interludes-only)
      INTERLUDES_ONLY=true
      shift
      ;;
    --skip-interludes)
      SKIP_INTERLUDES=true
      shift
      ;;
    --album)
      SINGLE_ALBUM="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--interludes-only] [--skip-interludes] [--album NAME]"
      echo "  --interludes-only  Only generate the 5 interlude tracks"
      echo "  --skip-interludes  Skip interludes, only generate albums"
      echo "  --album NAME       Generate only the named album (adolin|shallan|jasnah|kaladin|dalinar|szeth)"
      exit 1
      ;;
  esac
done

ALBUMS=(
  "adolin"
  "shallan"
  "jasnah"
  "kaladin"
  "dalinar"
  "szeth"
)

INTERLUDES_CONFIG="${SCRIPT_DIR}/interludes.json"

generate_album() {
  local name="$1"
  local config="${SCRIPT_DIR}/${name}.json"

  if [ ! -f "$config" ]; then
    echo "ERROR: Config not found: $config"
    return 1
  fi

  echo ""
  echo "============================================================"
  echo "  GENERATING: $(python3 -c "import json; print(json.load(open('$config'))['album_title'])")"
  echo "  Config: $config"
  echo "  Time: $(date)"
  echo "============================================================"
  echo ""

  bash "$GENERATE_ALBUM" "$config"
}

generate_interludes() {
  if [ ! -f "$INTERLUDES_CONFIG" ]; then
    echo "ERROR: Interludes config not found: $INTERLUDES_CONFIG"
    return 1
  fi

  echo ""
  echo "============================================================"
  echo "  GENERATING: Instrumental Interludes"
  echo "  Config: $INTERLUDES_CONFIG"
  echo "  Time: $(date)"
  echo "============================================================"
  echo ""

  bash "$GENERATE_ALBUM" "$INTERLUDES_CONFIG"
}

generate_single_interlude() {
  local track_index="$1"

  if [ ! -f "$INTERLUDES_CONFIG" ]; then
    echo "ERROR: Interludes config not found: $INTERLUDES_CONFIG"
    return 1
  fi

  local interlude_title
  interlude_title=$(python3 -c "import json; print(json.load(open('$INTERLUDES_CONFIG'))['tracks'][$track_index]['title'])")

  local tmp_config
  tmp_config=$(mktemp /tmp/interlude-XXXXXX.json)
  python3 -c "
import json, sys
cfg = json.load(open('$INTERLUDES_CONFIG'))
cfg['tracks'] = [cfg['tracks'][$track_index]]
json.dump(cfg, open('$tmp_config', 'w'), indent=2)
"

  echo ""
  echo "============================================================"
  echo "  GENERATING INTERLUDE: $interlude_title"
  echo "  Config: $INTERLUDES_CONFIG (track $track_index)"
  echo "  Time: $(date)"
  echo "============================================================"
  echo ""

  bash "$GENERATE_ALBUM" "$tmp_config"
  rm -f "$tmp_config"
}

START_TIME=$(date +%s)

echo "============================================================"
echo "  STORMLIGHT ARCHIVE: EMOTIONAL INTENSITY ARC"
echo "  6 Albums + 5 Interludes = 53 Tracks"
echo "  Started: $(date)"
echo "============================================================"

if [ -n "$SINGLE_ALBUM" ]; then
  generate_album "$SINGLE_ALBUM"
elif [ "$INTERLUDES_ONLY" = true ]; then
  generate_interludes
else
  for i in "${!ALBUMS[@]}"; do
    generate_album "${ALBUMS[$i]}"

    # Generate the interlude that bridges this album to the next one
    # (no interlude after the last album, szeth)
    if [ "$SKIP_INTERLUDES" = false ] && [ "$i" -lt $((${#ALBUMS[@]} - 1)) ]; then
      generate_single_interlude "$i"
    fi
  done
fi

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))
HOURS=$((ELAPSED / 3600))
MINUTES=$(( (ELAPSED % 3600) / 60 ))

echo ""
echo "============================================================"
echo "  COMPLETE: Stormlight Archive Intensity Arc"
echo "  Total time: ${HOURS}h ${MINUTES}m"
echo "  Finished: $(date)"
echo "============================================================"
