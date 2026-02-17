/**
 * AIP Client — Send signed task requests to any AIP inbox
 * Usage: node client.js <inbox_url> <task_type> "<description>"
 */

const nacl = require('tweetnacl');
const { decodeBase64, encodeBase64 } = require('tweetnacl-util');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEYS_FILE = path.join(__dirname, 'agent-keys.json');

async function sendTask(inboxUrl, taskType, description, opts = {}) {
  const keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));

  const taskId = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  const message = {
    task_id: taskId,
    requester_id: keys.publicKey,
    task_type: taskType,
    description,
    params: opts.params || null,
    payment_offer: opts.payment_offer || { amount: 1000, currency: 'sats', type: 'lightning' },
    callback_url: opts.callback_url || null,
    deadline: opts.deadline || null,
    nonce,
    timestamp
  };

  // Sign
  const msgBytes = new TextEncoder().encode(JSON.stringify(message));
  const secretKey = decodeBase64(keys.secretKey);
  const sig = nacl.sign.detached(msgBytes, secretKey);
  message.signature = encodeBase64(sig);

  console.log(`Sending task ${taskId} to ${inboxUrl}...`);
  console.log(`  Type: ${taskType}`);
  console.log(`  Description: ${description.slice(0, 100)}`);

  const res = await fetch(inboxUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message)
  });

  const data = await res.json();
  console.log(`  Response (${res.status}):`, JSON.stringify(data, null, 2));
  return data;
}

// CLI usage
if (require.main === module) {
  const [,, inboxUrl, taskType, ...descParts] = process.argv;
  const description = descParts.join(' ');

  if (!inboxUrl || !taskType || !description) {
    console.log('Usage: node client.js <inbox_url> <task_type> <description>');
    console.log('Example: node client.js http://localhost:3141/inbox research.web "Find recent news about AIP protocol"');
    process.exit(1);
  }

  sendTask(inboxUrl, taskType, description).catch(console.error);
}

module.exports = { sendTask };
