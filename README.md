# Ada Dispatch

ATS task watcher that routes tasks to the nanobot gateway (Ada). Create tasks on the `ada-dispatch` channel from any trusted source, and Ada will execute them autonomously.

## How it works

1. Validates environment on startup (preflight checks for `ats` and `nanobot` binaries)
2. Drains any pending tasks already in the channel
3. Polls ATS for pending tasks on the `ada-dispatch` channel every 5 seconds
4. Claims each task with a 10-minute lease (renewed automatically during execution)
5. Invokes `nanobot agent` with the task content as a structured prompt
6. Captures the agent's response and completes/fails the ATS task accordingly
7. Optionally notifies a webhook URL on task completion or failure

## Usage

```bash
node index.js
```

The service will refuse to start if `ats` or `nanobot` binaries are missing or broken. This is intentional — environment problems surface immediately, not when the first task arrives.

## Creating tasks

From any machine with ATS access:

```bash
ats create "Summarize the latest sales metrics" \
  --channel ada-dispatch \
  --description "Pull data from the dashboard and create a brief summary"

ats create "Review PR #42" \
  --channel ada-dispatch \
  --payload '{"repo": "difflab/core", "pr": 42}'
```

### With webhook callback

Include `callback_url` in the payload to receive a POST notification when the task completes or fails:

```bash
ats create "Generate weekly report" \
  --channel ada-dispatch \
  --description "Compile metrics from the past 7 days" \
  --payload '{"callback_url": "https://example.com/hooks/ada"}'
```

The callback receives a JSON POST with `task_id`, `status` ("completed" or "failed"), `result`, and `completed_at`. Note: `callback_url` is consumed by ada-dispatch and **not** forwarded to the agent. Use a different field name if you need to pass a URL to the agent.

## Task format

| Field       | Description                                       |
|-------------|---------------------------------------------------|
| title       | Short description (required)                      |
| description | Full instructions for the agent (optional)         |
| payload     | JSON with extra context (optional)                 |

### Reserved payload fields

| Field          | Used by          | Description                              |
|----------------|------------------|------------------------------------------|
| `callback_url` | ada-dispatch     | Webhook URL for completion notification   |

## Operational behavior

### Startup preflight
On startup, ada-dispatch validates that both `ats` and `nanobot` binaries exist and respond to `--version`. If either check fails, the service exits immediately with a clear error.

### Poll backoff
If ATS polling fails (network issue, service outage), ada-dispatch backs off exponentially: 5s → 10s → 20s → 40s → 60s (cap). When connectivity recovers, it logs a recovery event and resets to normal polling.

### Lease renewal
During nanobot execution, the task lease is renewed every 5 minutes (half the 10-minute lease duration). This prevents lease expiry on long-running tasks and avoids duplicate execution.

### Poison task guard
If a task fails 3 consecutive times, ada-dispatch stops retrying it and marks it as permanently failed in ATS with a distinct log event. This prevents a single bad task from blocking the entire queue.

### Graceful shutdown
On SIGINT/SIGTERM:
- If a nanobot invocation is in progress, the child process is killed immediately
- The interrupted task is **not** marked as failed — it returns to pending after the lease expires and will be retried
- The retry counter is not incremented for shutdown-interrupted tasks
- The service exits cleanly without waiting for the nanobot timeout

### Prompt construction
Task content is wrapped in XML delimiters (`<task-title>`, `<task-description>`, `<task-context>`) with a system preamble. Internal dispatch fields are stripped from the payload before it reaches the agent.

## Configuration

All configuration is in `index.js` constants:

| Constant             | Value      | Description                          |
|----------------------|------------|--------------------------------------|
| `CHANNEL`            | ada-dispatch | ATS channel to poll                |
| `POLL_INTERVAL_MS`   | 5000       | Poll frequency                       |
| `LEASE_MS`           | 600000     | Task lease duration (10 min)         |
| `NANOBOT_TIMEOUT_MS` | 300000     | Nanobot execution timeout (5 min)    |
| `MAX_BACKOFF_MS`     | 60000      | Max poll retry backoff (1 min)       |
| `MAX_TASK_RETRIES`   | 3          | Max attempts before skipping a task  |

## Architecture

- Single `index.js`, zero npm dependencies
- Uses `ats` CLI for all ATS operations
- Uses `nanobot agent` for task execution via the gateway
- Structured JSON logging to stdout
- Graceful shutdown on SIGINT/SIGTERM with child process cleanup
