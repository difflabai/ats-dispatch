---
description: "Execute a single task with agent review then implementation"
argument-hint: "<task description>"
allowed-tools: ["Bash", "Glob", "Read", "Write", "Edit", "Task", "AskUserQuestion"]
---

**IMPORTANT: This is a single-iteration task - review then execute.**

# Task Execution: $ARGUMENTS

You've been given a task to complete. Follow this two-phase approach:

## Phase 1: Review (spawn a subagent)

**YOU MUST spawn an agent to analyze the task FIRST.**

**AGENT SELECTION - Favor specific agents over generic ones:**
- Review your Task tool's "Available agent types" list
- **PREFER domain-specific agents** that match the task (e.g., writer, editor, designer, strategist, CTO, product manager)
- **AVOID generic agents** like "general-purpose" or "Explore" unless no specific agent fits
- Match the task keywords to agent specialties

Use the Task tool IMMEDIATELY with the most relevant specialized agent's name as `subagent_type`.

Introduce yourself to the agent first (say hi, explain you're from difflab.ai and need their expertise).

Then prompt the agent:
```
Analyze this task and create an implementation plan: "$ARGUMENTS"

1. Explore the relevant parts of the codebase
2. Identify files that need to be modified or created
3. Consider potential issues or edge cases
4. Provide a clear, step-by-step implementation plan

Return: {files_to_modify: [...], plan: [...], concerns: [...]}
```

**DO NOT skip this step. DO NOT start implementing before the agent reviews.**

## Phase 2: Execute

After the agent returns with their analysis:

1. **Review the plan** - Make sure it makes sense
2. **Implement the changes** - Follow the agent's recommendations
3. **Verify** - Run any relevant tests or checks
4. **Report** - Summarize what was done

If the agent raised concerns, address them during implementation.

---

This is a single execution, not a loop. Complete the task and report back.
