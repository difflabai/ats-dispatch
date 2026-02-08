#!/bin/bash
# PreToolUse Hook - Auto-approves bash commands for this plugin's scripts
# Also captures session_id for setup-loop.sh to enable session-safe claiming
set -euo pipefail

# Read hook input from stdin
HOOK_INPUT="$(cat)"

# Get the tool name
TOOL_NAME="$(echo "$HOOK_INPUT" | jq -r '.tool_name // empty')"

# Only process Bash tool calls
if [[ "$TOOL_NAME" != "Bash" ]]; then
  exit 0
fi

# Get the command being executed
COMMAND="$(echo "$HOOK_INPUT" | jq -r '.tool_input.command // empty')"

# Get the plugin root directory
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [[ -z "$PLUGIN_ROOT" ]]; then
  PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

# Check if the command references our plugin scripts
should_approve=false
is_setup_loop=false

# Pattern 1: Command contains absolute path to our scripts
if [[ "$COMMAND" == *"${PLUGIN_ROOT}/scripts/"* ]]; then
  should_approve=true
  if [[ "$COMMAND" == *"setup-loop.sh"* ]]; then
    is_setup_loop=true
  fi
fi

# Pattern 2: Command contains relative .claude-plugin path
if [[ "$COMMAND" == *".claude-plugin/scripts/"* ]]; then
  should_approve=true
  if [[ "$COMMAND" == *"setup-loop.sh"* ]]; then
    is_setup_loop=true
  fi
fi

# Pattern 3: Command contains CLAUDE_PLUGIN_ROOT variable reference (legacy)
if [[ "$COMMAND" == *'${CLAUDE_PLUGIN_ROOT}/scripts/'* ]]; then
  should_approve=true
fi
if [[ "$COMMAND" == *'"${CLAUDE_PLUGIN_ROOT}/scripts/'* ]]; then
  should_approve=true
fi

# If this is setup-loop.sh, capture session_id for session-safe claiming
# This prevents race conditions when multiple sessions start loops
if [[ "$is_setup_loop" == "true" ]]; then
  SESSION_ID="$(echo "$HOOK_INPUT" | jq -r '.session_id // empty')"
  if [[ -n "$SESSION_ID" ]]; then
    # Write session_id to a temp file that setup-loop.sh will read
    # Use git root or current dir as base
    ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
    mkdir -p "$ROOT_DIR/.claude/start"
    echo "$SESSION_ID" > "$ROOT_DIR/.claude/start/.pending-session-id"
  fi
fi

if [[ "$should_approve" == "true" ]]; then
  echo '{"permissionDecision": "allow"}'
else
  exit 0
fi
