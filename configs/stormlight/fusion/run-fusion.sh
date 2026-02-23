#!/usr/bin/env bash
set -euo pipefail

# Stormlight Archive - Genre Fusion Variant
# Generates all 6 character albums using the canonical album pipeline.
#
# Usage:
#   ./run-fusion.sh                  # Run all characters
#   ./run-fusion.sh kaladin dalinar  # Run specific characters
#
# Prerequisites:
#   - ACE-Step API running on localhost:8000
#   - Qwen3-TTS running on localhost:5050
#   - ~/env.vars configured for B2 uploads
#   - ~/bin/generate-album.sh available

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIPELINE="${HOME}/bin/generate-album.sh"

CHARACTERS=(kaladin dalinar shallan szeth jasnah adolin)

# Allow running specific characters via args
if [[ $# -gt 0 ]]; then
  CHARACTERS=("$@")
fi

echo "=== Stormlight Archive: Genre Fusion ==="
echo "Characters: ${CHARACTERS[*]}"
echo "Config dir: ${SCRIPT_DIR}"
echo ""

for char in "${CHARACTERS[@]}"; do
  config="${SCRIPT_DIR}/${char}.json"
  if [[ ! -f "$config" ]]; then
    echo "ERROR: Config not found: ${config}"
    continue
  fi
  echo "--- Generating: ${char} ---"
  echo "Config: ${config}"
  bash "$PIPELINE" "$config"
  echo "--- Done: ${char} ---"
  echo ""
done

echo "=== All fusion albums complete ==="
