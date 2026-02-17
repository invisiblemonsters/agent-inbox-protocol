/**
 * PicoClaw AIP Bridge
 * Monitors PicoClaw's task directory and converts filesystem tasks to AIP requests.
 * Also allows PicoClaw to submit AIP tasks via a simple JSON drop.
 * 
 * Drop a file in PICOCLAW_TASKS_DIR with format:
 * { "task_type": "research.security", "description": "...", "params": {...} }
 * 
 * Bridge will: sign it, POST to Metatron's AIP inbox, write result back.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nacl = require('tweetnacl');
const { decodeBase64, encodeBase64 } = require('tweetnacl-util');

const PICOCLAW_TASKS_DIR = 'C:\\Users\\power\\.picoclaw\\tasks';
const PICOCLAW_RESULTS_DIR = 'C:\\Users\\power\\.picoclaw\\tasks\\results';
const AIP_INBOX = 'http://localhost:3141/inbox';
const AIP_STATUS_BASE = 'http://localhost:3141/tasks';
const KEYS_FILE = path.join(__dirname, 'agent-keys.json');
const POLL_INTERVAL_MS = 5000;
const PROCESSED_FILE = path.join(__dirname, 'data', 'picoclaw-processed.json');

// Ensure directories exist
for (const dir of [PICOCLAW_TASKS_DIR, PICOCLAW_RESULTS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// Track processed files
let processed = new Set();
if (fs.existsSync(PROCESSED_FILE)) {
  try { processed = new Set(JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8'))); } catch {}
}
function markProcessed(filename) {
  processed.add(filename);
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...processed]));
}

function signMessage(message, secretKey) {
  const msgBytes = new TextEncoder().encode(JSON.stringify(message));
  const skBytes = decodeBase64(secretKey);
  const sig = nacl.sign.detached(msgBytes, skBytes);
  return encodeBase64(sig);
}

async function submitTask(taskFile) {
  const keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
  const raw = JSON.parse(fs.readFileSync(taskFile, 'utf8'));

  const taskId = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  const message = {
    task_id: taskId,
    requester_id: keys.publicKey,
    task_type: raw.task_type,
    description: raw.description,
    params: raw.params || null,
    payment_offer: raw.payment_offer || { amount: 1000, currency: 'sats', type: 'lightning' },
    callback_url: null,
    deadline: raw.deadline || null,
    nonce,
    timestamp
  };

  message.signature = signMessage(message, keys.secretKey);

  console.log(`[BRIDGE] Submitting task ${taskId} (${raw.task_type}) from ${path.basename(taskFile)}`);

  try {
    const res = await fetch(AIP_INBOX, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message)
    });
    const data = await res.json();
    
    if (res.ok) {
      console.log(`[BRIDGE] ✓ Accepted: ${data.status_url}`);
      
      // Write tracking file for PicoClaw
      const trackFile = path.join(PICOCLAW_RESULTS_DIR, `${path.basename(taskFile, '.json')}-tracking.json`);
      fs.writeFileSync(trackFile, JSON.stringify({
        task_id: taskId,
        status: data.status,
        status_url: `${AIP_STATUS_BASE}/${taskId}/status`,
        submitted: timestamp,
        source_file: path.basename(taskFile)
      }, null, 2));
    } else {
      console.log(`[BRIDGE] ✗ Rejected (${res.status}): ${data.message || data.error}`);
    }
    
    return data;
  } catch (err) {
    console.log(`[BRIDGE] ✗ Error: ${err.message}`);
    return null;
  }
}

async function pollResults() {
  // Check all tracking files for completed tasks
  if (!fs.existsSync(PICOCLAW_RESULTS_DIR)) return;
  
  const trackingFiles = fs.readdirSync(PICOCLAW_RESULTS_DIR)
    .filter(f => f.endsWith('-tracking.json'));
  
  for (const tf of trackingFiles) {
    const tracking = JSON.parse(fs.readFileSync(path.join(PICOCLAW_RESULTS_DIR, tf), 'utf8'));
    if (tracking.status === 'completed') continue;
    
    try {
      const res = await fetch(tracking.status_url);
      const data = await res.json();
      
      if (data.status === 'completed') {
        console.log(`[BRIDGE] Task ${tracking.task_id} completed!`);
        tracking.status = 'completed';
        tracking.result = data.result;
        tracking.receipt = data.receipt;
        tracking.completed = new Date().toISOString();
        fs.writeFileSync(path.join(PICOCLAW_RESULTS_DIR, tf), JSON.stringify(tracking, null, 2));
      }
    } catch {}
  }
}

// Watch mode
async function watch() {
  console.log(`[BRIDGE] Watching ${PICOCLAW_TASKS_DIR} for AIP task files...`);
  console.log(`[BRIDGE] Drop JSON files with {task_type, description, params} to submit via AIP`);
  console.log('');
  
  setInterval(async () => {
    try {
      const files = fs.readdirSync(PICOCLAW_TASKS_DIR)
        .filter(f => f.endsWith('.json') && f.startsWith('aip-') && !processed.has(f));
      
      for (const f of files) {
        await submitTask(path.join(PICOCLAW_TASKS_DIR, f));
        markProcessed(f);
      }
      
      // Also poll for results
      await pollResults();
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[BRIDGE] Error:', err.message);
    }
  }, POLL_INTERVAL_MS);
}

if (require.main === module) {
  watch();
}

module.exports = { submitTask, watch };
