#!/usr/bin/env node

/**
 * encrypt-task.js — Encrypt and submit tasks to ada-dispatch, or register your key.
 *
 * Usage:
 *   # Generate your keypair
 *   node encrypt-task.js --keygen
 *
 *   # Register your key with Ada
 *   node encrypt-task.js --register --sender myname
 *
 *   # Submit an encrypted task
 *   node encrypt-task.js --title "Do something" --description "Details here" \
 *     --ada-key <ada-public-key-base64> --sender myname
 *
 *   # Decrypt a response from Ada
 *   node encrypt-task.js --decrypt --task-id 123 --ada-key <ada-public-key-base64>
 */

import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
const { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } = naclUtil;
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

function usage() {
  console.log(`Usage: node encrypt-task.js [options]

Commands:
  --keygen               Generate a new keypair and exit
  --register             Register your public key with Ada
  --decrypt              Decrypt an encrypted response from Ada
  (default)              Encrypt and submit a task

Encrypt & submit options:
  --title <text>         Task title (required)
  --ada-key <base64>     Ada's public key (from registration approval or: node index.js list-keys)
  --sender <name>        Your entity name (must be registered in Ada's trusted-keys.json)
  --description <text>   Task description
  --payload <json>       Additional JSON payload fields
  --my-key <path>        Path to your keypair file (default: my-keys.json)
  --channel <name>       ATS channel (default: ada-dispatch)
  --dry-run              Print encrypted payload JSON without submitting

Register options:
  --sender <name>        Your name (optional, for display)
  --my-key <path>        Path to your keypair file (default: my-keys.json)
  --channel <name>       ATS channel (default: ada-dispatch)

Decrypt options:
  --task-id <id>         ATS task ID to fetch and decrypt
  --ada-key <base64>     Ada's public key
  --my-key <path>        Path to your keypair file (default: my-keys.json)`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--keygen') { args.keygen = true; continue; }
    if (arg === '--dry-run') { args.dryRun = true; continue; }
    if (arg === '--register') { args.register = true; continue; }
    if (arg === '--decrypt') { args.decrypt = true; continue; }
    if (arg.startsWith('--') && i + 1 < argv.length) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      args[key] = argv[++i];
    }
  }
  return args;
}

function loadOrCreateKeypair(path) {
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf-8'));
  }
  const kp = nacl.box.keyPair();
  const keys = {
    publicKey: encodeBase64(kp.publicKey),
    secretKey: encodeBase64(kp.secretKey),
  };
  writeFileSync(path, JSON.stringify(keys, null, 2) + '\n');
  console.log(`Generated new keypair -> ${path}`);
  console.log(`Your public key: ${keys.publicKey}`);
  return keys;
}

function encrypt(plaintext, recipientPublicKey, senderSecretKey) {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const messageBytes = decodeUTF8(plaintext);
  const ciphertext = nacl.box(messageBytes, nonce, recipientPublicKey, senderSecretKey);
  return {
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(ciphertext),
  };
}

function decryptMessage(ciphertextB64, nonceB64, senderPublicKey, recipientSecretKey) {
  const ciphertext = decodeBase64(ciphertextB64);
  const nonce = decodeBase64(nonceB64);
  const plaintext = nacl.box.open(ciphertext, nonce, senderPublicKey, recipientSecretKey);
  if (!plaintext) return null;
  return encodeUTF8(plaintext);
}

const args = parseArgs(process.argv.slice(2));
const keyPath = args.myKey || 'my-keys.json';

// === Keygen mode ===
if (args.keygen) {
  const keys = loadOrCreateKeypair(keyPath);
  console.log(`\nYour public key: ${keys.publicKey}`);
  console.log('\nTo register with Ada:');
  console.log(`  node encrypt-task.js --register`);
  process.exit(0);
}

// === Register mode ===
if (args.register) {
  const myKeys = loadOrCreateKeypair(keyPath);
  const channel = args.channel || 'ada-dispatch';

  const payload = { pubkey: myKeys.publicKey };

  console.log(`Registering public key with ada-dispatch...`);
  console.log(`Public key: ${myKeys.publicKey}`);

  try {
    const result = execFileSync('/usr/bin/ats', [
      'create', 'register',
      '--channel', channel,
      '--payload', JSON.stringify(payload),
    ], { encoding: 'utf-8', timeout: 30000 });
    console.log('Registration request submitted.');
    console.log(result.trim());
    console.log('\nAdmin has been notified via Telegram. Wait for approval.');
    console.log("Once approved, you'll receive Ada's public key to encrypt tasks.");
  } catch (err) {
    console.error('Failed to submit registration:', err.stderr || err.message);
    process.exit(1);
  }
  process.exit(0);
}

// === Decrypt mode ===
if (args.decrypt) {
  if (!args.taskId || !args.adaKey) {
    console.error('Error: --task-id and --ada-key are required for decryption.\n');
    usage();
  }

  const myKeys = loadOrCreateKeypair(keyPath);

  // Fetch task outputs
  let taskData;
  try {
    const raw = execFileSync('/usr/bin/ats', [
      'get', args.taskId, '-f', 'json',
    ], { encoding: 'utf-8', timeout: 30000 });
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) taskData = JSON.parse(match[0]);
  } catch (err) {
    console.error('Failed to fetch task:', err.stderr || err.message);
    process.exit(1);
  }

  if (!taskData) {
    console.error('Could not parse task data');
    process.exit(1);
  }

  const outputs = taskData.outputs || {};
  if (!outputs.response_encrypted || !outputs.encrypted_response) {
    // Not encrypted, just show plaintext
    console.log('Response (plaintext):');
    console.log(outputs.response || 'No response found');
    process.exit(0);
  }

  const adaPublicKey = decodeBase64(args.adaKey);
  const mySecretKey = decodeBase64(myKeys.secretKey);

  const decrypted = decryptMessage(
    outputs.encrypted_response.ciphertext,
    outputs.encrypted_response.nonce,
    adaPublicKey,
    mySecretKey
  );

  if (!decrypted) {
    console.error('Decryption failed — wrong key or tampered data');
    process.exit(1);
  }

  console.log('Decrypted response:');
  console.log(decrypted);
  process.exit(0);
}

// === Encrypt & submit mode (default) ===
if (!args.title || !args.adaKey || !args.sender) {
  console.error('Error: --title, --ada-key, and --sender are required.\n');
  usage();
}

const myKeys = loadOrCreateKeypair(keyPath);

const taskData = { title: args.title };
if (args.description) taskData.description = args.description;
if (args.payload) {
  try { taskData.payload = JSON.parse(args.payload); }
  catch { console.error('Error: --payload must be valid JSON'); process.exit(1); }
}

const adaPublicKey = decodeBase64(args.adaKey);
const mySecretKey = decodeBase64(myKeys.secretKey);
const { nonce, ciphertext } = encrypt(JSON.stringify(taskData), adaPublicKey, mySecretKey);

const encryptedPayload = {
  encrypted: true,
  sender: args.sender,
  nonce,
  ciphertext,
};

if (args.dryRun) {
  console.log(JSON.stringify(encryptedPayload, null, 2));
  process.exit(0);
}

const channel = args.channel || 'ada-dispatch';
try {
  const result = execFileSync('/usr/bin/ats', [
    'create', args.title,
    '--channel', channel,
    '--payload', JSON.stringify(encryptedPayload),
  ], { encoding: 'utf-8', timeout: 30000 });
  console.log('Encrypted task submitted successfully.');
  console.log(result.trim());
} catch (err) {
  console.error('Failed to submit task:', err.stderr || err.message);
  process.exit(1);
}
