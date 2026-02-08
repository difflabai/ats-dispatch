---
description: "Start a continuous agent loop on directories or files"
argument-hint: "<goal> | --dir PATH --goal '...' [--max-iterations N]"
allowed-tools: ["Bash", "Glob", "Read", "Task", "AskUserQuestion"]
---

# Start Agent Loop

**YOU MUST RUN setup-loop.sh - This script activates the loop. Without it, there is no loop.**

## Step 1: Determine target directory

If $ARGUMENTS contains `--dir`:
- Use those flags directly

If $ARGUMENTS is just a goal (e.g., "improve the UI"):
- Use Glob to find the main source directory (src/, app/, lib/, game/, etc.)
- Pick the most relevant directory for the goal

## Step 2: Ask about iterations

Use AskUserQuestion with ONE question:
- Header: "Iterations"
- Question: "How many iterations for: [THE GOAL]?"
- Options: "3 (quick)", "5 (standard)", "15 (thorough)", "40 (extensive)"

## Step 3: RUN THE SETUP SCRIPT (REQUIRED)

```bash
.claude-plugin/scripts/setup-loop.sh --dir TARGET_DIR --goal "THE_GOAL" --max-iterations N
```

**If you don't run this script, the loop will NOT work.**

## Step 4: Say "done" to start

The Stop hook takes over automatically. Each iteration:
1. You make one improvement
2. You say "done" to signal completion
3. **The Stop hook automatically injects the next iteration** - you don't continue yourself

The loop runs until max iterations are reached. Cancel anytime: `/ceo:stop`
