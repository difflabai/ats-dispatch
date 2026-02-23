#!/usr/bin/env bash
#
# run-opera.sh — Generate all 48 tracks of "Words of Radiance: A Rock Opera"
#
# Usage:
#   ./run-opera.sh              # Generate all 6 acts sequentially
#   ./run-opera.sh act-3        # Generate only Act III
#   ./run-opera.sh act-4 act-6  # Generate specific acts
#
# Prerequisites:
#   - generate-album.sh in ~/bin/ (the canonical album pipeline)
#   - ACE-Step API running on localhost:8000
#   - Qwen3-TTS running on localhost:5050
#   - B2 credentials in ~/env.vars
#
# Each act is an 8-track album config. The opera is 6 acts = 48 tracks total.
# Estimated time: ~3 min/track x 48 tracks = ~2.5 hours
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GENERATE="$HOME/bin/generate-album.sh"

ALL_ACTS=(act-1 act-2 act-3 act-4 act-5 act-6)
ACT_NAMES=(
  "Act I: The Assassination"
  "Act II: The Shattered Plains"
  "Act III: Cracks"
  "Act IV: The Climbs"
  "Act V: Unmasked"
  "Act VI: Radiance"
)

# If arguments given, use them; otherwise run all acts
if [[ $# -gt 0 ]]; then
  ACTS=("$@")
else
  ACTS=("${ALL_ACTS[@]}")
fi

# Validate generate-album.sh exists
if [[ ! -x "$GENERATE" ]]; then
  echo "ERROR: generate-album.sh not found at $GENERATE"
  echo "Please ensure the canonical album pipeline is installed."
  exit 1
fi

echo "=============================================="
echo "  Words of Radiance: A Rock Opera"
echo "  48-Track Progressive Rock Opera"
echo "=============================================="
echo ""
echo "Acts to generate: ${ACTS[*]}"
echo ""

TOTAL_START=$(date +%s)
COMPLETED=0
FAILED=0

for ACT in "${ACTS[@]}"; do
  CONFIG="$SCRIPT_DIR/${ACT}.json"

  if [[ ! -f "$CONFIG" ]]; then
    echo "WARNING: Config not found: $CONFIG — skipping"
    FAILED=$((FAILED + 1))
    continue
  fi

  # Find the act index for display name
  ACT_DISPLAY="$ACT"
  for i in "${!ALL_ACTS[@]}"; do
    if [[ "${ALL_ACTS[$i]}" == "$ACT" ]]; then
      ACT_DISPLAY="${ACT_NAMES[$i]}"
      break
    fi
  done

  echo "=============================================="
  echo "  Generating: $ACT_DISPLAY"
  echo "  Config: $CONFIG"
  echo "=============================================="
  echo ""

  ACT_START=$(date +%s)

  if "$GENERATE" "$CONFIG"; then
    ACT_END=$(date +%s)
    ACT_ELAPSED=$(( ACT_END - ACT_START ))
    ACT_MIN=$(( ACT_ELAPSED / 60 ))
    echo ""
    echo "  $ACT_DISPLAY completed in ${ACT_MIN} minutes."
    echo ""
    COMPLETED=$((COMPLETED + 1))
  else
    echo ""
    echo "  ERROR: $ACT_DISPLAY generation failed!"
    echo ""
    FAILED=$((FAILED + 1))
  fi
done

TOTAL_END=$(date +%s)
TOTAL_ELAPSED=$(( TOTAL_END - TOTAL_START ))
TOTAL_MIN=$(( TOTAL_ELAPSED / 60 ))

echo "=============================================="
echo "  Opera Generation Complete"
echo "=============================================="
echo "  Acts completed: $COMPLETED"
echo "  Acts failed:    $FAILED"
echo "  Total time:     ${TOTAL_MIN} minutes"
echo "=============================================="
