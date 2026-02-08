---
description: "Check the status of the active loop"
allowed-tools: ["Bash", "Read"]
---

# Loop Status

Check the current loop status by running this command:

```
bash -c '
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
if [[ -z "$(find "$ROOT/.claude/start" -name "state.local.md" 2>/dev/null)" ]]; then
  echo "NO_ACTIVE_LOOPS"
  exit 0
fi
find "$ROOT/.claude/start" -name "state.local.md" 2>/dev/null | while read -r state_file; do
  LOOP_DIR="$(dirname "$state_file")"
  SLUG="$(basename "$LOOP_DIR")"
  echo "=== Loop: $SLUG ==="
  cat "$state_file"
  echo ""
  # Lock ownership
  if [[ -f "$LOOP_DIR/.lock-owner" ]]; then
    echo "Lock owner: $(cat "$LOOP_DIR/.lock-owner")"
  else
    echo "Lock owner: (none - orphan loop)"
  fi
  # Last activity
  if [[ -f "$LOOP_DIR/.last-activity" ]]; then
    LAST_ACT=$(cat "$LOOP_DIR/.last-activity")
    NOW=$(date +%s)
    AGE=$((NOW - LAST_ACT))
    echo "Last activity: ${AGE}s ago"
    if [[ $AGE -gt 600 ]]; then
      echo "  NOTE: Loop inactive for >10 min - only owner session can run it"
      echo "  Use /stop to clean up if orphaned"
    fi
  fi
  # Background job status
  if [[ -f "$LOOP_DIR/pending" ]]; then
    PID=$(cat "$LOOP_DIR/pending")
    if kill -0 "$PID" 2>/dev/null; then
      echo "Background job: running (PID $PID)"
    else
      echo "Background job: finished"
    fi
  fi
  echo ""
done
# Git changes
echo "=== Recent changes ==="
git diff --stat 2>/dev/null | tail -10
'
```

Based on the output:
- **If NO_ACTIVE_LOOPS**: Say "No loops are currently running."
- **If loops are active**: Show a visual summary:
  - Extract iteration, max_iterations, target_dirs, target_files, goal from the state frontmatter
  - Build a progress bar: filled dots for completed, empty for remaining
  - Show: iteration X of Y (Z remaining)
  - Show the goal
  - Remind user: `/ceo:stop` to cancel the loop
