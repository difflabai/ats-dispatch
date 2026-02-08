#!/usr/bin/env node

import { execSync, execFileSync, execFile } from 'node:child_process';  // execSync only for preflight
import { setTimeout as sleep } from 'node:timers/promises';
import https from 'node:https';
import http from 'node:http';

// === Config ===
const ATS_BIN = '/usr/bin/ats';
const NANOBOT_BIN = '/home/openclaw/nanobot/.venv/bin/nanobot';
const CHANNEL = 'ada-dispatch';
const POLL_INTERVAL_MS = 5000;
const LEASE_MS = 600000;        // 10 minutes
const NANOBOT_TIMEOUT_MS = 300000; // 5 minutes
const MAX_BACKOFF_MS = 60000;   // 1 minute cap on retry backoff
const MAX_TASK_RETRIES = 3;     // max attempts before skipping a poison task
const ACTOR_FLAGS = ['--actor-type', 'agent', '--actor-id', 'ada-dispatch', '--actor-name', 'Ada Dispatch'];

// Track retry counts per task ID to detect poison tasks
const taskRetries = new Map();

// === Logging ===
function log(level, msg, data = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

// === Preflight ===
function preflight() {
  const checks = [
    { name: 'ats', bin: ATS_BIN },
    { name: 'nanobot', bin: NANOBOT_BIN },
  ];
  for (const check of checks) {
    try {
      const version = execSync(`'${check.bin}' --version`, {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
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
    const result = execFileSync(ATS_BIN, fullArgs, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result;
  } catch (err) {
    log('debug', 'ats command failed', { args: fullArgs, stderr: err.stderr, stdout: err.stdout });
    throw err;
  }
}

function atsJSON(...args) {
  const raw = ats(...args, '-f', 'json');
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    return JSON.parse(match[0]);
  } catch {
    return [];
  }
}

function listPending() {
  const tasks = atsJSON('list', '--channel', CHANNEL, '--status', 'pending');
  return Array.isArray(tasks) ? tasks : [];
}

function claimTask(taskId) {
  ats('claim', String(taskId), '--lease', String(LEASE_MS));
}

function renewLease(taskId) {
  ats('claim', String(taskId), '--lease', String(LEASE_MS));
}

function completeTask(taskId, outputs) {
  ats('complete', String(taskId), '--outputs', JSON.stringify(outputs));
}

function failTask(taskId, reason) {
  ats('fail', String(taskId), '--reason', reason);
}

function postMessage(taskId, message) {
  try {
    ats('message', 'add', String(taskId), message);
  } catch (err) {
    log('warn', 'Failed to post ATS message', { taskId, error: err.message });
  }
}

// === Callback notification ===
async function notifyCallback(task, status, result) {
  const callbackUrl = task.payload?.callback_url;
  if (!callbackUrl) return;

  const taskId = task.id || task.uuid;
  const body = JSON.stringify({
    task_id: taskId,
    status,
    result,
    completed_at: new Date().toISOString(),
  });

  try {
    const url = new URL(callbackUrl);
    const transport = url.protocol === 'https:' ? https : http;
    await new Promise((resolve, reject) => {
      const req = transport.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 10000,
      }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    log('info', 'Callback notified', { taskId, callbackUrl, status });
  } catch (err) {
    log('warn', 'Callback notification failed', { taskId, callbackUrl, error: err.message });
  }
}

// === Nanobot execution ===
// Internal payload fields that should not be forwarded to the agent
const INTERNAL_PAYLOAD_FIELDS = ['callback_url'];

function buildPrompt(task) {
  const parts = [];

  parts.push('You are Ada, processing a task from the ada-dispatch channel. Execute the task described below.');

  if (task.title) {
    parts.push(`<task-title>\n${task.title}\n</task-title>`);
  }
  if (task.description) {
    parts.push(`<task-description>\n${task.description}\n</task-description>`);
  }
  if (task.payload) {
    const safePayload = { ...task.payload };
    for (const field of INTERNAL_PAYLOAD_FIELDS) delete safePayload[field];
    if (Object.keys(safePayload).length > 0) {
      parts.push(`<task-context>\n${JSON.stringify(safePayload, null, 2)}\n</task-context>`);
    }
  }

  return parts.join('\n\n');
}

function runNanobot(prompt, sessionId) {
  let child;
  const promise = new Promise((resolve, reject) => {
    child = execFile(
      NANOBOT_BIN,
      ['agent', '-m', prompt, '-s', sessionId],
      { timeout: NANOBOT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(error.killed ? 'Nanobot cancelled or timed out' : (error.message || 'Nanobot execution failed')));
        } else {
          resolve(stdout);
        }
      }
    );
  });
  return { promise, child };
}

// === Task processing ===
async function processTask(task) {
  const taskId = task.id || task.uuid;

  // Poison task guard: skip tasks that have failed too many times
  const retryCount = taskRetries.get(taskId) || 0;
  if (retryCount >= MAX_TASK_RETRIES) {
    log('error', 'Task exceeded max retries, skipping', { taskId, retryCount, title: task.title });
    try {
      failTask(taskId, `Exceeded max retry attempts (${MAX_TASK_RETRIES})`);
    } catch { /* already logged or task already in terminal state */ }
    await notifyCallback(task, 'failed', `Exceeded max retry attempts (${MAX_TASK_RETRIES})`);
    return;
  }
  taskRetries.set(taskId, retryCount + 1);

  log('info', 'Processing task', { taskId, title: task.title, attempt: retryCount + 1 });

  // Claim the task
  try {
    claimTask(taskId);
    log('info', 'Claimed task', { taskId });
    postMessage(taskId, 'Agent processing started');
  } catch (err) {
    log('error', 'Failed to claim task', { taskId, error: err.message });
    return;
  }

  // Build prompt and run nanobot
  const prompt = buildPrompt(task);
  const sessionId = `ada-dispatch:${taskId}`;
  log('info', 'Invoking nanobot', { taskId, sessionId, promptLength: prompt.length });

  // Renew lease periodically while nanobot is running
  const renewInterval = setInterval(() => {
    try {
      renewLease(taskId);
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

    // Complete the ATS task with output
    completeTask(taskId, { response: output.trim() });
    taskRetries.delete(taskId);
    log('info', 'Task completed', { taskId });
    await notifyCallback(task, 'completed', output.trim());
  } catch (err) {
    if (cancelledByShutdown) {
      // Don't count shutdown as a task failure — task will be retried after lease expires
      log('info', 'Task interrupted by shutdown, will be retried', { taskId });
      taskRetries.delete(taskId);
    } else {
      log('error', 'Nanobot failed', { taskId, error: err.message });
      try {
        failTask(taskId, err.message);
        log('info', 'Task marked as failed', { taskId });
        await notifyCallback(task, 'failed', err.message);
      } catch (failErr) {
        log('error', 'Failed to mark task as failed', { taskId, error: failErr.message });
      }
    }
  } finally {
    clearInterval(renewInterval);
    process.removeListener('SIGTERM', onShutdown);
    process.removeListener('SIGINT', onShutdown);
  }
}

// === Main loop ===
let running = true;

function shutdown(signal) {
  log('info', 'Shutdown requested', { signal });
  running = false;
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function main() {
  log('info', 'Ada Dispatch starting', {
    channel: CHANNEL,
    pollIntervalMs: POLL_INTERVAL_MS,
    leaseMs: LEASE_MS,
    nanobotTimeoutMs: NANOBOT_TIMEOUT_MS,
    maxBackoffMs: MAX_BACKOFF_MS,
    maxTaskRetries: MAX_TASK_RETRIES,
    atsBin: ATS_BIN,
    nanobotBin: NANOBOT_BIN,
  });

  // Validate environment before entering service loop
  preflight();

  // Drain any pending tasks on startup
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

  // Poll loop with exponential backoff on failures
  log('info', 'Entering poll loop');
  let consecutiveFailures = 0;

  while (running) {
    const delay = consecutiveFailures > 0
      ? Math.min(POLL_INTERVAL_MS * Math.pow(2, consecutiveFailures), MAX_BACKOFF_MS)
      : POLL_INTERVAL_MS;

    await sleep(delay);
    if (!running) break;

    try {
      const tasks = listPending();
      if (consecutiveFailures > 0) {
        log('info', 'Poll recovered', { afterFailures: consecutiveFailures });
      }
      consecutiveFailures = 0;

      if (tasks.length > 0) {
        log('info', 'Found pending tasks', { count: tasks.length });
        for (const task of tasks) {
          if (!running) break;
          await processTask(task);
        }
      }
    } catch (err) {
      consecutiveFailures++;
      const nextRetryMs = Math.min(POLL_INTERVAL_MS * Math.pow(2, consecutiveFailures), MAX_BACKOFF_MS);
      log('warn', 'Poll error', { error: err.message, consecutiveFailures, nextRetryMs });
    }
  }

  log('info', 'Ada Dispatch stopped');
}

main().catch((err) => {
  log('error', 'Fatal error', { error: err.message });
  process.exit(1);
});
