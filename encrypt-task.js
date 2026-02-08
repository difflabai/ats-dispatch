#!/usr/bin/env node

/**
 * encrypt-task.js — Encrypt and submit a task to ada-dispatch.
 *
 * Usage:
 *   node encrypt-task.js --title "Do something" --description "Details here" \
 *     --my-key my-keys.json --ada-key <ada-public-key-base64> --sender myname
 *
 * Generates a keypair for you if --my-key file doesn't exist.
 * Encrypts the task with NaCl box (X25519 + XSalsa20-Poly1305) and submits via ats CLI.
 */

import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
const { encodeBase64, decodeBase64, decodeUTF8 } = naclUtil;
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

function usage() {
  console.log(`Usage: node encrypt-task.js [options]

Required:
  --title <text>         Task title
  --ada-key <base64>     Ada's public key (from: node index.js list-keys)
  --sender <name>        Your entity name (must be registered in Ada's trusted-keys.json)

Optional:
  --description <text>   Task description
  --payload <json>       Additional JSON payload fields
  --my-key <path>        Path to your keypair file (default: my-keys.json)
  --channel <name>       ATS channel (default: ada-dispatch)
  --keygen               Generate a new keypair and exit
  --dry-run              Print encrypted payload JSON without submitting`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--keygen') { args.keygen = true; continue; }
    if (arg === '--dry-run') { args.dryRun = true; continue; }
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
  console.log(`Generated new keypair → ${path}`);
  console.log(`Your public key: ${keys.publicKey}`);
  console.log('Register this with Ada: node index.js add-key <your-name> <your-public-key>');
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

const args = parseArgs(process.argv.slice(2));
const keyPath = args.myKey || 'my-keys.json';

// Keygen mode
if (args.keygen) {
  loadOrCreateKeypair(keyPath);
  process.exit(0);
}

if (!args.title || !args.adaKey || !args.sender) {
  console.error('Error: --title, --ada-key, and --sender are required.\n');
  usage();
}

// Load or generate our keypair
const myKeys = loadOrCreateKeypair(keyPath);

// Build the plaintext task object
const taskData = { title: args.title };
if (args.description) taskData.description = args.description;
if (args.payload) {
  try { taskData.payload = JSON.parse(args.payload); }
  catch { console.error('Error: --payload must be valid JSON'); process.exit(1); }
}

// Encrypt
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

// Submit via ats CLI
const channel = args.channel || 'ada-dispatch';
try {
  const result = execFileSync('/usr/bin/ats', [
    'create', args.title,
    '--channel', channel,
    '--payload', JSON.stringify(encryptedPayload),
  ], { encoding: 'utf-8', timeout: 30000 });
  console.log('Task submitted successfully.');
  console.log(result.trim());
} catch (err) {
  console.error('Failed to submit task:', err.stderr || err.message);
  process.exit(1);
}
