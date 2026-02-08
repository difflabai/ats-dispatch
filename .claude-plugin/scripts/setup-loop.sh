#!/bin/bash

# CEO Agent Loop Setup Script
# Writes .claude/start/{slug}/state.local.md (state consumed by stop hook)
# Each loop has its own state file based on target hash, allowing multiple concurrent loops

set -euo pipefail

show_help() {
  cat << 'HELP_EOF'
Agent Loop

USAGE:
  /start --dir PATH --goal "..." [OPTIONS]
  /start --file PATH --file PATH --goal "..." [OPTIONS]

OPTIONS:
  --dir PATH                   Target directory (can specify multiple)
  --file PATH                  Target file (can specify multiple)
  --goal TEXT                  Goal prompt (required)
  --max-iterations N           Stop after N iterations (default: 5, 0 = unlimited)
  --eval-cmd CMD               Optional evaluator command (signals only)
  --feedback-cmd CMD           Run after each iteration, output feeds into next iteration
                               (e.g., screenshot tools, gameplay comparators, test runners)
  --feedback-image PATH        Image file to include in each iteration's context
                               (e.g., screenshot saved by feedback-cmd or external tool)
  --feedback-agent             Enable subagent feedback each iteration (default: enabled)
                               Subagent is picked from available Task tool agents
  --no-feedback-agent          Disable subagent spawning
  -h, --help                   Show help

FEEDBACK EXAMPLES:
  # Screenshot with image feedback (image is sent to LLM)
  /start --dir game/ui --goal "Improve UI aesthetics" \
    --feedback-cmd "screenshot-tool --output /tmp/ui.png" \
    --feedback-image /tmp/ui.png

  # Test runner feedback (text only)
  /start --dir src --goal "Fix failing tests" \
    --feedback-cmd "npm test 2>&1 | tail -50"

EXAMPLES:
  /start --dir src \
    --goal "Improve code quality and add tests." \
    --max-iterations 5

  /start --dir src --dir lib \
    --goal "Refactor shared code between src and lib." \
    --max-iterations 3

  /start --file src/main.ts --file src/utils.ts \
    --goal "Optimize these specific files." \
    --max-iterations 3
HELP_EOF
}
TARGET_DIRS=()
TARGET_FILES=()
GOAL=""
MAX_ITERATIONS="5"
EVAL_CMD="null"
FEEDBACK_CMD="null"
FEEDBACK_IMAGE="null"
FEEDBACK_AGENT="auto"  # Default to spawning subagents with unique perspectives

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      show_help
      exit 0
      ;;
    --dir)
      TARGET_DIRS+=("${2:-}")
      shift 2
      ;;
    --file)
      TARGET_FILES+=("${2:-}")
      shift 2
      ;;
    --goal)
      GOAL="${2:-}"
      shift 2
      ;;
    --max-iterations)
      MAX_ITERATIONS="${2:-}"
      shift 2
      ;;
    --eval-cmd)
      EVAL_CMD="${2:-}"
      shift 2
      ;;
    --feedback-cmd)
      FEEDBACK_CMD="${2:-}"
      shift 2
      ;;
    --feedback-image)
      FEEDBACK_IMAGE="${2:-}"
      shift 2
      ;;
    --feedback-agent)
      FEEDBACK_AGENT="auto"
      shift 1
      ;;
    --no-feedback-agent)
      FEEDBACK_AGENT="null"
      shift 1
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "   Try: /start --help" >&2
      exit 1
      ;;
  esac
done

if [[ ${#TARGET_DIRS[@]} -eq 0 ]] && [[ ${#TARGET_FILES[@]} -eq 0 ]]; then
  echo "Error: At least one --dir or --file is required" >&2
  exit 1
fi

if [[ -z "$GOAL" ]]; then
  echo "Error: --goal TEXT is required" >&2
  exit 1
fi

if ! [[ "$MAX_ITERATIONS" =~ ^[0-9]+$ ]]; then
  echo "Error: --max-iterations must be an integer (0 = unlimited), got: $MAX_ITERATIONS" >&2
  exit 1
fi

# Validate directories exist
if [[ ${#TARGET_DIRS[@]} -gt 0 ]]; then
  for dir in "${TARGET_DIRS[@]}"; do
    if [[ ! -d "$dir" ]]; then
      echo "Error: Directory does not exist: $dir" >&2
      exit 1
    fi
  done
fi

# Validate files exist
if [[ ${#TARGET_FILES[@]} -gt 0 ]]; then
  for file in "${TARGET_FILES[@]}"; do
    if [[ ! -f "$file" ]]; then
      echo "Error: File does not exist: $file" >&2
      exit 1
    fi
  done
fi

mkdir -p .claude

# Compute loop slug FIRST (same algorithm as stop-hook.sh)
# This allows each loop to have its own state file
ALL_TARGETS_FOR_SLUG=""
if [[ ${#TARGET_DIRS[@]} -gt 0 ]]; then
  for dir in "${TARGET_DIRS[@]}"; do
    ALL_TARGETS_FOR_SLUG+="$dir"$'\n'
  done
fi
if [[ ${#TARGET_FILES[@]} -gt 0 ]]; then
  for file in "${TARGET_FILES[@]}"; do
    ALL_TARGETS_FOR_SLUG+="$file"$'\n'
  done
fi
LOOP_SLUG="$(echo "$ALL_TARGETS_FOR_SLUG" | md5sum | cut -c1-12)"
LOOP_DIR=".claude/start/$LOOP_SLUG"
mkdir -p "$LOOP_DIR"

yaml_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  echo "$s"
}

GOAL_ESC="$(yaml_escape "$GOAL")"

if [[ -n "${EVAL_CMD:-}" ]] && [[ "$EVAL_CMD" != "null" ]]; then
  EVAL_CMD_ESC="$(yaml_escape "$EVAL_CMD")"
  EVAL_CMD_YAML="\"$EVAL_CMD_ESC\""
else
  EVAL_CMD_YAML="null"
fi

if [[ -n "${FEEDBACK_CMD:-}" ]] && [[ "$FEEDBACK_CMD" != "null" ]]; then
  FEEDBACK_CMD_ESC="$(yaml_escape "$FEEDBACK_CMD")"
  FEEDBACK_CMD_YAML="\"$FEEDBACK_CMD_ESC\""
else
  FEEDBACK_CMD_YAML="null"
fi

if [[ -n "${FEEDBACK_IMAGE:-}" ]] && [[ "$FEEDBACK_IMAGE" != "null" ]]; then
  # Convert to absolute path
  FEEDBACK_IMAGE_ABS="$(cd "$(dirname "$FEEDBACK_IMAGE")" 2>/dev/null && pwd)/$(basename "$FEEDBACK_IMAGE")" || FEEDBACK_IMAGE_ABS="$FEEDBACK_IMAGE"
  FEEDBACK_IMAGE_ESC="$(yaml_escape "$FEEDBACK_IMAGE_ABS")"
  FEEDBACK_IMAGE_YAML="\"$FEEDBACK_IMAGE_ESC\""
else
  FEEDBACK_IMAGE_YAML="null"
fi

if [[ -n "${FEEDBACK_AGENT:-}" ]] && [[ "$FEEDBACK_AGENT" != "null" ]]; then
  FEEDBACK_AGENT_ESC="$(yaml_escape "$FEEDBACK_AGENT")"
  FEEDBACK_AGENT_YAML="\"$FEEDBACK_AGENT_ESC\""
else
  FEEDBACK_AGENT_YAML="null"
fi

# Session management: The PreToolUse hook captures session_id before this script runs.
# We include the session_id in the pending token so ONLY the creating session can claim it.
# This prevents race conditions when multiple sessions start loops simultaneously.

# Read session_id captured by PreToolUse hook (if available)
PENDING_SESSION_FILE=".claude/start/.pending-session-id"
CAPTURED_SESSION_ID=""
if [[ -f "$PENDING_SESSION_FILE" ]]; then
  CAPTURED_SESSION_ID="$(cat "$PENDING_SESSION_FILE" 2>/dev/null || true)"
  # Clean up the temp file immediately to avoid stale data
  rm -f "$PENDING_SESSION_FILE"
fi

# Generate a claim token for this loop
# Format: pending-{session_id} if we have session_id, otherwise pending-{timestamp}-{random}
# The stop hook will ONLY claim if its session_id matches the one in the pending token
if [[ -n "$CAPTURED_SESSION_ID" ]]; then
  # Session-safe: only the creating session can claim this loop
  CLAIM_TOKEN="pending-$CAPTURED_SESSION_ID"
else
  # Fallback for edge cases (shouldn't happen in normal operation)
  # Uses timestamp+random, but stop hook will use strict 10s window for these
  CLAIM_TOKEN="pending-fallback-$(date +%s)-$(openssl rand -hex 4 2>/dev/null || echo $$)"
fi

# Create state file
{
  echo "---"
  echo "active: true"
  echo "iteration: 1"
  echo "max_iterations: $MAX_ITERATIONS"
  echo "claim_token: \"$CLAIM_TOKEN\""
  echo -n "target_dirs:"
  if [[ ${#TARGET_DIRS[@]} -eq 0 ]]; then
    echo " []"
  else
    echo ""
    for dir in "${TARGET_DIRS[@]}"; do
      echo "  - \"$(yaml_escape "$dir")\""
    done
  fi
  echo -n "target_files:"
  if [[ ${#TARGET_FILES[@]} -eq 0 ]]; then
    echo " []"
  else
    echo ""
    for file in "${TARGET_FILES[@]}"; do
      echo "  - \"$(yaml_escape "$file")\""
    done
  fi
  echo "goal: \"$GOAL_ESC\""
  echo "eval_cmd: $EVAL_CMD_YAML"
  echo "feedback_cmd: $FEEDBACK_CMD_YAML"
  echo "feedback_image: $FEEDBACK_IMAGE_YAML"
  echo "feedback_agent: $FEEDBACK_AGENT_YAML"
  echo "started_at: \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
  echo "---"
  echo " "
  echo "Loop is active."
  echo " "
  echo "Please reply with a short progress note (or just \`ok\`) and then stop."
  echo "To cancel: /ceo:stop"
} > "$LOOP_DIR/state.local.md"

# Write lock file with claim token - stop hook will upgrade to real session_id
echo "$CLAIM_TOKEN" > "$LOOP_DIR/.lock-owner"
echo "$(date +%s)" > "$LOOP_DIR/.last-activity"

cat <<EOF

======================================================================
                       LOOP ACTIVATED
======================================================================

EOF

# Show targets
if [[ ${#TARGET_DIRS[@]} -gt 0 ]]; then
  if [[ ${#TARGET_DIRS[@]} -eq 1 ]]; then
    echo "Directory:   ${TARGET_DIRS[0]}/"
  else
    echo "Directories:"
    for dir in "${TARGET_DIRS[@]}"; do
      echo "                - $dir/"
    done
  fi
fi

if [[ ${#TARGET_FILES[@]} -gt 0 ]]; then
  if [[ ${#TARGET_FILES[@]} -eq 1 ]]; then
    echo "File:        ${TARGET_FILES[0]}"
  else
    echo "Files:"
    for file in "${TARGET_FILES[@]}"; do
      echo "                - $file"
    done
  fi
fi

echo "Goal:        $GOAL"
echo "Iterations:  $(if [[ "$MAX_ITERATIONS" -gt 0 ]]; then echo "1 of $MAX_ITERATIONS"; else echo "unlimited"; fi)"

if [[ "$EVAL_CMD_YAML" != "null" ]]; then
  echo "Eval cmd:    $EVAL_CMD"
fi
if [[ "$FEEDBACK_CMD_YAML" != "null" ]]; then
  echo "Feedback:    $FEEDBACK_CMD"
fi
if [[ "$FEEDBACK_IMAGE_YAML" != "null" ]]; then
  echo "Image:       $FEEDBACK_IMAGE"
fi
if [[ "$FEEDBACK_AGENT_YAML" != "null" ]]; then
  echo "Subagents:   ENABLED ($FEEDBACK_AGENT) - unique perspective each iteration"
else
  echo "Subagents:   disabled (--no-feedback-agent)"
fi

# Use the already-computed slug
echo "Logs:        $LOOP_DIR/"

cat <<EOF

+------------------------------------------------------------------+
|  The loop will now run automatically via the Stop hook.         |
|  Each iteration: analyze -> improve -> verify -> repeat         |
|                                                                  |
|  To cancel anytime:  /ceo:stop                                   |
|  To check progress:  /ceo:status                                 |
+------------------------------------------------------------------+
EOF
