# Ada Dispatch

ATS task watcher that routes tasks to the nanobot gateway (Ada). Create tasks on the `ada-dispatch` channel from any trusted source, and Ada will execute them autonomously. Supports end-to-end encrypted tasks via NaCl public-key cryptography.

## How it works

1. Validates environment on startup (preflight checks for `ats` and `nanobot` binaries)
2. Drains any pending tasks already in the channel
3. Watches ATS for new tasks on the `ada-dispatch` channel via WebSocket
4. Claims each task with a 10-minute lease (renewed automatically during execution)
5. **If the task is encrypted**, decrypts it using the sender's trusted public key
6. Invokes `nanobot agent` with the task content as a structured prompt
7. Captures the agent's response and completes/fails the ATS task accordingly
8. Optionally notifies a webhook URL on task completion or failure

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

## Encrypted tasks

Ada-dispatch supports end-to-end encrypted task submission using NaCl public-key authenticated encryption (X25519 + XSalsa20-Poly1305 via `tweetnacl`). Encrypted tasks are opt-in — unencrypted tasks continue to work exactly as before.

### How it works

1. Ada-dispatch has its own X25519 keypair stored in `dispatch-keys.json`
2. Trusted task submitters are registered in `trusted-keys.json` with their public keys
3. A submitter encrypts the task content (title, description, payload) using Ada's public key and their own secret key (NaCl box)
4. The encrypted blob is submitted as the task payload with `encrypted: true` and `sender: <entity-name>`
5. Ada-dispatch decrypts the task using its secret key + the sender's registered public key
6. If the sender is unknown or decryption fails, the task is rejected and marked as failed

### Setup (Ada-dispatch side)

**1. Generate Ada's keypair:**

```bash
node index.js keygen
```

This creates `dispatch-keys.json` with a new X25519 keypair. Share the **public key** with task submitters.

**2. Register trusted entities:**

```bash
node index.js add-key alice <alice-public-key-base64>
node index.js add-key bob <bob-public-key-base64>
```

**3. List registered keys:**

```bash
node index.js list-keys
```

### Setup (Task submitter side)

**1. Generate your keypair:**

```bash
node encrypt-task.js --keygen
```

This creates `my-keys.json` with your X25519 keypair. Share your **public key** with the Ada-dispatch operator so they can register it.

**2. Get Ada's public key** from the dispatch operator (they run `node index.js list-keys`).

**3. Register your key with Ada:**

Ask the operator to run:
```bash
node index.js add-key <your-name> <your-public-key>
```

### Submitting encrypted tasks

**Using the helper script:**

```bash
node encrypt-task.js \
  --title "Analyze security logs" \
  --description "Review the last 24 hours of auth logs for anomalies" \
  --ada-key <ada-public-key-base64> \
  --sender alice

# With additional payload
node encrypt-task.js \
  --title "Deploy to staging" \
  --payload '{"branch": "feature/new-api"}' \
  --ada-key <ada-public-key-base64> \
  --sender alice

# Dry run — print encrypted payload without submitting
node encrypt-task.js \
  --title "Test encryption" \
  --ada-key <ada-public-key-base64> \
  --sender alice \
  --dry-run
```

**Manual submission with ats CLI:**

If you implement encryption yourself, the payload format is:

```json
{
  "encrypted": true,
  "sender": "alice",
  "nonce": "<base64-encoded-24-byte-nonce>",
  "ciphertext": "<base64-encoded-nacl-box-ciphertext>"
}
```

The ciphertext decrypts to a JSON object:

```json
{
  "title": "The real task title",
  "description": "The real task description",
  "payload": { "any": "additional fields" }
}
```

Submit it:

```bash
ats create "Encrypted task" \
  --channel ada-dispatch \
  --payload '{"encrypted":true,"sender":"alice","nonce":"...","ciphertext":"..."}'
```

The title in `ats create` is a placeholder — the real title comes from the encrypted blob.

### Encryption details

- **Algorithm:** NaCl box (X25519 key agreement + XSalsa20-Poly1305 AEAD)
- **Library:** `tweetnacl` (audited, minimal, no native dependencies)
- **Key type:** X25519 (Curve25519) keypairs, 32 bytes each
- **Nonce:** 24 bytes, randomly generated per message
- **Authentication:** Authenticated encryption — tampered ciphertext is detected and rejected
- **Key files:** `dispatch-keys.json` (Ada's keypair, keep secret), `trusted-keys.json` (public keys of trusted entities)

### Security notes

- **Keep `dispatch-keys.json` private.** It contains Ada's secret key. Add it to `.gitignore`.
- **`trusted-keys.json` is not secret** — it only contains public keys. But only the operator should modify it.
- Encrypted tasks provide confidentiality (only Ada can read them) and authenticity (Ada verifies the sender).
- The `sender` field in the payload is cleartext — it identifies which public key to use for decryption, not a security assertion. The cryptographic verification is what proves the sender's identity.

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
| `quiet`        | ada-dispatch     | Suppress Telegram notifications           |
| `encrypted`    | ada-dispatch     | Marks task as encrypted (boolean)         |
| `sender`       | ada-dispatch     | Entity name for key lookup                |
| `nonce`        | ada-dispatch     | NaCl box nonce (base64)                   |
| `ciphertext`   | ada-dispatch     | Encrypted task blob (base64)              |

## CLI commands

| Command                           | Description                        |
|-----------------------------------|------------------------------------|
| `node index.js`                   | Start the watcher (normal mode)    |
| `node index.js keygen`            | Generate Ada's keypair             |
| `node index.js add-key name key`  | Register a trusted entity          |
| `node index.js list-keys`         | List trusted entities and Ada's key|

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
| `CHANNEL`            | ada-dispatch | ATS channel to watch               |
| `LEASE_MS`           | 600000     | Task lease duration (10 min)         |
| `NANOBOT_TIMEOUT_MS` | 300000     | Nanobot execution timeout (5 min)    |
| `MAX_TASK_RETRIES`   | 3          | Max attempts before skipping a task  |

## Architecture

- `index.js` — main watcher + key management CLI
- `encrypt-task.js` — helper script for submitters to encrypt and submit tasks
- `tweetnacl` + `tweetnacl-util` — NaCl cryptography (the only npm dependencies)
- Uses `ats` CLI for all ATS operations
- Uses `nanobot agent` for task execution via the gateway
- Structured JSON logging to stdout
- Graceful shutdown on SIGINT/SIGTERM with child process cleanup
