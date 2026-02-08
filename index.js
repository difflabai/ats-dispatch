#!/usr/bin/env node

import { execSync, execFileSync, execFile, spawn } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import { createInterface } from 'node:readline';

// === Config ===
const ATS_BIN = '/usr/bin/ats';
const NANOBOT_BIN = '/home/openclaw/nanobot/.venv/bin/nanobot';
const CHANNEL = 'ada-dispatch';
const TELEGRAM_CHAT_ID = '6644666619';
const LEASE_MS = 600000;          // 10 minutes
const NANOBOT_TIMEOUT_MS = 300000; // 5 minutes
const MAX_TASK_RETRIES = 3;
const ACTOR_FLAGS = ['--actor-type', 'agent', '--actor-id', 'ada-dispatch', '--actor-name', 'Ada Dispatch'];
const INTERNAL_PAYLOAD_FIELDS = ['callback_url', 'quiet'];

// Watch reconnection
const WATCH_RECONNECT_BASE_MS = 2000;
const WATCH_RECONNECT_MAX_MS = 60000;

// Track retry counts per task ID to detect poison tasks
const taskRetries = new Map();
// Track tasks currently being processed to avoid duplicates
const processingTasks = new Set();

let running = true;

// === Logging ===
function log(level, msg, data = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

// === Telegram ===
const TELEGRAM_TOKEN = '8516158841:AAEiuEc956VdL0i6NIRqJ8o606ZYGV4AmDU';

function telegram(text) {
  const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' });
  const req = https.request(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 10000,
  }, (res) => {
    res.resume();
    if (res.statusCode !== 200) log('warn', 'Telegram API error', { statusCode: res.statusCode });
  });
  req.on('error', (err) => log('warn', 'Telegram send failed', { error: err.message }));
  req.write(body);
  req.end();
}

function shouldNotify(task) {
  return !task.payload?.quiet;
}

// === Preflight ===
function preflight() {
  for (const check of [{ name: 'ats', bin: ATS_BIN }, { name: 'nanobot', bin: NANOBOT_BIN }]) {
    try {
      const version = execSync(`'${check.bin}' --version`, {
        encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      log('info', `Preflight passed: ${check.name}`, { bin: check.bin, version });
    } catch (err) {
      log('error', `Preflight failed: ${check.name}`, { bin: check.bin, error: err.message });
      process.exit(1);
    }
  }
}

// === ATS helpers ===
function ats(...args) {
  const fullArgs = [...ACTOR_FLAGS, ...args];
  try {
    return execFileSync(ATS_BIN, fullArgs, {
      encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    log('debug', 'ats command failed', { args: fullArgs, stderr: err.stderr, stdout: err.stdout });
    throw err;
  }
}

function atsJSON(...args) {
  const raw = ats(...args, '-f', 'json');
  // Handle both array and single-object responses
  const arrayMatch = raw.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try { return JSON.parse(arrayMatch[0]); } catch { return []; }
  }
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch { return null; }
  }
  return [];
}

function getTask(taskId) {
  const raw = ats('get', String(taskId), '-f', 'json');
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function listPending() {
  const tasks = atsJSON('list', '--channel', CHANNEL, '--status', 'pending');
  return Array.isArray(tasks) ? tasks : [];
}

function claimTask(taskId) {
  ats('claim', String(taskId), '--lease', String(LEASE_MS));
}

function completeTask(taskId, outputs) {
  ats('complete', String(taskId), '--outputs', JSON.stringify(outputs));
}

function failTask(taskId, reason) {
  ats('fail', String(taskId), '--reason', reason);
}

function postMessage(taskId, message) {
  try { ats('message', 'add', String(taskId), message); }
  catch (err) { log('warn', 'Failed to post ATS message', { taskId, error: err.message }); }
}

// === Callback notification ===
async function notifyCallback(task, status, result) {
  const callbackUrl = task.payload?.callback_url;
  if (!callbackUrl) return;

  const taskId = task.id || task.uuid;
  const body = JSON.stringify({ task_id: taskId, status, result, completed_at: new Date().toISOString() });

  try {
    const url = new URL(callbackUrl);
    const transport = url.protocol === 'https:' ? https : http;
    await new Promise((resolve, reject) => {
      const req = transport.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 10000,
      }, (res) => { res.resume(); resolve(); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    log('info', 'Callback notified', { taskId, callbackUrl, status });
  } catch (err) {
    log('warn', 'Callback notification failed', { taskId, callbackUrl, error: err.message });
  }
}

// === Prompt builder ===
function buildPrompt(task) {
  const parts = ['You are Ada, processing a task from the ada-dispatch channel. Execute the task described below.'];
  if (task.title) parts.push(`<task-title>\n${task.title}\n</task-title>`);
  if (task.description) parts.push(`<task-description>\n${task.description}\n</task-description>`);
  if (task.payload) {
    const safePayload = { ...task.payload };
    for (const field of INTERNAL_PAYLOAD_FIELDS) delete safePayload[field];
    if (Object.keys(safePayload).length > 0) {
      parts.push(`<task-context>\n${JSON.stringify(safePayload, null, 2)}\n</task-context>`);
    }
  }
  return parts.join('\n\n');
}

// === Nanobot execution ===
function runNanobot(prompt, sessionId) {
  let child;
  const promise = new Promise((resolve, reject) => {
    child = execFile(
      NANOBOT_BIN,
      ['agent', '-m', prompt, '-s', sessionId],
      { timeout: NANOBOT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' },
      (error, stdout) => {
        if (error) reject(new Error(error.killed ? 'Nanobot cancelled or timed out' : (error.message || 'Nanobot execution failed')));
        else resolve(stdout);
      }
    );
  });
  return { promise, child };
}

// === Task processing ===
async function processTask(task) {
  const taskId = task.id || task.uuid;

  // Prevent duplicate processing
  if (processingTasks.has(taskId)) {
    log('debug', 'Task already being processed, skipping', { taskId });
    return;
  }

  // Poison task guard
  const retryCount = taskRetries.get(taskId) || 0;
  if (retryCount >= MAX_TASK_RETRIES) {
    log('error', 'Task exceeded max retries, skipping', { taskId, retryCount, title: task.title });
    try { failTask(taskId, `Exceeded max retry attempts (${MAX_TASK_RETRIES})`); } catch {}
    await notifyCallback(task, 'failed', `Exceeded max retry attempts (${MAX_TASK_RETRIES})`);
    if (shouldNotify(task)) telegram(`❌ Failed: ${task.title} — exceeded max retries`);
    return;
  }
  taskRetries.set(taskId, retryCount + 1);
  processingTasks.add(taskId);

  log('info', 'Processing task', { taskId, title: task.title, attempt: retryCount + 1 });

  // Claim
  try {
    claimTask(taskId);
    log('info', 'Claimed task', { taskId });
    postMessage(taskId, 'Agent processing started');
    if (shouldNotify(task)) telegram(`🎯 Ada picked up: ${task.title} (ID: ${taskId})`);
  } catch (err) {
    log('error', 'Failed to claim task', { taskId, error: err.message });
    processingTasks.delete(taskId);
    return;
  }

  // Build prompt and run nanobot
  const prompt = buildPrompt(task);
  const sessionId = `ada-dispatch:${taskId}`;
  log('info', 'Invoking nanobot', { taskId, sessionId, promptLength: prompt.length });

  // Lease renewal
  const renewInterval = setInterval(() => {
    try {
      claimTask(taskId); // renew = re-claim
      postMessage(taskId, 'Agent still processing (lease renewed)');
      log('info', 'Lease renewed', { taskId });
    } catch (err) {
      log('warn', 'Lease renewal failed', { taskId, error: err.message });
    }
  }, LEASE_MS / 2);

  // Run nanobot with shutdown-aware cancellation
  const { promise: nanobotResult, child: nanobotChild } = runNanobot(prompt, sessionId);
  let cancelledByShutdown = false;

  const onShutdown = () => {
    cancelledByShutdown = true;
    log('info', 'Killing nanobot due to shutdown', { taskId });
    nanobotChild.kill('SIGTERM');
  };
  process.on('SIGTERM', onShutdown);
  process.on('SIGINT', onShutdown);

  try {
    const output = await nanobotResult;
    log('info', 'Nanobot completed', { taskId, outputLength: output.length });

    completeTask(taskId, { response: output.trim() });
    taskRetries.delete(taskId);
    log('info', 'Task completed', { taskId });
    await notifyCallback(task, 'completed', output.trim());
    if (shouldNotify(task)) {
      const snippet = output.trim().slice(0, 200);
      telegram(`✅ Done: ${task.title} — ${snippet}`);
    }
  } catch (err) {
    if (cancelledByShutdown) {
      log('info', 'Task interrupted by shutdown, will be retried', { taskId });
      taskRetries.delete(taskId);
    } else {
      log('error', 'Nanobot failed', { taskId, error: err.message });
      try {
        failTask(taskId, err.message);
        log('info', 'Task marked as failed', { taskId });
        await notifyCallback(task, 'failed', err.message);
        if (shouldNotify(task)) telegram(`❌ Failed: ${task.title} — ${err.message.slice(0, 200)}`);
      } catch (failErr) {
        log('error', 'Failed to mark task as failed', { taskId, error: failErr.message });
      }
    }
  } finally {
    clearInterval(renewInterval);
    process.removeListener('SIGTERM', onShutdown);
    process.removeListener('SIGINT', onShutdown);
    processingTasks.delete(taskId);
  }
}

// === Event handler ===
async function handleEvent(event) {
  // Only react to task.created events
  if (event.type !== 'task.created') return;

  const taskId = event.task_id || event.data?.id || event.data?.task_id;
  if (!taskId) {
    log('warn', 'task.created event missing task_id', { event });
    return;
  }

  log('info', 'Received task.created event', { taskId });

  // Fetch full task to get payload, description, etc.
  let task;
  try {
    task = getTask(taskId);
  } catch (err) {
    log('error', 'Failed to fetch task', { taskId, error: err.message });
    return;
  }
  if (!task) {
    log('warn', 'Task not found', { taskId });
    return;
  }

  // Only process pending tasks
  if (task.status !== 'pending') {
    log('debug', 'Task not pending, skipping', { taskId, status: task.status });
    return;
  }

  await processTask(task);
}

// === WebSocket watcher ===
function startWatch() {
  let reconnectDelay = WATCH_RECONNECT_BASE_MS;

  function launchWatch() {
    if (!running) return;

    const args = [...ACTOR_FLAGS, 'watch', '--channel', CHANNEL, '--events', 'task.created'];
    log('info', 'Starting ATS watch', { args: [ATS_BIN, ...args].join(' ') });

    const child = spawn(ATS_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const rl = createInterface({ input: child.stdout });

    // ats watch outputs human-readable lines:
    //   [1:13:05 PM] task.created
    //   Task #278: What is the current weather in Denver?
    //   Status: pending, Channel: ada-dispatch
    // We parse "Task #<ID>" lines to extract the task ID.
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('Connecting') || trimmed.startsWith('✓') || trimmed.startsWith('Watching')) return;

      // Try JSON first (in case ats cli adds json support later)
      try {
        const event = JSON.parse(trimmed);
        reconnectDelay = WATCH_RECONNECT_BASE_MS;
        handleEvent(event).catch(err => log('error', 'Event handler error', { error: err.message }));
        return;
      } catch {}

      // Parse human-readable: "[time] task.created" marks the event type
      // "Task #<ID>: <title>" gives us the task ID
      // Strip ANSI codes for clean matching
      const clean = trimmed.replace(/\x1b\[[0-9;]*m/g, '');

      const taskMatch = clean.match(/^Task #(\d+):/);
      if (taskMatch) {
        const taskId = taskMatch[1];
        reconnectDelay = WATCH_RECONNECT_BASE_MS;
        log('info', 'Watch detected task', { taskId, line: clean });
        handleEvent({ type: 'task.created', task_id: taskId })
          .catch(err => log('error', 'Event handler error', { error: err.message }));
        return;
      }

      log('debug', 'Watch line', { line: clean });
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) log('debug', 'Watch stderr', { text });
    });

    child.on('close', (code) => {
      if (!running) return;
      log('warn', 'Watch process exited', { code, reconnectMs: reconnectDelay });
      setTimeout(launchWatch, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, WATCH_RECONNECT_MAX_MS);
    });

    child.on('error', (err) => {
      log('error', 'Watch process error', { error: err.message });
    });

    // Kill watch on shutdown
    const killWatch = () => child.kill('SIGTERM');
    process.on('SIGTERM', killWatch);
    process.on('SIGINT', killWatch);
  }

  launchWatch();
}

// === Shutdown ===
function shutdown(signal) {
  log('info', 'Shutdown requested', { signal });
  running = false;
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// === Main ===
async function main() {
  log('info', 'Ada Dispatch v2.0.0 starting', {
    channel: CHANNEL,
    leaseMs: LEASE_MS,
    nanobotTimeoutMs: NANOBOT_TIMEOUT_MS,
    maxTaskRetries: MAX_TASK_RETRIES,
    atsBin: ATS_BIN,
    nanobotBin: NANOBOT_BIN,
    mode: 'websocket',
  });

  preflight();

  // Drain any pending tasks from before we started watching
  log('info', 'Draining pending tasks');
  try {
    const pending = listPending();
    if (pending.length > 0) {
      log('info', 'Found pending tasks to drain', { count: pending.length });
      for (const task of pending) {
        if (!running) break;
        await processTask(task);
      }
    } else {
      log('info', 'No pending tasks to drain');
    }
  } catch (err) {
    log('error', 'Error draining pending tasks', { error: err.message });
  }

  // Start WebSocket watcher — events drive task processing from here
  startWatch();
  log('info', 'WebSocket watcher started, listening for tasks');
}

main().catch((err) => {
  log('error', 'Fatal error', { error: err.message });
  process.exit(1);
});
