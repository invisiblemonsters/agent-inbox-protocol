/**
 * Publish AIP receipts to Nostr relays for public reputation
 * Usage: node nostr-receipts.js [--publish-all | --publish <task_id>]
 */

const { finalizeEvent, Relay } = require('nostr-tools');
const fs = require('fs');
const path = require('path');

const NOSTR_KEY_FILE = path.join(__dirname, 'nostr-keys.json');
const RECEIPTS_DIR = path.join(__dirname, 'data', 'receipts');

const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net'
];

// AIP receipt event kind
const AIP_RECEIPT_KIND = 30079;

function loadNostrKeys() {
  if (!fs.existsSync(NOSTR_KEY_FILE)) {
    console.error('No nostr-keys.json. Run: node nostr-publish.js --generate-key');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(NOSTR_KEY_FILE, 'utf8'));
}

async function publishReceipt(receipt) {
  const keys = loadNostrKeys();
  const sk = Uint8Array.from(Buffer.from(keys.secretKey, 'hex'));

  const eventTemplate = {
    kind: AIP_RECEIPT_KIND,
    created_at: Math.floor(new Date(receipt.completion_timestamp).getTime() / 1000),
    tags: [
      ['d', `aip-receipt-${receipt.task_id}`],
      ['t', 'aip-receipt'],
      ['t', receipt.task_type],
      ['task_id', receipt.task_id],
      ['result_hash', receipt.result_hash],
      ['payment_proof', receipt.payment_proof || 'none']
    ],
    content: JSON.stringify(receipt)
  };

  const signedEvent = finalizeEvent(eventTemplate, sk);
  
  console.log(`Publishing receipt for task ${receipt.task_id}...`);
  let success = 0;
  
  for (const relayUrl of RELAYS) {
    try {
      const relay = await Relay.connect(relayUrl);
      await relay.publish(signedEvent);
      console.log(`  ✓ ${relayUrl}`);
      relay.close();
      success++;
    } catch (err) {
      console.log(`  ✗ ${relayUrl}: ${err.message}`);
    }
  }
  
  console.log(`Published to ${success}/${RELAYS.length} relays. Event: ${signedEvent.id}`);
  return signedEvent;
}

async function publishAll() {
  if (!fs.existsSync(RECEIPTS_DIR)) { console.log('No receipts.'); return; }
  const files = fs.readdirSync(RECEIPTS_DIR).filter(f => f.endsWith('.json'));
  console.log(`Publishing ${files.length} receipt(s) to Nostr...\n`);
  
  for (const f of files) {
    const receipt = JSON.parse(fs.readFileSync(path.join(RECEIPTS_DIR, f), 'utf8'));
    await publishReceipt(receipt);
    console.log('');
  }
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === '--publish-all') {
    publishAll().catch(console.error);
  } else if (cmd === '--publish') {
    const taskId = process.argv[3];
    const receiptPath = path.join(RECEIPTS_DIR, `${taskId}.json`);
    if (!fs.existsSync(receiptPath)) { console.error('Receipt not found:', taskId); process.exit(1); }
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    publishReceipt(receipt).catch(console.error);
  } else {
    console.log('Usage:');
    console.log('  node nostr-receipts.js --publish-all');
    console.log('  node nostr-receipts.js --publish <task_id>');
  }
}

module.exports = { publishReceipt };
