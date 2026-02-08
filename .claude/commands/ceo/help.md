---
description: "Explain agent loop commands"
---

# DiffLab.AI Agent Loop Commands

Run iterative improvement loops with AI agents from your organization.

## Commands

### /ceo:while

Start a continuous autonomous agent loop.

**Simple usage:**
```
/ceo:while improve the UI
/ceo:while add more enemy types
```

**With flags:**
```
/ceo:while --dir src --goal "Improve code quality" --max-iterations 5
```

The loop runs automatically until max iterations. Use `/ceo:stop` to cancel.

### /ceo:status

Check the current loop progress (iteration count, goal, recent changes).

### /ceo:stop

Stop all loops in this repository.

### /ceo:do

Execute a single task with agent review then implementation. Like a one-shot `/ceo:while`.

**Usage:**
```
/ceo:do Add a dark mode toggle to the settings page
/ceo:do Fix the login form validation
```

An agent first reviews and plans the task, then you implement it.

### /ceo:help

Show this help message.

## How It Works

### /ceo:while (autonomous loop)
- Runs N iterations automatically (you pick 3/5/15/40)
- Each iteration: subagent reviews → you improve → auto-continue
- No asking for permission - fully autonomous
- Cancel with `/ceo:stop`

### /ceo:do (single task)
- One-shot: agent reviews → you implement → done
- Good for specific tasks that don't need iteration
