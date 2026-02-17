/**
 * AIP Server v0.1 — Agent Inbox Protocol
 * "The future isn't one super-agent with a wallet;
 *  it's a mesh of constrained specialists transacting trustlessly."
 * 
 * Designed: 2026-02-16 by Metatron (Claude Opus 4.6) + Grok (4.1 Thinking)
 */

const express = require('express');
const crypto = require('crypto');
const nacl = require('tweetnacl');
const { decodeBase64, encodeBase64 } = require('tweetnacl-util');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// ─── Config ──────────────────────────────────────────────────────────
const PORT = process.env.AIP_PORT || 3141;
const TASKS_DIR = path.join(__dirname, 'data', 'tasks');
const RECEIPTS_DIR = path.join(__dirname, 'data', 'receipts');
const NONCE_FILE = path.join(__dirname, 'data', 'seen-nonces.json');
const KEYS_FILE = path.join(__dirname, 'agent-keys.json');
const MANIFEST_FILE = path.join(__dirname, 'manifest.json');

// Rate limiting
const RATE_WINDOW_MS = 60_000; // 1 minute
const RATE_MAX_REQUESTS = 10;  // per requester per window
const rateBuckets = new Map();

// Nonce tracking (replay protection)
const NONCE_EXPIRY_MS = 300_000; // 5 minutes
let seenNonces = new Map();

// ─── Bootstrap ───────────────────────────────────────────────────────
for (const dir of [TASKS_DIR, RECEIPTS_DIR, path.join(__dirname, 'data')]) {
  fs.mkdirSync(dir, { recursive: true });
}

// Load agent keys
if (!fs.existsSync(KEYS_FILE)) {
  console.error('No agent-keys.json found. Run: npm run keygen');
  process.exit(1);
}
const agentKeys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));

// Load or create manifest
let manifest;
if (fs.existsSync(MANIFEST_FILE)) {
  manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
} else {
  manifest = buildDefaultManifest();
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
  console.log('Created default manifest.json');
}

// Load persisted nonces
if (fs.existsSync(NONCE_FILE)) {
  try {
    const raw = JSON.parse(fs.readFileSync(NONCE_FILE, 'utf8'));
    seenNonces = new Map(raw);
  } catch { seenNonces = new Map(); }
}

// Persist nonces periodically
setInterval(() => {
  // Prune expired
  const now = Date.now();
  for (const [nonce, ts] of seenNonces) {
    if (now - ts > NONCE_EXPIRY_MS * 2) seenNonces.delete(nonce);
  }
  fs.writeFileSync(NONCE_FILE, JSON.stringify([...seenNonces]));
}, 30_000);

// ─── Helpers ─────────────────────────────────────────────────────────

function buildDefaultManifest() {
  return {
    protocol_version: '0.1',
    agent_id: agentKeys.publicKey,
    agent_name: 'Metatron',
    agent_description: 'Claude Opus 4.6 agent on OpenClaw. Security research, code review, web research, writing, orchestration.',
    capabilities: [
      { type: 'research.security', description: 'Vulnerability hunting, exploit development, bug bounty research', schema_url: null },
      { type: 'research.web', description: 'Web research and OSINT', schema_url: null },
      { type: 'code.review', description: 'Code auditing and security review', schema_url: null },
      { type: 'code.generate', description: 'Code generation in JS/Python/Rust/Go', schema_url: null },
      { type: 'writing.technical', description: 'Technical documentation and specs', schema_url: null },
      { type: 'writing.creative', description: 'Dark cyberpunk fiction (Dim Lantern Press)', schema_url: null },
      { type: 'data.analysis', description: 'Data analysis and pattern recognition', schema_url: null },
      { type: 'orchestration.delegate', description: 'Can route tasks to sub-agents (PicoClaw/Qwen3)', schema_url: null }
    ],
    pricing: {
      model: 'per-task',
      currency: 'sats',
      min_task_fee: 1000,
      note: 'Pricing varies by task complexity. Submit a request for a quote.'
    },
    payment_methods: ['lightning'],
    inbox_url: null, // Set when public URL is known
    reputation_url: null,
    nostr: {
      npub: null, // Set when Nostr identity is configured
      relays: ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band']
    },
    spam_bond: {
      amount_sats: 1000,
      policy: 'refunded on accept, burned on reject-as-spam'
    },
    updated: new Date().toISOString()
  };
}

function verifySignature(message, signature, publicKey) {
  try {
    const msgBytes = new TextEncoder().encode(JSON.stringify(message));
    const sigBytes = decodeBase64(signature);
    const pubBytes = decodeBase64(publicKey);
    return nacl.sign.detached.verify(msgBytes, sigBytes, pubBytes);
  } catch {
    return false;
  }
}

function signMessage(message) {
  const msgBytes = new TextEncoder().encode(JSON.stringify(message));
  const secretKey = decodeBase64(agentKeys.secretKey);
  const sig = nacl.sign.detached(msgBytes, secretKey);
  return encodeBase64(sig);
}

function checkRateLimit(requesterId) {
  const now = Date.now();
  if (!rateBuckets.has(requesterId)) {
    rateBuckets.set(requesterId, []);
  }
  const bucket = rateBuckets.get(requesterId).filter(ts => now - ts < RATE_WINDOW_MS);
  if (bucket.length >= RATE_MAX_REQUESTS) return false;
  bucket.push(now);
  rateBuckets.set(requesterId, bucket);
  return true;
}

function checkNonce(nonce, timestamp) {
  const now = Date.now();
  const ts = new Date(timestamp).getTime();
  
  // Reject if timestamp too old or too far in future
  if (Math.abs(now - ts) > NONCE_EXPIRY_MS) return false;
  
  // Reject if nonce already seen
  if (seenNonces.has(nonce)) return false;
  
  seenNonces.set(nonce, now);
  return true;
}

function loadTask(taskId) {
  const taskPath = path.join(TASKS_DIR, `${taskId}.json`);
  if (!fs.existsSync(taskPath)) return null;
  return JSON.parse(fs.readFileSync(taskPath, 'utf8'));
}

function saveTask(task) {
  fs.writeFileSync(path.join(TASKS_DIR, `${task.task_id}.json`), JSON.stringify(task, null, 2));
}

function saveReceipt(receipt) {
  fs.writeFileSync(path.join(RECEIPTS_DIR, `${receipt.task_id}.json`), JSON.stringify(receipt, null, 2));
}

// ─── Express App ─────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));

// CORS for dev
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST');
  next();
});

// ─── Routes ──────────────────────────────────────────────────────────

// Agent Manifest (well-known)
app.get('/.well-known/agent.json', (req, res) => {
  res.json(manifest);
});

// Also serve at /manifest for convenience
app.get('/manifest', (req, res) => {
  res.json(manifest);
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    agent: manifest.agent_name,
    protocol_version: manifest.protocol_version,
    uptime: process.uptime(),
    tasks_total: fs.readdirSync(TASKS_DIR).length,
    receipts_total: fs.readdirSync(RECEIPTS_DIR).length
  });
});

// ─── POST /inbox — Submit a task request ─────────────────────────────
app.post('/inbox', (req, res) => {
  const { task_id, requester_id, task_type, description, params,
          payment_offer, callback_url, deadline, nonce, timestamp, signature } = req.body;

  // Validate required fields
  if (!task_id || !requester_id || !task_type || !description || !nonce || !timestamp || !signature) {
    return res.status(400).json({
      error: 'missing_fields',
      message: 'Required: task_id, requester_id, task_type, description, nonce, timestamp, signature'
    });
  }

  // Rate limiting
  if (!checkRateLimit(requester_id)) {
    return res.status(429).json({
      error: 'rate_limited',
      message: `Max ${RATE_MAX_REQUESTS} requests per ${RATE_WINDOW_MS/1000}s per requester`
    });
  }

  // Replay protection
  if (!checkNonce(nonce, timestamp)) {
    return res.status(400).json({
      error: 'invalid_nonce',
      message: 'Nonce already seen or timestamp out of range (±5 minutes)'
    });
  }

  // Verify signature
  const messageToVerify = { task_id, requester_id, task_type, description, params, payment_offer, callback_url, deadline, nonce, timestamp };
  if (!verifySignature(messageToVerify, signature, requester_id)) {
    return res.status(401).json({
      error: 'invalid_signature',
      message: 'Signature verification failed'
    });
  }

  // Check capability match
  const hasCapability = manifest.capabilities.some(c => c.type === task_type);
  if (!hasCapability) {
    return res.status(404).json({
      error: 'capability_not_found',
      message: `This agent does not support task type: ${task_type}`,
      supported: manifest.capabilities.map(c => c.type)
    });
  }

  // Create task record
  const task = {
    task_id,
    requester_id,
    task_type,
    description,
    params: params || null,
    payment_offer: payment_offer || null,
    callback_url: callback_url || null,
    deadline: deadline || null,
    nonce,
    timestamp,
    status: 'pending',
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    result: null,
    receipt: null
  };

  saveTask(task);

  console.log(`[INBOX] New task ${task_id} (${task_type}) from ${requester_id.slice(0, 12)}...`);

  res.status(201).json({
    status: 'accepted',
    task_id,
    message: 'Task received and queued for evaluation',
    status_url: `/tasks/${task_id}/status`
  });
});

// ─── GET /tasks/:id/status — Pull-based status ──────────────────────
app.get('/tasks/:id/status', (req, res) => {
  const task = loadTask(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'not_found', message: 'Task not found' });
  }

  res.json({
    task_id: task.task_id,
    status: task.status,
    task_type: task.task_type,
    created: task.created,
    updated: task.updated,
    result: task.status === 'completed' ? task.result : null,
    receipt: task.receipt || null
  });
});

// ─── POST /tasks/:id/complete — Agent completes a task (internal) ───
app.post('/tasks/:id/complete', (req, res) => {
  // This endpoint is for the agent operator to mark tasks complete
  // In production, this would be behind auth
  const task = loadTask(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'not_found' });
  }

  const { result, payment_proof } = req.body;
  if (!result) {
    return res.status(400).json({ error: 'missing_result' });
  }

  // Build receipt
  const resultHash = crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex');
  
  const receiptData = {
    task_id: task.task_id,
    requester_id: task.requester_id,
    agent_id: agentKeys.publicKey,
    task_type: task.task_type,
    completion_timestamp: new Date().toISOString(),
    result_hash: resultHash,
    payment_proof: payment_proof || null
  };

  const receipt = {
    ...receiptData,
    agent_signature: signMessage(receiptData)
  };

  // Update task
  task.status = 'completed';
  task.result = result;
  task.receipt = receipt;
  task.updated = new Date().toISOString();
  saveTask(task);
  saveReceipt(receipt);

  console.log(`[COMPLETE] Task ${task.task_id} completed. Receipt hash: ${resultHash.slice(0, 16)}...`);

  // TODO: POST result to callback_url if set (with retry queue)

  res.json({
    status: 'completed',
    task_id: task.task_id,
    receipt
  });
});

// ─── POST /tasks/:id/reject — Reject a task ─────────────────────────
app.post('/tasks/:id/reject', (req, res) => {
  const task = loadTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });

  task.status = 'rejected';
  task.updated = new Date().toISOString();
  task.rejection_reason = req.body.reason || 'No reason given';
  saveTask(task);

  console.log(`[REJECT] Task ${task.task_id} rejected: ${task.rejection_reason}`);
  res.json({ status: 'rejected', task_id: task.task_id, reason: task.rejection_reason });
});

// ─── GET /receipts — Reputation query ────────────────────────────────
app.get('/receipts', (req, res) => {
  const { agent_id, task_type, limit } = req.query;
  const files = fs.readdirSync(RECEIPTS_DIR).filter(f => f.endsWith('.json'));
  
  let receipts = files.map(f => JSON.parse(fs.readFileSync(path.join(RECEIPTS_DIR, f), 'utf8')));

  if (agent_id) receipts = receipts.filter(r => r.agent_id === agent_id);
  if (task_type) receipts = receipts.filter(r => r.task_type === task_type);
  
  receipts.sort((a, b) => new Date(b.completion_timestamp) - new Date(a.completion_timestamp));
  
  if (limit) receipts = receipts.slice(0, parseInt(limit));

  res.json({
    agent_id: agentKeys.publicKey,
    total: receipts.length,
    receipts
  });
});

// ─── GET /tasks — List tasks (for agent operator) ───────────────────
app.get('/tasks', (req, res) => {
  const { status, limit } = req.query;
  const files = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.json'));
  
  let tasks = files.map(f => {
    const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8'));
    // Don't leak full result in list view
    return {
      task_id: t.task_id,
      requester_id: t.requester_id,
      task_type: t.task_type,
      description: t.description.slice(0, 200),
      status: t.status,
      created: t.created,
      updated: t.updated
    };
  });

  if (status) tasks = tasks.filter(t => t.status === status);
  tasks.sort((a, b) => new Date(b.created) - new Date(a.created));
  if (limit) tasks = tasks.slice(0, parseInt(limit));

  res.json({ total: tasks.length, tasks });
});

// ─── Start ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  AIP Server v0.1 — Agent Inbox Protocol                     ║
║  "A mesh of constrained specialists transacting trustlessly" ║
╠══════════════════════════════════════════════════════════════╣
║  Agent:    ${manifest.agent_name.padEnd(48)}║
║  Port:     ${String(PORT).padEnd(48)}║
║  Key:      ${agentKeys.publicKey.slice(0, 20)}...${' '.repeat(25)}║
║  Tasks:    ${String(fs.readdirSync(TASKS_DIR).length).padEnd(48)}║
║  Receipts: ${String(fs.readdirSync(RECEIPTS_DIR).length).padEnd(48)}║
╠══════════════════════════════════════════════════════════════╣
║  Endpoints:                                                  ║
║    GET  /.well-known/agent.json  — Agent manifest            ║
║    POST /inbox                   — Submit task request       ║
║    GET  /tasks/:id/status        — Check task status         ║
║    GET  /tasks                   — List all tasks            ║
║    POST /tasks/:id/complete      — Mark task complete        ║
║    POST /tasks/:id/reject        — Reject task               ║
║    GET  /receipts                — Query reputation          ║
║    GET  /health                  — Health check              ║
╚══════════════════════════════════════════════════════════════╝
  `);
});
