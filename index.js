#!/usr/bin/env node

import { execSync, execFileSync, execFile, spawn } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import crypto from 'node:crypto';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
const { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } = naclUtil;

const __dirname = dirname(fileURLToPath(import.meta.url));

// === Config ===
const ATS_BIN = '/ml2/nanobot/.nvm/versions/node/v24.13.0/bin/ats';
const NANOBOT_BIN = '/ml2/nanobot/.nvm/versions/node/v24.13.0/bin/claude';
const CHANNEL = 'ada-dispatch';
const TELEGRAM_CHAT_ID = '6644666619';
const LEASE_MS = 14400000;          // 4 hours
const NANOBOT_TIMEOUT_MS = 14400000; // 4 hours (matches lease)
const MAX_TASK_RETRIES = 3;
const ACTOR_FLAGS = ['--actor-type', 'agent', '--actor-id', 'ada-dispatch', '--actor-name', 'Ada Dispatch'];
const INTERNAL_PAYLOAD_FIELDS = ['callback_url', 'quiet', 'encrypted', 'sender', 'ciphertext', 'nonce', 'pubkey', 'from'];
const DISPATCH_KEYS_PATH = join(__dirname, 'dispatch-keys.json');
const TRUSTED_KEYS_PATH = join(__dirname, 'trusted-keys.json');
const PENDING_REGISTRATIONS_PATH = join(__dirname, 'pending-registrations.json');
const CONFIG_PATH = join(__dirname, 'config.json');

// Watch reconnection
const WATCH_RECONNECT_BASE_MS = 2000;
const WATCH_RECONNECT_MAX_MS = 60000;

// Track retry counts per task ID to detect poison tasks
const taskRetries = new Map();
// Track tasks currently being processed to avoid duplicates
const processingTasks = new Set();

// === GPU semaphore ===
// Only GPU-heavy tasks (music generation, TTS, etc.) are serialized.
// Non-GPU tasks run concurrently without waiting.
const GPU_CONCURRENCY = parseInt(process.env.GPU_CONCURRENCY, 10) || 1;
const gpuQueue = [];       // FIFO queue of { resolve } waiting for a GPU slot
let gpuSlotsUsed = 0;      // how many GPU slots are currently held

function gpuAcquire() {
  if (gpuSlotsUsed < GPU_CONCURRENCY) {
    gpuSlotsUsed++;
    return Promise.resolve();
  }
  return new Promise((resolve) => gpuQueue.push({ resolve }));
}

function gpuRelease() {
  if (gpuQueue.length > 0) {
    const next = gpuQueue.shift();
    next.resolve();
    // slot count stays the same — transferred to next waiter
  } else {
    gpuSlotsUsed = Math.max(0, gpuSlotsUsed - 1);
  }
}

function isGpuTask(task) {
  // Explicit payload override: { gpu: false } skips GPU queue
  if (task.payload && task.payload.gpu === false) return false;
  if (task.payload && task.payload.gpu === true) return true;
  // Keyword heuristic fallback (narrow keywords only — avoids false positives)
  const text = ((task.title || '') + ' ' + (task.description || '') + ' ' + JSON.stringify(task.payload || {})).toLowerCase();
  const gpuKeywords = ['ace-step', 'acestep', 'cover mode', 'qwen tts', 'qwen3-tts'];
  return gpuKeywords.some(kw => text.includes(kw));
}

let running = true;

// === Config management ===
function loadConfig() {
  const defaults = { require_encryption: false };
  if (!existsSync(CONFIG_PATH)) return defaults;
  try {
    return { ...defaults, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) };
  } catch { return defaults; }
}

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

// === Key management ===
function loadDispatchKeys() {
  if (!existsSync(DISPATCH_KEYS_PATH)) return null;
  return JSON.parse(readFileSync(DISPATCH_KEYS_PATH, 'utf-8'));
}

function ensureDispatchKeys() {
  let keys = loadDispatchKeys();
  if (!keys) {
    keys = generateKeypair();
    log('info', 'Generated dispatch keypair on first run', { publicKey: keys.publicKey });
  }
  return keys;
}

function loadTrustedKeys() {
  if (!existsSync(TRUSTED_KEYS_PATH)) return {};
  return JSON.parse(readFileSync(TRUSTED_KEYS_PATH, 'utf-8'));
}

function saveTrustedKeys(trusted) {
  writeFileSync(TRUSTED_KEYS_PATH, JSON.stringify(trusted, null, 2) + '\n');
}

function loadPendingRegistrations() {
  if (!existsSync(PENDING_REGISTRATIONS_PATH)) return {};
  return JSON.parse(readFileSync(PENDING_REGISTRATIONS_PATH, 'utf-8'));
}

function savePendingRegistrations(pending) {
  writeFileSync(PENDING_REGISTRATIONS_PATH, JSON.stringify(pending, null, 2) + '\n');
}

function generateKeypair() {
  const kp = nacl.box.keyPair();
  const keys = {
    publicKey: encodeBase64(kp.publicKey),
    secretKey: encodeBase64(kp.secretKey),
  };
  writeFileSync(DISPATCH_KEYS_PATH, JSON.stringify(keys, null, 2) + '\n');
  return keys;
}

function fingerprint(publicKeyBase64) {
  const hash = crypto.createHash('sha256').update(publicKeyBase64).digest('hex');
  return hash.slice(0, 16);
}

function addTrustedKey(name, publicKey) {
  const decoded = decodeBase64(publicKey);
  if (decoded.length !== nacl.box.publicKeyLength) {
    throw new Error(`Invalid public key length: expected ${nacl.box.publicKeyLength} bytes, got ${decoded.length}`);
  }
  const trusted = loadTrustedKeys();
  trusted[name] = {
    publicKey,
    fingerprint: fingerprint(publicKey),
    addedAt: new Date().toISOString(),
  };
  saveTrustedKeys(trusted);
  return trusted;
}

function findTrustedKeyByPubkey(publicKey) {
  const trusted = loadTrustedKeys();
  for (const [name, info] of Object.entries(trusted)) {
    if (info.publicKey === publicKey) return { name, ...info };
  }
  return null;
}

function findTrustedKeyByFingerprint(fp) {
  const trusted = loadTrustedKeys();
  for (const [name, info] of Object.entries(trusted)) {
    if (info.fingerprint === fp || fingerprint(info.publicKey) === fp) return { name, ...info };
  }
  return null;
}

// === Encryption helpers ===
function encryptForRecipient(plaintext, recipientPublicKeyBase64, senderSecretKeyBase64) {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const messageBytes = decodeUTF8(plaintext);
  const recipientPubKey = decodeBase64(recipientPublicKeyBase64);
  const senderSecKey = decodeBase64(senderSecretKeyBase64);
  const ciphertext = nacl.box(messageBytes, nonce, recipientPubKey, senderSecKey);
  return {
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(ciphertext),
  };
}

function decryptFromSender(ciphertextBase64, nonceBase64, senderPublicKeyBase64, recipientSecretKeyBase64) {
  const ciphertext = decodeBase64(ciphertextBase64);
  const nonce = decodeBase64(nonceBase64);
  const senderPubKey = decodeBase64(senderPublicKeyBase64);
  const recipientSecKey = decodeBase64(recipientSecretKeyBase64);
  const plaintext = nacl.box.open(ciphertext, nonce, senderPubKey, recipientSecKey);
  if (!plaintext) return null;
  return encodeUTF8(plaintext);
}

// === Registration flow ===
function isRegistrationRequest(task) {
  const title = (task.title || '').toLowerCase().trim();
  return title === 'register' && task.payload?.pubkey;
}

function handleRegistration(task) {
  const taskId = task.id || task.uuid;
  const pubkey = task.payload.pubkey;
  const fp = fingerprint(pubkey);

  log('info', 'Registration request received', { taskId, fingerprint: fp });

  // Validate key format
  try {
    const decoded = decodeBase64(pubkey);
    if (decoded.length !== nacl.box.publicKeyLength) {
      throw new Error(`Invalid key length: ${decoded.length}`);
    }
  } catch (err) {
    log('warn', 'Registration rejected: invalid key', { taskId, error: err.message });
    try {
      claimTask(taskId);
      failTask(taskId, `Invalid public key: ${err.message}`);
    } catch {}
    telegram(`🔑 Registration REJECTED — invalid key format.\nFingerprint: <code>${fp}</code>\nError: ${err.message}`);
    return;
  }

  // Check if already trusted
  const existing = findTrustedKeyByPubkey(pubkey);
  if (existing) {
    log('info', 'Registration request for already-trusted key', { taskId, name: existing.name });
    try {
      claimTask(taskId);
      const dispatchKeys = ensureDispatchKeys();
      completeTask(taskId, {
        status: 'already_registered',
        name: existing.name,
        ada_public_key: dispatchKeys.publicKey,
        message: `Key already registered as "${existing.name}".`,
      });
    } catch {}
    return;
  }

  // Store pending registration
  const pending = loadPendingRegistrations();
  pending[fp] = {
    pubkey,
    requestedAt: new Date().toISOString(),
    taskId,
  };
  savePendingRegistrations(pending);

  // Claim and hold the task
  try { claimTask(taskId); } catch {}

  // Notify admin
  telegram(
    `🔑 <b>New registration request</b>\n` +
    `Fingerprint: <code>${fp}</code>\n` +
    `Public key: <code>${pubkey.slice(0, 24)}...</code>\n` +
    `Task ID: ${taskId}\n\n` +
    `To approve, run on gateway:\n<code>node /home/openclaw/projects/ada-dispatch/index.js approve ${fp} &lt;name&gt;</code>`
  );

  log('info', 'Registration pending admin approval', { taskId, fingerprint: fp });

  // Complete the task with pending status so it doesn't block
  try {
    completeTask(taskId, {
      status: 'pending_approval',
      fingerprint: fp,
      message: 'Registration request submitted. Admin has been notified. You will be approved shortly.',
    });
  } catch {}
}

function approveRegistration(fp, name) {
  const pending = loadPendingRegistrations();
  const reg = pending[fp];
  if (!reg) {
    // Check if fingerprint matches a partial match
    const match = Object.entries(pending).find(([k]) => k.startsWith(fp));
    if (!match) {
      console.error(`No pending registration found for fingerprint: ${fp}`);
      process.exit(1);
    }
    return approveRegistration(match[0], name);
  }

  // Add to trusted keys
  addTrustedKey(name, reg.pubkey);

  // Remove from pending
  delete pending[fp];
  savePendingRegistrations(pending);

  const dispatchKeys = ensureDispatchKeys();

  console.log(`Approved registration for "${name}".`);
  console.log(`Fingerprint: ${fp}`);
  console.log(`Public key: ${reg.pubkey}`);
  console.log(`Ada's public key: ${dispatchKeys.publicKey}`);

  // Notify via Telegram
  telegram(
    `✅ <b>Registration approved</b>\n` +
    `Name: ${name}\n` +
    `Fingerprint: <code>${fp}</code>\n` +
    `Ada's public key: <code>${dispatchKeys.publicKey}</code>`
  );

  log('info', 'Registration approved', { name, fingerprint: fp });
}

function rejectRegistration(fp, reason) {
  const pending = loadPendingRegistrations();
  const reg = pending[fp];
  if (!reg) {
    const match = Object.entries(pending).find(([k]) => k.startsWith(fp));
    if (!match) {
      console.error(`No pending registration found for fingerprint: ${fp}`);
      process.exit(1);
    }
    return rejectRegistration(match[0], reason);
  }

  delete pending[fp];
  savePendingRegistrations(pending);

  console.log(`Rejected registration for fingerprint: ${fp}`);

  telegram(
    `❌ <b>Registration rejected</b>\n` +
    `Fingerprint: <code>${fp}</code>\n` +
    `Reason: ${reason || 'Not approved by admin'}`
  );

  log('info', 'Registration rejected', { fingerprint: fp, reason });
}

// === Encrypted task decryption ===
function decryptTask(task) {
  const payload = task.payload;
  if (!payload?.encrypted) return { task, sender: null };

  // Support both "sender" (name lookup) and "from" (pubkey lookup)
  const senderName = payload.sender;
  const senderPubkey = payload.from;

  let senderPublicKey;
  let resolvedSender;

  if (senderName) {
    const trusted = loadTrustedKeys();
    if (!trusted[senderName]) {
      throw new Error(`Sender "${senderName}" not in trusted-keys.json`);
    }
    senderPublicKey = trusted[senderName].publicKey;
    resolvedSender = senderName;
  } else if (senderPubkey) {
    const found = findTrustedKeyByPubkey(senderPubkey);
    if (!found) {
      throw new Error(`Public key not in trusted-keys.json (fingerprint: ${fingerprint(senderPubkey)})`);
    }
    senderPublicKey = found.publicKey;
    resolvedSender = found.name;
  } else {
    throw new Error('Encrypted task missing sender/from field');
  }

  const dispatchKeys = loadDispatchKeys();
  if (!dispatchKeys) {
    throw new Error('No dispatch keypair found — run: node index.js keygen');
  }

  const plaintext = decryptFromSender(
    payload.ciphertext, payload.nonce,
    senderPublicKey, dispatchKeys.secretKey
  );
  if (!plaintext) {
    throw new Error(`Decryption failed for sender "${resolvedSender}" — wrong key or tampered data`);
  }

  const decrypted = JSON.parse(plaintext);

  log('info', 'AUTH: Decryption successful', {
    sender: resolvedSender,
    fingerprint: fingerprint(senderPublicKey),
    taskId: task.id || task.uuid,
  });

  // Merge decrypted fields back into the task
  const mergedTask = {
    ...task,
    title: decrypted.title || task.title,
    description: decrypted.description || task.description,
    payload: { ...decrypted.payload, callback_url: payload.callback_url, quiet: payload.quiet },
    _sender: resolvedSender,
    _senderPublicKey: senderPublicKey,
  };
  return { task: mergedTask, sender: resolvedSender, senderPublicKey };
}

// === Encrypt response for sender ===
function encryptResponse(responseText, senderPublicKey) {
  const dispatchKeys = loadDispatchKeys();
  if (!dispatchKeys || !senderPublicKey) return null;
  try {
    return encryptForRecipient(responseText, senderPublicKey, dispatchKeys.secretKey);
  } catch (err) {
    log('warn', 'Failed to encrypt response', { error: err.message });
    return null;
  }
}

// === Authentication check ===
function authenticateTask(task) {
  const config = loadConfig();
  const payload = task.payload || {};
  const taskId = task.id || task.uuid;

  // Encrypted tasks are authenticated by the decryption process
  if (payload.encrypted) {
    return { authenticated: true, encrypted: true };
  }

  // Registration requests bypass auth
  if (isRegistrationRequest(task)) {
    return { authenticated: true, registration: true };
  }

  // Plaintext task
  if (config.require_encryption) {
    log('warn', 'AUTH: Plaintext task REJECTED (require_encryption=true)', {
      taskId, title: task.title,
    });
    telegram(
      `🚫 <b>Task rejected</b> — encryption required\n` +
      `Task: ${task.title || taskId}\n` +
      `Encryption is now mandatory. Use encrypt-task.js to submit encrypted tasks.`
    );
    return { authenticated: false, reason: 'Encryption required. Plaintext tasks are no longer accepted.' };
  }

  // Grace period: allow but warn
  log('warn', 'AUTH: Plaintext task accepted (grace period)', {
    taskId, title: task.title,
  });
  return { authenticated: true, encrypted: false, warning: 'plaintext_grace_period' };
}

// === CLI subcommands ===
function handleCLI(args) {
  const cmd = args[0];

  if (cmd === 'keygen') {
    const keys = generateKeypair();
    console.log('Generated new dispatch keypair.');
    console.log(`Public key: ${keys.publicKey}`);
    console.log(`Fingerprint: ${fingerprint(keys.publicKey)}`);
    console.log(`Saved to: ${DISPATCH_KEYS_PATH}`);
    console.log('\nShare your public key with task submitters so they can encrypt tasks for you.');
    process.exit(0);
  }

  if (cmd === 'add-key') {
    const name = args[1];
    const pubkey = args[2];
    if (!name || !pubkey) {
      console.error('Usage: node index.js add-key <name> <public-key-base64>');
      process.exit(1);
    }
    try {
      addTrustedKey(name, pubkey);
      console.log(`Added trusted key for "${name}".`);
      console.log(`Fingerprint: ${fingerprint(pubkey)}`);
      console.log(`Saved to: ${TRUSTED_KEYS_PATH}`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (cmd === 'remove-key') {
    const name = args[1];
    if (!name) {
      console.error('Usage: node index.js remove-key <name>');
      process.exit(1);
    }
    const trusted = loadTrustedKeys();
    if (!trusted[name]) {
      console.error(`No trusted key found for "${name}".`);
      process.exit(1);
    }
    delete trusted[name];
    saveTrustedKeys(trusted);
    console.log(`Removed trusted key for "${name}".`);
    process.exit(0);
  }

  if (cmd === 'list-keys') {
    const trusted = loadTrustedKeys();
    const entries = Object.entries(trusted);
    if (entries.length === 0) {
      console.log('No trusted keys registered.');
    } else {
      console.log('Trusted entities:');
      for (const [name, info] of entries) {
        const fp = info.fingerprint || fingerprint(info.publicKey);
        console.log(`  ${name}: ${info.publicKey} (fp: ${fp}, added ${info.addedAt})`);
      }
    }
    const dispatch = loadDispatchKeys();
    if (dispatch) {
      console.log(`\nDispatch public key: ${dispatch.publicKey}`);
      console.log(`Dispatch fingerprint: ${fingerprint(dispatch.publicKey)}`);
    } else {
      console.log('\nNo dispatch keypair found. Run: node index.js keygen');
    }

    const pending = loadPendingRegistrations();
    const pendingEntries = Object.entries(pending);
    if (pendingEntries.length > 0) {
      console.log('\nPending registrations:');
      for (const [fp, info] of pendingEntries) {
        console.log(`  ${fp}: requested ${info.requestedAt} (task ${info.taskId})`);
      }
    }
    process.exit(0);
  }

  if (cmd === 'approve') {
    const fp = args[1];
    const name = args[2];
    if (!fp || !name) {
      console.error('Usage: node index.js approve <fingerprint> <name>');
      process.exit(1);
    }
    approveRegistration(fp, name);
    process.exit(0);
  }

  if (cmd === 'reject') {
    const fp = args[1];
    const reason = args.slice(2).join(' ') || 'Not approved';
    if (!fp) {
      console.error('Usage: node index.js reject <fingerprint> [reason]');
      process.exit(1);
    }
    rejectRegistration(fp, reason);
    process.exit(0);
  }

  if (cmd === 'pending') {
    const pending = loadPendingRegistrations();
    const entries = Object.entries(pending);
    if (entries.length === 0) {
      console.log('No pending registrations.');
    } else {
      console.log('Pending registrations:');
      for (const [fp, info] of entries) {
        console.log(`  Fingerprint: ${fp}`);
        console.log(`  Public key:  ${info.pubkey}`);
        console.log(`  Requested:   ${info.requestedAt}`);
        console.log(`  Task ID:     ${info.taskId}`);
        console.log('');
      }
    }
    process.exit(0);
  }

  if (cmd === 'config') {
    const key = args[1];
    const value = args[2];
    if (!key) {
      const config = loadConfig();
      console.log(JSON.stringify(config, null, 2));
      process.exit(0);
    }
    const config = loadConfig();
    if (value === 'true') config[key] = true;
    else if (value === 'false') config[key] = false;
    else config[key] = value;
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
    console.log(`Set ${key} = ${JSON.stringify(config[key])}`);
    process.exit(0);
  }

  // Not a CLI command — continue to main()
  return false;
}

// === Preflight ===
function preflight() {
  for (const check of [{ name: 'ats', bin: ATS_BIN }, { name: 'claude', bin: NANOBOT_BIN }]) {
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

  // Ensure dispatch keypair exists
  ensureDispatchKeys();
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
  const child = spawn(
    NANOBOT_BIN,
    ['-p', '--dangerously-skip-permissions'],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );

  // Feed prompt via stdin (avoids arg-length and multi-line issues)
  child.stdin.write(prompt);
  child.stdin.end();

  // Track whether the process has already exited to prevent timeout race
  let processExited = false;
  let killedByTimeout = false;

  // Timeout guard — only kill if the process hasn't already exited
  const timer = setTimeout(() => {
    if (!processExited) {
      killedByTimeout = true;
      child.kill('SIGTERM');
    }
  }, NANOBOT_TIMEOUT_MS);

  const promise = new Promise((resolve, reject) => {
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', () => {}); // drain stderr
    child.on('close', (code, signal) => {
      processExited = true;
      clearTimeout(timer);
      // If the process exited with code 0, always resolve — even if a
      // SIGTERM was sent (the process finished before the signal landed)
      if (code === 0) {
        resolve(stdout);
      } else if (killedByTimeout) {
        reject(new Error('Nanobot timed out (killed after timeout)'));
      } else if (signal === 'SIGTERM' || code === 143) {
        reject(new Error('Nanobot cancelled'));
      } else {
        reject(new Error(`Nanobot exited with code ${code}`));
      }
    });
    child.on('error', (err) => {
      processExited = true;
      clearTimeout(timer);
      reject(new Error(err.message || 'Nanobot execution failed'));
    });
  });

  return { promise, child };
}

// === Task dispatch ===
// GPU tasks go through the semaphore; non-GPU tasks run immediately (concurrent).
function dispatchTask(task) {
  const taskId = task.id || task.uuid;

  // Prevent duplicate dispatch
  if (processingTasks.has(taskId)) {
    log('debug', 'Task already processing, skipping', { taskId });
    return;
  }

  // Handle registration requests immediately (no GPU needed)
  if (isRegistrationRequest(task)) {
    log('info', 'AUTH: Registration request detected, handling immediately', { taskId });
    handleRegistration(task);
    return;
  }

  // Authentication check (reject early)
  const auth = authenticateTask(task);
  if (!auth.authenticated) {
    log('warn', 'AUTH: Task rejected', { taskId, reason: auth.reason });
    try {
      claimTask(taskId);
      failTask(taskId, auth.reason);
    } catch {}
    return;
  }

  if (auth.warning === 'plaintext_grace_period') {
    log('warn', 'AUTH: Plaintext task in grace period', { taskId, title: task.title });
  }

  // Poison task guard
  const retryCount = taskRetries.get(taskId) || 0;
  if (retryCount >= MAX_TASK_RETRIES) {
    log('error', 'Task exceeded max retries, skipping', { taskId, retryCount, title: task.title });
    try { failTask(taskId, `Exceeded max retry attempts (${MAX_TASK_RETRIES})`); } catch {}
    notifyCallback(task, 'failed', `Exceeded max retry attempts (${MAX_TASK_RETRIES})`);
    if (shouldNotify(task)) telegram(`❌ Failed: ${task.title} — exceeded max retries`);
    return;
  }

  const gpu = isGpuTask(task);

  if (gpu) {
    log('info', 'GPU task detected, waiting for GPU slot', { taskId, title: task.title, gpuPending: gpuQueue.length });
    gpuAcquire().then(() => {
      if (!running) {
        gpuRelease();
        return;
      }
      log('info', 'GPU slot acquired', { taskId, title: task.title, gpuPending: gpuQueue.length });
      processTask(task, true);
    });
  } else {
    log('info', 'Non-GPU task, running immediately', { taskId, title: task.title });
    processTask(task, false);
  }
}

// === Task processing ===
function processTask(task, gpuHeld) {
  const taskId = task.id || task.uuid;

  taskRetries.set(taskId, (taskRetries.get(taskId) || 0) + 1);
  processingTasks.add(taskId);

  log('info', 'Processing task', { taskId, title: task.title, attempt: taskRetries.get(taskId), encrypted: !!task.payload?.encrypted, gpu: gpuHeld });

  // Track sender info for encrypted response
  let senderName = null;
  let senderPublicKey = null;

  // Decrypt if encrypted
  if (task.payload?.encrypted) {
    try {
      const result = decryptTask(task);
      task = result.task;
      senderName = result.sender;
      senderPublicKey = result.senderPublicKey;
      log('info', 'AUTH: Decrypted encrypted task', { taskId, sender: senderName });
    } catch (err) {
      log('error', 'AUTH: Task decryption failed', { taskId, error: err.message });
      try { failTask(taskId, `Decryption failed: ${err.message}`); } catch {}
      notifyCallback(task, 'failed', `Decryption failed: ${err.message}`);
      if (shouldNotify(task)) telegram(`🔒 Rejected encrypted task: ${task.title || taskId} — ${err.message}`);
      processingTasks.delete(taskId);
      if (gpuHeld) gpuRelease();
      return;
    }
  }

  // Claim — gracefully handle already-terminal tasks
  try {
    claimTask(taskId);
    log('info', 'Claimed task', { taskId });
    postMessage(taskId, 'Agent processing started');
    if (shouldNotify(task)) telegram(`🎯 Ada picked up: ${task.title} (ID: ${taskId})`);
  } catch (err) {
    const errMsg = (err.stderr || err.message || '').toLowerCase();
    if (errMsg.includes('failed status') || errMsg.includes('completed status') || errMsg.includes('cancelled status')) {
      log('warn', 'Task already in terminal state, skipping', { taskId, error: err.message });
    } else {
      log('error', 'Failed to claim task', { taskId, error: err.message });
    }
    processingTasks.delete(taskId);
    if (gpuHeld) gpuRelease();
    return;
  }

  // Build prompt and spawn nanobot in the background
  const prompt = buildPrompt(task);
  const sessionId = `ada-dispatch:${taskId}`;
  log('info', 'Invoking nanobot', { taskId, sessionId, promptLength: prompt.length, gpu: gpuHeld });

  // Lease renewal — re-claim to extend the lease, plus post a heartbeat message.
  const renewInterval = setInterval(() => {
    try {
      ats('claim', String(taskId), '--lease', String(LEASE_MS));
      postMessage(taskId, "Agent still processing (heartbeat — lease renewed)");
      log("info", "Heartbeat: lease renewed", { taskId, leaseMs: LEASE_MS });
    } catch (err) {
      const errMsg = (err.stderr || err.message || '').toLowerCase();
      const isAlreadyClaimed = errMsg.includes('in_progress') || errMsg.includes('already claimed') || errMsg.includes('already in');
      if (isAlreadyClaimed) {
        log("debug", "Heartbeat: re-claim not needed (already in_progress)", { taskId });
      } else {
        log("warn", "Heartbeat: lease renewal failed", { taskId, error: err.message });
      }
      try { postMessage(taskId, "Agent still processing (heartbeat)"); } catch {}
    }
  }, LEASE_MS / 4);

  // Spawn nanobot with shutdown-aware cancellation
  const { promise: nanobotResult, child: nanobotChild } = runNanobot(prompt, sessionId);
  let cancelledByShutdown = false;

  const onShutdown = () => {
    cancelledByShutdown = true;
    log('info', 'Killing nanobot due to shutdown', { taskId });
    nanobotChild.kill('SIGTERM');
  };
  process.on('SIGTERM', onShutdown);
  process.on('SIGINT', onShutdown);

  const cleanup = () => {
    clearInterval(renewInterval);
    process.removeListener('SIGTERM', onShutdown);
    process.removeListener('SIGINT', onShutdown);
    processingTasks.delete(taskId);
    if (gpuHeld) {
      gpuRelease();
      log('info', 'GPU slot released', { taskId, gpuPending: gpuQueue.length });
    }
  };

  nanobotResult.then((output) => {
    log('info', 'Nanobot completed', { taskId, outputLength: output.length });

    const responseText = output.trim();
    const outputs = { response: responseText };

    // Encrypt response if the task was encrypted
    if (senderPublicKey) {
      const encrypted = encryptResponse(responseText, senderPublicKey);
      if (encrypted) {
        outputs.encrypted_response = encrypted;
        outputs.response_encrypted = true;
        log('info', 'AUTH: Response encrypted for sender', { taskId, sender: senderName });
      }
    }

    completeTask(taskId, outputs);
    taskRetries.delete(taskId);
    log('info', 'Task completed', { taskId });
    notifyCallback(task, 'completed', responseText);
    if (shouldNotify(task)) {
      const snippet = responseText.slice(0, 200);
      telegram(`✅ Done: ${task.title} — ${snippet}`);
    }
    cleanup();
  }).catch((err) => {
    if (cancelledByShutdown) {
      log('info', 'Task interrupted by shutdown, will be retried', { taskId });
      taskRetries.delete(taskId);
    } else {
      log('error', 'Nanobot failed', { taskId, error: err.message });
      try {
        failTask(taskId, err.message);
        log('info', 'Task marked as failed', { taskId });
        notifyCallback(task, 'failed', err.message);
        if (shouldNotify(task)) telegram(`❌ Failed: ${task.title} — ${err.message.slice(0, 200)}`);
      } catch (failErr) {
        log('error', 'Failed to mark task as failed', { taskId, error: failErr.message });
      }
    }
    cleanup();
  });
}

// === Event handler ===
function handleEvent(event) {
  if (event.type !== 'task.created') return;

  const taskId = event.task_id || event.data?.id || event.data?.task_id;
  if (!taskId) {
    log('warn', 'task.created event missing task_id', { event });
    return;
  }

  log('info', 'Received task.created event', { taskId });

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

  if (task.status !== 'pending') {
    log('debug', 'Task not pending, skipping', { taskId, status: task.status });
    return;
  }

  dispatchTask(task);
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

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('Connecting') || trimmed.startsWith('✓') || trimmed.startsWith('Watching')) return;

      try {
        const event = JSON.parse(trimmed);
        reconnectDelay = WATCH_RECONNECT_BASE_MS;
        try { handleEvent(event); } catch (err) { log('error', 'Event handler error', { error: err.message }); }
        return;
      } catch {}

      const clean = trimmed.replace(/\x1b\[[0-9;]*m/g, '');
      const taskMatch = clean.match(/^Task #(\d+):/);
      if (taskMatch) {
        const taskId = taskMatch[1];
        reconnectDelay = WATCH_RECONNECT_BASE_MS;
        log('info', 'Watch detected task', { taskId, line: clean });
        try { handleEvent({ type: 'task.created', task_id: taskId }); } catch (err) { log('error', 'Event handler error', { error: err.message }); }
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
function main() {
  const config = loadConfig();
  log('info', 'ats-dispatch v3.2.0 starting', {
    channel: CHANNEL,
    leaseMs: LEASE_MS,
    nanobotTimeoutMs: NANOBOT_TIMEOUT_MS,
    maxTaskRetries: MAX_TASK_RETRIES,
    atsBin: ATS_BIN,
    nanobotBin: NANOBOT_BIN,
    mode: 'websocket',
    require_encryption: config.require_encryption,
    gpuConcurrency: GPU_CONCURRENCY,
  });

  preflight();

  const dispatchKeys = loadDispatchKeys();
  if (dispatchKeys) {
    log('info', 'Dispatch public key', { publicKey: dispatchKeys.publicKey, fingerprint: fingerprint(dispatchKeys.publicKey) });
  }

  const trusted = loadTrustedKeys();
  log('info', 'Trusted keys loaded', { count: Object.keys(trusted).length });

  // Drain pending tasks — GPU tasks go through semaphore, non-GPU run immediately
  log('info', 'Draining pending tasks');
  try {
    const pending = listPending();
    if (pending.length > 0) {
      log('info', 'Found pending tasks to drain', { count: pending.length });
      for (const task of pending) {
        if (!running) break;
        dispatchTask(task);
      }
    } else {
      log('info', 'No pending tasks to drain');
    }
  } catch (err) {
    log('error', 'Error draining pending tasks', { error: err.message });
  }

  startWatch();
  log('info', 'WebSocket watcher started, listening for tasks');
}

// Route CLI subcommands before starting the watcher
const cliArgs = process.argv.slice(2);
if (cliArgs.length > 0) handleCLI(cliArgs);

try {
  main();
} catch (err) {
  log('error', 'Fatal error', { error: err.message });
  process.exit(1);
}
