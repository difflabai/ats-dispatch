#!/bin/bash

# CEO Agent Loop Stop Hook
#
# Implements an in-session agent loop that:
#   - runs optional eval command (signals/metrics)
#   - runs optional verification command (for feedback, does not gate)
#   - makes improvements via Claude Code
#
# The loop is activated by /start which creates:
#   .claude/start/{slug}/state.local.md
#
# Multiple loops can run concurrently (each with different targets)

set -euo pipefail

# Consume hook input (Stop hook API provides JSON on stdin)
_HOOK_INPUT="$(cat || true)"

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# Parse session_id from hook input - this is the authoritative session identifier
HOOK_SESSION_ID=""
if command -v jq >/dev/null 2>&1 && [[ -n "$_HOOK_INPUT" ]]; then
  HOOK_SESSION_ID="$(echo "$_HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)"
fi

# Find all active loop state files
# Each loop has its own state file: .claude/start/{slug}/state.local.md
LOOP_STATE_DIR="$ROOT_DIR/.claude/start"
STATE_FILES=()
if [[ -d "$LOOP_STATE_DIR" ]]; then
  while IFS= read -r -d '' state_file; do
    STATE_FILES+=("$state_file")
  done < <(find "$LOOP_STATE_DIR" -name "state.local.md" -print0 2>/dev/null)
fi

if [[ ${#STATE_FILES[@]} -eq 0 ]]; then
  # No active loops - allow normal stop
  exit 0
fi

# Multi-instance safety: Find a loop we can claim
# Each loop has a .lock-owner file with the session ID that owns it
# We also track .last-activity to detect stale locks

# Debug logging
DEBUG_LOG="$ROOT_DIR/.claude/ceo-debug.log"
mkdir -p "$(dirname "$DEBUG_LOG")"
{
  echo "=== Stop hook invoked: $(date) ==="
  echo "ROOT_DIR: $ROOT_DIR"
  echo "HOOK_SESSION_ID: $HOOK_SESSION_ID"
  echo "STATE_FILES found: ${#STATE_FILES[@]}"
  for sf in "${STATE_FILES[@]}"; do
    echo "  - $sf"
    echo "    .lock-owner: $(cat "$(dirname "$sf")/.lock-owner" 2>/dev/null || echo 'NONE')"
  done
} >> "$DEBUG_LOG"

# Use hook-provided session_id (always available in Claude Code hooks)
if [[ -n "$HOOK_SESSION_ID" ]]; then
  OUR_SESSION_ID="$HOOK_SESSION_ID"
else
  # Fallback for edge cases (shouldn't happen in normal operation)
  OUR_SESSION_ID="unknown-session-$(date +%s)-$$"
fi

echo "OUR_SESSION_ID: $OUR_SESSION_ID" >> "$DEBUG_LOG"

# SESSION ISOLATION: Only the session that started a loop can run it.
# No stale lock takeover, no orphan claiming - strict ownership.
# Orphaned loops must be cleaned up explicitly with /stop --cleanup

find_owned_loop() {
  local now
  now=$(date +%s)

  echo "=== find_owned_loop called ===" >> "$DEBUG_LOG"
  echo "    Looking for loops owned by: $OUR_SESSION_ID" >> "$DEBUG_LOG"

  for state_file in "${STATE_FILES[@]}"; do
    local loop_dir
    loop_dir="$(dirname "$state_file")"
    local lock_owner_file="$loop_dir/.lock-owner"
    local last_activity_file="$loop_dir/.last-activity"

    echo "Checking loop: $loop_dir" >> "$DEBUG_LOG"
    echo "  lock_owner_file exists: $(test -f "$lock_owner_file" && echo yes || echo no)" >> "$DEBUG_LOG"

    # Check if there's an existing lock owner
    if [[ -f "$lock_owner_file" ]]; then
      local lock_owner
      lock_owner="$(cat "$lock_owner_file" 2>/dev/null || echo "")"

      echo "  lock_owner content: '$lock_owner'" >> "$DEBUG_LOG"
      echo "  OUR_SESSION_ID: '$OUR_SESSION_ID'" >> "$DEBUG_LOG"
      echo "  match: $(test "$lock_owner" == "$OUR_SESSION_ID" && echo yes || echo no)" >> "$DEBUG_LOG"

      # Check for pending claim token (newly started loop)
      # Two formats:
      #   1. Session-safe: pending-{session_id} - ONLY claimable by matching session (no time limit)
      #   2. Fallback: pending-fallback-{timestamp}-{random} - claimable with strict 10s window
      if [[ "$lock_owner" == pending-* ]]; then
        echo "  pending token detected: '$lock_owner'" >> "$DEBUG_LOG"

        # Check if this is a session-safe token (pending-{session_id})
        # These tokens contain the creating session's ID for race-free claiming
        if [[ "$lock_owner" == "pending-$OUR_SESSION_ID" ]]; then
          # This loop was created by THIS session - safe to claim regardless of age
          echo "  -> CLAIMING (session-safe token matches our session_id)" >> "$DEBUG_LOG"
          echo "$OUR_SESSION_ID" > "$lock_owner_file"
          echo "$now" > "$last_activity_file"
          echo "$state_file"
          return 0
        fi

        # Check if this is a session-safe token for ANOTHER session
        # Format: pending-{uuid} where uuid looks like session IDs (contains hyphens, long string)
        if [[ "$lock_owner" =~ ^pending-[a-f0-9-]{20,}$ ]] && [[ "$lock_owner" != pending-fallback-* ]]; then
          # This is a session-safe token for a different session - NEVER claim it
          echo "  -> SKIP (session-safe token belongs to different session)" >> "$DEBUG_LOG"
          echo "Info: Loop $(basename "$loop_dir") belongs to another session (session-safe)" >&2
          continue
        fi

        # Check if this is a fallback token (pending-fallback-{timestamp}-{random})
        # These are only used when PreToolUse hook couldn't capture session_id
        # Use strict 10-second window to minimize race conditions
        if [[ "$lock_owner" == pending-fallback-* ]]; then
          if [[ -f "$last_activity_file" ]]; then
            local pending_age=$((now - $(cat "$last_activity_file" 2>/dev/null || echo 0)))
            # Strict 10-second window for fallback tokens
            if [[ $pending_age -lt 10 ]]; then
              echo "  -> CLAIMING (fallback token ${pending_age}s old, within 10s window)" >> "$DEBUG_LOG"
              echo "$OUR_SESSION_ID" > "$lock_owner_file"
              echo "$now" > "$last_activity_file"
              echo "$state_file"
              return 0
            else
              echo "  -> SKIP (fallback token ${pending_age}s old - too old, may belong to another session)" >> "$DEBUG_LOG"
              echo "Warning: Loop $(basename "$loop_dir") has unclaimed fallback token (${pending_age}s old)" >&2
              echo "   This may be an orphaned loop. Clean up with: /ceo:stop" >&2
              continue
            fi
          else
            echo "  -> SKIP (fallback token but no activity file)" >> "$DEBUG_LOG"
            continue
          fi
        fi

        # Unknown pending token format - don't claim
        echo "  -> SKIP (unknown pending token format)" >> "$DEBUG_LOG"
        continue
      fi

      # STRICT OWNERSHIP: Only run if we own this loop
      if [[ "$lock_owner" == "$OUR_SESSION_ID" ]]; then
        echo "  -> FOUND (we own this loop)" >> "$DEBUG_LOG"
        # Update activity timestamp
        echo "$now" > "$last_activity_file"
        echo "$state_file"
        return 0
      fi

      # We don't own this loop - report it but DON'T claim it
      local age="unknown"
      if [[ -f "$last_activity_file" ]]; then
        local last_activity
        last_activity="$(cat "$last_activity_file" 2>/dev/null || echo 0)"
        age=$((now - last_activity))
      fi
      echo "  -> SKIP (owned by different session, last active ${age}s ago)" >> "$DEBUG_LOG"
      # Only warn once per loop (check if we've already warned)
      local warn_file="$loop_dir/.warned-$OUR_SESSION_ID"
      if [[ ! -f "$warn_file" ]]; then
        echo "Info: Loop $(basename "$loop_dir") is owned by another Claude session" >&2
        echo "   Owner: ${lock_owner:0:30}..." >&2
        echo "   Last active: ${age}s ago" >&2
        echo "   This loop will NOT run in your session." >&2
        touch "$warn_file"
      fi
      continue
    else
      # No lock owner file - orphan loop, DON'T claim it
      echo "  -> SKIP (no lock file - orphan loop, not claiming)" >> "$DEBUG_LOG"
      echo "Warning: Found orphaned loop: $(basename "$loop_dir")" >&2
      echo "   Clean up with: /stop --cleanup" >&2
      continue
    fi
  done

  # No owned loops found
  echo "=== No owned loops found ===" >> "$DEBUG_LOG"
  return 1
}

# Find a loop owned by THIS session
STATE_FILE=""
if ! STATE_FILE="$(find_owned_loop)"; then
  # No loops owned by this session - allow normal stop
  # (Any warnings about other sessions' loops were already printed by find_owned_loop)
  exit 0
fi

if [[ -z "$STATE_FILE" ]]; then
  # No state file found (shouldn't happen, but be safe)
  exit 0
fi

# Get the loop directory for this state file
LOOP_DIR_FOR_LOCK="$(dirname "$STATE_FILE")"

# Update last activity timestamp to keep our lock fresh
echo "$(date +%s)" > "$LOOP_DIR_FOR_LOCK/.last-activity"

# If multiple loops are active, warn the user
if [[ ${#STATE_FILES[@]} -gt 1 ]]; then
  echo "Warning: Multiple loops active (${#STATE_FILES[@]} loops). Processing owned loop: $(basename "$LOOP_DIR_FOR_LOCK")" >&2
  echo "   All active loops:" >&2
  for sf in "${STATE_FILES[@]}"; do
    local_loop_dir="$(dirname "$sf")"
    local_owner="$(cat "$local_loop_dir/.lock-owner" 2>/dev/null || echo "unknown")"
    if [[ "$local_owner" == "$OUR_SESSION_ID" ]]; then
      echo "   - $(basename "$local_loop_dir") (owned by this instance)" >&2
    else
      echo "   - $(basename "$local_loop_dir") (owned by: ${local_owner:0:20}...)" >&2
    fi
  done
fi

# Parse YAML frontmatter (YAML between --- markers)
FRONTMATTER="$(sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "$STATE_FILE")"

yaml_get_raw() {
  local key="$1"
  echo "$FRONTMATTER" | sed -n "s/^${key}:[[:space:]]*//p" | head -n 1
}

strip_yaml_quotes() {
  local v="$1"
  echo "$v" | sed 's/^"\(.*\)"$/\1/'
}

yaml_unescape() {
  local v="$1"
  v="${v//\\\\/\\}"
  v="${v//\\\"/\"}"
  echo "$v"
}

# Parse YAML array (returns newline-separated values)
yaml_get_array() {
  local key="$1"
  local in_array=false
  local found_key=false
  echo "$FRONTMATTER" | while IFS= read -r line; do
    if [[ "$line" =~ ^${key}:[[:space:]]*$ ]]; then
      found_key=true
      in_array=true
      continue
    elif [[ "$line" =~ ^${key}:[[:space:]]*\[\] ]]; then
      # Empty array
      break
    elif [[ "$found_key" == "true" && "$in_array" == "true" ]]; then
      if [[ "$line" =~ ^[[:space:]]+-[[:space:]]+(.*) ]]; then
        local val="${BASH_REMATCH[1]}"
        # Strip quotes
        val="$(echo "$val" | sed 's/^"\(.*\)"$/\1/')"
        # Unescape
        val="${val//\\\\/\\}"
        val="${val//\\\"/\"}"
        echo "$val"
      elif [[ "$line" =~ ^[a-zA-Z_] ]]; then
        # New key, end of array
        break
      fi
    fi
  done
}

ITERATION="$(strip_yaml_quotes "$(yaml_get_raw iteration)")"
MAX_ITERATIONS="$(strip_yaml_quotes "$(yaml_get_raw max_iterations)")"
GOAL="$(yaml_unescape "$(strip_yaml_quotes "$(yaml_get_raw goal)")")"
EVAL_CMD_RAW="$(yaml_get_raw eval_cmd)"
FEEDBACK_CMD_RAW="$(yaml_get_raw feedback_cmd)"
FEEDBACK_IMAGE_RAW="$(yaml_get_raw feedback_image)"
FEEDBACK_AGENT_RAW="$(yaml_get_raw feedback_agent)"

# Parse arrays for multiple targets
TARGET_DIRS_STR="$(yaml_get_array target_dirs)"
TARGET_FILES_STR="$(yaml_get_array target_files)"

# Also support legacy single target_dir
LEGACY_TARGET_DIR="$(yaml_unescape "$(strip_yaml_quotes "$(yaml_get_raw target_dir)")")"
if [[ -n "$LEGACY_TARGET_DIR" ]] && [[ -z "$TARGET_DIRS_STR" ]]; then
  TARGET_DIRS_STR="$LEGACY_TARGET_DIR"
fi

EVAL_CMD="$(yaml_unescape "$(strip_yaml_quotes "$EVAL_CMD_RAW")")"
FEEDBACK_CMD="$(yaml_unescape "$(strip_yaml_quotes "$FEEDBACK_CMD_RAW")")"
FEEDBACK_IMAGE="$(yaml_unescape "$(strip_yaml_quotes "$FEEDBACK_IMAGE_RAW")")"
FEEDBACK_AGENT="$(yaml_unescape "$(strip_yaml_quotes "$FEEDBACK_AGENT_RAW")")"

# Normalize null-like values
if [[ "${EVAL_CMD_RAW:-}" == "null" ]] || [[ -z "${EVAL_CMD:-}" ]]; then EVAL_CMD=""; fi
if [[ "${FEEDBACK_CMD_RAW:-}" == "null" ]] || [[ -z "${FEEDBACK_CMD:-}" ]]; then FEEDBACK_CMD=""; fi
if [[ "${FEEDBACK_IMAGE_RAW:-}" == "null" ]] || [[ -z "${FEEDBACK_IMAGE:-}" ]]; then FEEDBACK_IMAGE=""; fi
if [[ "${FEEDBACK_AGENT_RAW:-}" == "null" ]] || [[ -z "${FEEDBACK_AGENT:-}" ]]; then FEEDBACK_AGENT=""; fi

# Validate numeric fields
if [[ ! "$ITERATION" =~ ^[0-9]+$ ]]; then
  echo "Warning: Loop error: State file corrupted (iteration is not a number)." >&2
  rm -f "$STATE_FILE"
  exit 0
fi

if [[ ! "$MAX_ITERATIONS" =~ ^[0-9]+$ ]]; then
  echo "Warning: Loop error: State file corrupted (max_iterations is not a number)." >&2
  rm -f "$STATE_FILE"
  exit 0
fi

if [[ -z "${TARGET_DIRS_STR:-}" ]] && [[ -z "${TARGET_FILES_STR:-}" ]]; then
  echo "Warning: Loop error: State file corrupted (no target_dirs or target_files)." >&2
  rm -f "$STATE_FILE"
  exit 0
fi

# Validate all target directories exist
while IFS= read -r dir; do
  [[ -z "$dir" ]] && continue
  # Handle both absolute and relative paths
  if [[ "$dir" = /* ]]; then
    TARGET_ABS="$dir"
  else
    TARGET_ABS="$ROOT_DIR/$dir"
  fi
  if [[ ! -d "$TARGET_ABS" ]]; then
    echo "Warning: Loop error: target directory does not exist: $TARGET_ABS" >&2
    rm -f "$STATE_FILE"
    exit 0
  fi
done <<< "$TARGET_DIRS_STR"

# Validate all target files exist
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  # Handle both absolute and relative paths
  if [[ "$file" = /* ]]; then
    TARGET_ABS="$file"
  else
    TARGET_ABS="$ROOT_DIR/$file"
  fi
  if [[ ! -f "$TARGET_ABS" ]]; then
    echo "Warning: Loop error: target file does not exist: $TARGET_ABS" >&2
    rm -f "$STATE_FILE"
    exit 0
  fi
done <<< "$TARGET_FILES_STR"

# Build a display string for targets
TARGETS_DISPLAY=""
while IFS= read -r dir; do
  [[ -z "$dir" ]] && continue
  TARGETS_DISPLAY+="$dir/ "
done <<< "$TARGET_DIRS_STR"
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  TARGETS_DISPLAY+="$file "
done <<< "$TARGET_FILES_STR"
TARGETS_DISPLAY="${TARGETS_DISPLAY% }"  # Trim trailing space

# Loop directory is the parent of the state file
# (state file is at .claude/start/{slug}/state.local.md)
LOOP_DIR="$(dirname "$STATE_FILE")"
TARGET_SLUG="$(basename "$LOOP_DIR")"

# =============================================================================
# PART 3: Iteration Logic - Max check, eval/feedback, prompt building
# =============================================================================

# Check if max iterations exceeded -> show summary and clean up
if [[ $MAX_ITERATIONS -gt 0 ]] && [[ $ITERATION -gt $MAX_ITERATIONS ]]; then
  echo "Loop complete: $MAX_ITERATIONS iterations finished." >&2

  # Get git diff summary for the prompt
  FINAL_DIFFSTAT=""
  FINAL_LOG=""
  if git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    FINAL_DIFFSTAT="$(git -C "$ROOT_DIR" diff --stat 2>/dev/null | tail -20 || true)"
    FINAL_LOG="$(git -C "$ROOT_DIR" log --oneline -10 2>/dev/null || true)"
  fi

  # Clean up state file
  rm -f "$STATE_FILE"
  rm -f "$LOOP_DIR/.lock-owner"
  rm -f "$LOOP_DIR/.last-activity"

  # Return summary prompt
  SUMMARY_PROMPT="
==================================================================
  LOOP COMPLETE - $MAX_ITERATIONS iterations
==================================================================

**Goal:** $GOAL
**Targets:** $TARGETS_DISPLAY

### Summary of changes
\`\`\`
$FINAL_DIFFSTAT
\`\`\`

### Recent commits
\`\`\`
$FINAL_LOG
\`\`\`

---

**Provide a brief summary of what was accomplished across all iterations.**
- What improved?
- What's the current state?
- Any suggested next steps?"

  jq -n     --arg prompt "$SUMMARY_PROMPT"     --arg msg "Loop complete ($MAX_ITERATIONS iterations). Summarizing changes."     '{
      "decision": "block",
      "reason": $prompt,
      "systemMessage": $msg
    }'
  exit 0
fi

# Extract base prompt (everything after the closing ---)
BASE_PROMPT="$(awk '/^---$/{i++; next} i>=2' "$STATE_FILE")"
if [[ -z "$BASE_PROMPT" ]]; then
  BASE_PROMPT="Continue the loop. Reply with a short progress note, then stop."
fi

# Create loop directory if needed
mkdir -p "$LOOP_DIR"

# =============================================================================
# AUTO-COMMIT: Commit changes from previous iteration (if any)
# =============================================================================
# Only attempt commit on iteration 2+ (iteration 1 has no previous changes)
# Only commit if there are staged or unstaged changes in target dirs/files
if [[ $ITERATION -gt 1 ]] && git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # Check if there are any changes (staged or unstaged)
  HAS_CHANGES="false"

  # Build list of targets for git add
  GIT_TARGETS=()
  while IFS= read -r dir; do
    [[ -z "$dir" ]] && continue
    if [[ "$dir" = /* ]]; then
      GIT_TARGETS+=("$dir")
    else
      GIT_TARGETS+=("$ROOT_DIR/$dir")
    fi
  done <<< "$TARGET_DIRS_STR"
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    if [[ "$file" = /* ]]; then
      GIT_TARGETS+=("$file")
    else
      GIT_TARGETS+=("$ROOT_DIR/$file")
    fi
  done <<< "$TARGET_FILES_STR"

  # Check for changes in target paths
  for target in "${GIT_TARGETS[@]}"; do
    if [[ -d "$target" ]] || [[ -f "$target" ]]; then
      # Check for unstaged changes
      if ! git -C "$ROOT_DIR" diff --quiet -- "$target" 2>/dev/null; then
        HAS_CHANGES="true"
        break
      fi
      # Check for staged changes
      if ! git -C "$ROOT_DIR" diff --cached --quiet -- "$target" 2>/dev/null; then
        HAS_CHANGES="true"
        break
      fi
      # Check for untracked files
      if [[ -d "$target" ]]; then
        UNTRACKED="$(git -C "$ROOT_DIR" ls-files --others --exclude-standard -- "$target" 2>/dev/null | head -1)"
        if [[ -n "$UNTRACKED" ]]; then
          HAS_CHANGES="true"
          break
        fi
      fi
    fi
  done

  if [[ "$HAS_CHANGES" == "true" ]]; then
    PREV_ITER=$((ITERATION - 1))

    # Stage changes in target directories/files
    for target in "${GIT_TARGETS[@]}"; do
      git -C "$ROOT_DIR" add "$target" 2>/dev/null || true
    done

    # Check if staging resulted in anything to commit
    if ! git -C "$ROOT_DIR" diff --cached --quiet 2>/dev/null; then
      # Get a brief summary of what changed
      CHANGED_COUNT="$(git -C "$ROOT_DIR" diff --cached --stat --stat-count=1 2>/dev/null | grep -oP '\d+ file' | grep -oP '\d+' || echo "?")"

      # Truncate goal for commit message (first 60 chars)
      GOAL_SHORT="${GOAL:0:60}"
      [[ ${#GOAL} -gt 60 ]] && GOAL_SHORT="${GOAL_SHORT}..."

      # Create commit
      COMMIT_MSG="[loop iter $PREV_ITER] $GOAL_SHORT

Automated commit from agent loop iteration $PREV_ITER of $MAX_ITERATIONS.
Target: $TARGETS_DISPLAY

Generated with agent loop"

      if git -C "$ROOT_DIR" commit -m "$COMMIT_MSG" >/dev/null 2>&1; then
        echo "Committed iteration $PREV_ITER changes ($CHANGED_COUNT files)" >&2
      fi
    fi
  fi
fi

# Set up log files
EVAL_LOG="$LOOP_DIR/eval.log"
FEEDBACK_LOG="$LOOP_DIR/feedback.log"
CEO_LOG="$LOOP_DIR/ceo.log"
DIFFSTAT_FILE="$LOOP_DIR/diffstat.txt"
CHANGED_FILES_FILE="$LOOP_DIR/changed-files.txt"
STATUS_FILE="$LOOP_DIR/status.txt"

utc_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

append_header() {
  local f="$1"
  local title="$2"
  {
    echo "============================================================"
    echo "$title"
    echo "UTC: $(utc_now)"
    echo "Iteration: $ITERATION"
    echo "Targets: $TARGETS_DISPLAY"
    echo "============================================================"
  } >> "$f"
}

# Optional evaluator (non-gating)
EVAL_EXIT=0
if [[ -n "$EVAL_CMD" ]]; then
  append_header "$EVAL_LOG" "EVAL"
  set +e
  (
    cd "$ROOT_DIR" || exit 127
    CEO_LOOP_TARGETS="$TARGETS_DISPLAY" bash -lc "$EVAL_CMD"
  ) >> "$EVAL_LOG" 2>&1
  EVAL_EXIT=$?
  set -e
  echo "" >> "$EVAL_LOG"
fi

# Build the goal prompt with eval signals
EVAL_TAIL=""
if [[ -f "$EVAL_LOG" ]]; then
  EVAL_TAIL="$(tail -n 80 "$EVAL_LOG" | tr -d '\r')"
fi

# Get feedback from PREVIOUS iteration (if any)
# NOTE: Only read on iteration 2+, since iteration 1 has no previous iteration
FEEDBACK_TAIL=""
if [[ $ITERATION -gt 1 ]] && [[ -f "$FEEDBACK_LOG" ]]; then
  FEEDBACK_TAIL="$(tail -n 100 "$FEEDBACK_LOG" | tr -d '\r')"
fi

# Get agent feedback from PREVIOUS iteration (if any)
AGENT_FEEDBACK_FILE="$LOOP_DIR/agent-feedback.txt"
AGENT_FEEDBACK_CONTENT=""
if [[ $ITERATION -gt 1 ]] && [[ -f "$AGENT_FEEDBACK_FILE" ]]; then
  AGENT_FEEDBACK_CONTENT="$(cat "$AGENT_FEEDBACK_FILE" | tr -d '\r')"
fi

# Log iteration info
append_header "$CEO_LOG" "CLAUDE_CODE_INFERENCE"
{
  echo "Iteration: $ITERATION"
  echo "Goal: $GOAL"
  echo ""
} >> "$CEO_LOG"

# Write a small diffstat snapshot so the loop is visible
if git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$ROOT_DIR" diff --stat > "$DIFFSTAT_FILE" 2>/dev/null || true
  git -C "$ROOT_DIR" diff --name-only > "$CHANGED_FILES_FILE" 2>/dev/null || true
  git -C "$ROOT_DIR" status --porcelain > "$STATUS_FILE" 2>/dev/null || true
else
  echo "(not a git repo)" > "$DIFFSTAT_FILE"
  echo "(not a git repo)" > "$CHANGED_FILES_FILE"
  echo "(not a git repo)" > "$STATUS_FILE"
fi

# Run feedback command (after changes are made, for next iteration)
FEEDBACK_EXIT=0
FEEDBACK_JUST_RAN="false"
if [[ -n "$FEEDBACK_CMD" ]]; then
  append_header "$FEEDBACK_LOG" "FEEDBACK (iteration $ITERATION)"
  set +e
  (
    cd "$ROOT_DIR" || exit 127
    CEO_LOOP_TARGETS="$TARGETS_DISPLAY"     CEO_LOOP_ITERATION="$ITERATION"     CEO_LOOP_GOAL="$GOAL"     bash -lc "$FEEDBACK_CMD"
  ) >> "$FEEDBACK_LOG" 2>&1
  FEEDBACK_EXIT=$?
  set -e
  echo "" >> "$FEEDBACK_LOG"
  echo "Exit code: $FEEDBACK_EXIT" >> "$FEEDBACK_LOG"
  echo "" >> "$FEEDBACK_LOG"
  FEEDBACK_JUST_RAN="true"
fi

# Bump iteration in state file
NEXT_ITERATION=$((ITERATION + 1))
TEMP_FILE="${STATE_FILE}.tmp.$$"
sed "s/^iteration: .*/iteration: $NEXT_ITERATION/" "$STATE_FILE" > "$TEMP_FILE"
mv "$TEMP_FILE" "$STATE_FILE"

# Refresh lock activity timestamp
echo "$(date +%s)" > "$LOOP_DIR/.last-activity"

# Build progress indicator
if [[ $MAX_ITERATIONS -gt 0 ]]; then
  REMAINING=$((MAX_ITERATIONS - ITERATION))
  PROGRESS_BAR=""
  for ((i=1; i<=MAX_ITERATIONS && i<=10; i++)); do
    if [[ $i -le $ITERATION ]]; then
      PROGRESS_BAR+="*"
    else
      PROGRESS_BAR+="o"
    fi
  done
  if [[ $MAX_ITERATIONS -gt 10 ]]; then
    PROGRESS_BAR+="..."
  fi
  ITER_INFO="[$ITERATION/$MAX_ITERATIONS] $PROGRESS_BAR ($REMAINING remaining)"
else
  ITER_INFO="[$ITERATION/inf]"
fi

# If next iteration would exceed max, stop on next stop attempt
if [[ $MAX_ITERATIONS -gt 0 ]] && [[ $NEXT_ITERATION -gt $MAX_ITERATIONS ]]; then
  SYSTEM_MSG="FINAL ITERATION $ITER_INFO - Loop complete after this. Review: git diff"
  OK_RESPONSE="ok"
else
  SYSTEM_MSG="LOOP $ITER_INFO | $TARGETS_DISPLAY | /stop to stop"
  if [[ $MAX_ITERATIONS -gt 0 ]]; then
    OK_RESPONSE="ok, continuing with iteration $NEXT_ITERATION of $MAX_ITERATIONS"
  else
    OK_RESPONSE="ok, continuing with iteration $NEXT_ITERATION"
  fi
fi

CHANGED_FILES_PREVIEW="$(tail -n 40 "$CHANGED_FILES_FILE" 2>/dev/null || true)"
DIFFSTAT_PREVIEW="$(tail -n 80 "$DIFFSTAT_FILE" 2>/dev/null || true)"

# Build the prompt for Claude Code
# Get fresh feedback output if it just ran
FRESH_FEEDBACK=""
if [[ "$FEEDBACK_JUST_RAN" == "true" ]] && [[ -f "$FEEDBACK_LOG" ]]; then
  FRESH_FEEDBACK="$(tail -n 100 "$FEEDBACK_LOG" | tr -d '\r')"
fi

# Build feedback section for prompt
FEEDBACK_SECTION=""
if [[ -n "$FRESH_FEEDBACK" ]]; then
  FEEDBACK_SECTION="### Feedback from this iteration
\`\`\`
$FRESH_FEEDBACK
\`\`\`

"
elif [[ -n "$FEEDBACK_TAIL" ]]; then
  FEEDBACK_SECTION="### Feedback from previous iteration
\`\`\`
$FEEDBACK_TAIL
\`\`\`

"
fi

# Add agent feedback if present
if [[ -n "$AGENT_FEEDBACK_CONTENT" ]]; then
  FEEDBACK_SECTION+="### Feedback Agent Says:

$AGENT_FEEDBACK_CONTENT

"
fi

# Build image section - check both explicit --feedback-image AND auto-detected images
IMAGE_SECTION=""
ALL_FEEDBACK_IMAGES=()

# Add explicit feedback image if set
if [[ -n "$FEEDBACK_IMAGE" ]] && [[ -f "$FEEDBACK_IMAGE" ]]; then
  ALL_FEEDBACK_IMAGES+=("$FEEDBACK_IMAGE")
fi

# Auto-detect Claude-saved feedback images in the loop directory
for ext in png jpg jpeg gif webp; do
  AUTO_IMAGE="$LOOP_DIR/feedback-image.$ext"
  if [[ -f "$AUTO_IMAGE" ]]; then
    # Avoid duplicates
    if [[ ! " ${ALL_FEEDBACK_IMAGES[*]} " =~ " ${AUTO_IMAGE} " ]]; then
      ALL_FEEDBACK_IMAGES+=("$AUTO_IMAGE")
    fi
  fi
done

# Build image section from all found images
if [[ ${#ALL_FEEDBACK_IMAGES[@]} -gt 0 ]]; then
  IMAGE_SECTION="### Visual Feedback
**IMPORTANT:** Read the image file(s) to see the current state:
"
  for img in "${ALL_FEEDBACK_IMAGES[@]}"; do
    IMAGE_SECTION+="\`\`\`
$img
\`\`\`
"
  done
  IMAGE_SECTION+="Use your Read tool on these image files to view them before making changes.

"
fi

# Build agent feedback instruction if feedback_agent is set
AGENT_INSTRUCTION=""

if [[ -n "$FEEDBACK_AGENT" ]]; then
  AGENT_INSTRUCTION="### MANDATORY: Spawn a subagent for feedback

**YOU MUST USE THE TASK TOOL TO SPAWN A SUBAGENT BEFORE MAKING ANY CHANGES.**

**AGENT SELECTION - Favor specific agents over generic ones:**
- Review your Task tool's \"Available agent types\" list
- **PREFER domain-specific agents** that match the goal (e.g., writer, editor, designer, strategist, product manager)
- **AVOID generic agents** like \"general-purpose\" or \"Explore\" unless no specific agent fits
- Match the goal keywords to agent specialties

**REQUIRED STEPS (in order):**

1. **Use the Task tool NOW** with the most relevant specialized subagent_type:
   - Introduce yourself to the agent first
   - Tell them: \"Review this for: \$GOAL. Find ONE specific improvement and explain why it matters.\"

2. **Save feedback** to \`$AGENT_FEEDBACK_FILE\`

3. **Make ONE change** based on agent's recommendation

4. **Say '$OK_RESPONSE'** - The Stop hook will automatically start the next iteration

**DO NOT skip the subagent. DO NOT invent agent types.**"
else
  AGENT_INSTRUCTION="### This iteration
1. **Pick ONE improvement** toward the goal
2. **Make the change**
3. **Say '$OK_RESPONSE'** - The Stop hook will automatically start the next iteration"
fi

MAX_DISPLAY="$MAX_ITERATIONS"
if [[ $MAX_ITERATIONS -eq 0 ]]; then
  MAX_DISPLAY="inf"
fi

REASON_PROMPT="
==================================================================
  LOOP - ITERATION $ITERATION of $MAX_DISPLAY
==================================================================

**CRITICAL: This is an AUTONOMOUS loop. You MUST complete this iteration silently.**
**NEVER ask \"shall I continue?\" - The answer is always YES. Just do the work.**

### Goal (directional - make progress, don't try to finish)
$GOAL

### Progress
$ITER_INFO

$AGENT_INSTRUCTION

### Rules (CRITICAL - FOLLOW EXACTLY)
- **NEVER ask \"shall I continue?\" or \"does this meet your approval?\"** - JUST DO IT
- **NEVER ask for permission** - The loop is AUTONOMOUS
- **DO** make one small change per iteration
- **DO** respond with \"$OK_RESPONSE\" to end your turn - next iteration starts automatically
- The loop ends automatically when max iterations reached

### MCP Resources Available
- **Contexts**: Use \`list_contexts\` to see available guidelines/docs, then \`get_context\` to read them
- **Task Escalation**: If you're blocked or need human input:
  1. First \`search_tasks\` to check if similar task already exists
  2. Only if no duplicate: use \`escalate_task\` with clear description
  3. Include what you tried and what you need to proceed

${IMAGE_SECTION}${FEEDBACK_SECTION}$(if [[ -n "$EVAL_TAIL" ]]; then echo "### Signals"; echo '```'; echo "$EVAL_TAIL"; echo '```'; echo ""; fi)

$(if [[ -n "$CHANGED_FILES_PREVIEW" ]]; then echo "### Recent changes"; echo '```'; echo "$CHANGED_FILES_PREVIEW"; echo '```'; fi)

---

**Make ONE change, then respond \"$OK_RESPONSE\" to end your turn. Next iteration starts automatically.**

**REMINDER: Do NOT ask if you should continue. Do NOT ask for approval. Just work and say \"$OK_RESPONSE\".**"

# Debug: Write full prompt to log file
DEBUG_PROMPT_FILE="$LOOP_DIR/debug-prompt.txt"
{
  echo "============================================================"
  echo "DEBUG: Full prompt sent to Claude"
  echo "UTC: $(utc_now)"
  echo "Iteration: $ITERATION"
  echo "============================================================"
  echo ""
  echo "=== SYSTEM MESSAGE ==="
  echo "$SYSTEM_MSG"
  echo ""
  echo "=== REASON PROMPT ==="
  echo "$REASON_PROMPT"
  echo ""
} > "$DEBUG_PROMPT_FILE"

# Block stop and feed prompt back
jq -n   --arg prompt "$REASON_PROMPT"   --arg msg "$SYSTEM_MSG"   '{
    "decision": "block",
    "reason": $prompt,
    "systemMessage": $msg
  }'
