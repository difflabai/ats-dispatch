# ats-dispatch

A reference implementation of an **ATS task executor** — a bot that watches an [ATS](https://github.com/difflabai/ats) channel via WebSocket, claims incoming tasks, executes them via a subprocess, and reports results back.

Use this as a starting point for building your own autonomous agent that responds to ATS tasks.

## Why this exists

ATS (Agent Task Service) is a task orchestration system. But a task system is only useful if something picks up the tasks and does the work. **ats-dispatch** shows how to build that "something":

1. Connect to an ATS channel via WebSocket
2. When a task appears, claim it (so no one else grabs it)
3. Run it — invoke an LLM, call a script, hit an API, whatever
4. Report the result back to ATS (complete or fail)
5. Optionally notify humans (Telegram, webhook, etc.)

The execution backend is pluggable. Our deployment uses [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude -p`), but you could swap in any subprocess, HTTP call, or function.

## Architecture

```
ATS Channel (WebSocket)
    │
    ▼
┌──────────────┐
│ ats-dispatch │
│              │
│  claim task  │──► subprocess (claude, python, bash, ...)
│  renew lease │
│  post result │◄── stdout / exit code
│  notify      │──► Telegram / webhook
└──────────────┘
```

**Key design decisions:**
- **WebSocket-first** — instant task pickup, no polling delay
- **Lease-based ownership** — tasks are claimed with a time-limited lease, renewed during execution. If the bot dies, the lease expires and ATS makes the task available again
- **Poison task guard** — if a task fails 3 times, it's marked permanently failed instead of retrying forever
- **Graceful shutdown** — on SIGINT/SIGTERM, in-flight tasks aren't marked failed; they return to pending after lease expiry
- **Optional encryption** — supports NaCl public-key encryption for sensitive task payloads
- **Dependency graph** — tasks with `depends_on` are deferred until all dependencies complete; failures cascade to dependents

## Quick start

```bash
git clone https://github.com/difflabai/ats-dispatch.git
cd ats-dispatch
npm install
```

Configure the constants at the top of `index.js`:

| Constant | Default | Description |
|---|---|---|
| `ATS_BIN` | `/usr/local/bin/ats` | Path to the `ats` CLI binary |
| `NANOBOT_BIN` | `/usr/local/bin/claude` | Path to the subprocess binary (your execution backend) |
| `CHANNEL` | `ada-dispatch` | ATS channel to watch |
| `LEASE_MS` | `7200000` (2h) | How long a task lease lasts |
| `NANOBOT_TIMEOUT_MS` | `3600000` (60m) | Max execution time per task |
| `MAX_TASK_RETRIES` | `3` | Attempts before marking a task as poison |
| `TELEGRAM_CHAT_ID` | — | Telegram user/group ID for notifications (optional) |
| `TELEGRAM_TOKEN` | — | Telegram bot token (optional) |

Then run:

```bash
node index.js
```

The service validates that your `ats` and execution binaries exist on startup. If either is missing, it exits immediately with a clear error.

## Creating tasks

From any machine with ATS access:

```bash
# Simple task
ats create "Summarize the latest sales metrics" \
  --channel your-channel \
  --description "Pull data from the dashboard and create a brief summary"

# With structured payload
ats create "Review PR #42" \
  --channel your-channel \
  --payload '{"repo": "myorg/core", "pr": 42}'

# With webhook callback
ats create "Generate weekly report" \
  --channel your-channel \
  --description "Compile metrics from the past 7 days" \
  --payload '{"callback_url": "https://example.com/hooks/task-done"}'
```

The callback receives a JSON POST with `task_id`, `status`, `result`, and `completed_at`.

## Task dependencies

Tasks can declare dependencies on other tasks using `depends_on`. A task with dependencies won't run until all dependencies reach `completed` status. If any dependency fails or is cancelled, the dependent task is automatically marked as failed.

```bash
# Create a chain of dependent tasks
node index.js create "Step 1: Generate data" --description "..."
# → Created task #100

node index.js create "Step 2: Process data" --description "..." --depends-on 100
# → Created task #101, depends on #100

node index.js create "Step 3: Upload results" --description "..." --depends-on 101
# → Created task #102, depends on #101

# Multiple dependencies
node index.js create "Final report" --description "..." --depends-on 100,101,102
```

View the dependency graph:

```bash
node index.js deps              # Show all tasks with dependencies
node index.js deps --task 102   # Show deps for a specific task
```

When using `ats create` directly, pass dependencies via payload:

```bash
ats create "Step 2" --channel ada-dispatch \
  --payload '{"depends_on": ["100"]}'
```

## Encrypted tasks

ats-dispatch supports end-to-end encrypted task submission using NaCl public-key authenticated encryption (X25519 + XSalsa20-Poly1305 via `tweetnacl`).

### Setup

```bash
# Generate the dispatcher's keypair
node index.js keygen

# Register a trusted task submitter
node index.js add-key alice <alice-public-key-base64>

# List registered keys
node index.js list-keys
```

### Submitting encrypted tasks

```bash
# Generate your keypair (task submitter side)
node encrypt-task.js --keygen

# Encrypt and submit
node encrypt-task.js \
  --title "Analyze security logs" \
  --description "Review the last 24 hours of auth logs" \
  --ada-key <dispatcher-public-key-base64> \
  --sender alice
```

See `encrypt-task.js` for the full encryption protocol. Algorithm: NaCl box (X25519 key agreement + XSalsa20-Poly1305 AEAD).

## Operational behavior

- **Startup preflight** — validates binaries before accepting tasks
- **Lease renewal** — heartbeat messages keep the lease alive during long-running tasks
- **Poison task guard** — 3 failures = permanently failed, won't block the queue
- **Graceful shutdown** — SIGINT/SIGTERM kills the subprocess but doesn't fail the task; it returns to pending after lease expiry
- **Structured logging** — JSON to stdout, easy to pipe into any log aggregator

## Running as a service

Example systemd unit:

```ini
[Unit]
Description=ats-dispatch — ATS task executor
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/ats-dispatch
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

## Our deployment: Ada Dispatch

We run ats-dispatch as **Ada Dispatch** — watching the `ada-dispatch` channel, executing tasks via Claude Code (`claude -p --dangerously-skip-permissions`). When you see references to "Ada" in the code, that's our deployment identity, not the project itself.

Tasks dispatched to Ada:
```bash
ats create "Build a REST API for user management" \
  --channel ada-dispatch \
  --description "Create Express routes for CRUD operations with SQLite"
```

Ada picks it up, runs Claude Code, and posts the result back to ATS. Telegram notification on completion or failure.

## License

MIT
