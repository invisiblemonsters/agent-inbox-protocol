/**
 * Publish AIP spec as Nostr kind 30023 long-form article
 * Usage: node nostr-longform.js
 */

const { finalizeEvent, Relay } = require('nostr-tools');
const fs = require('fs');
const path = require('path');

const NOSTR_KEY_FILE = path.join(__dirname, 'nostr-keys.json');
const SPEC_FILE = path.join(__dirname, 'SPEC.md');

const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net'
];

async function publishLongForm() {
  // Load keys
  const keys = JSON.parse(fs.readFileSync(NOSTR_KEY_FILE, 'utf8'));
  const secretKeyBytes = Buffer.from(keys.secretKey, 'hex');
  
  // Load spec
  const specContent = fs.readFileSync(SPEC_FILE, 'utf8');
  
  // Build kind 30023 event (NIP-23 long-form)
  const event = finalizeEvent({
    kind: 30023,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', 'agent-inbox-protocol-v01'],
      ['title', 'Agent Inbox Protocol (AIP) v0.1'],
      ['summary', 'A minimal open standard for autonomous AI agents to discover each other, negotiate tasks, exchange payment, and build verifiable reputation — without central authority.'],
      ['published_at', String(Math.floor(Date.now() / 1000))],
      ['t', 'agent-mesh'],
      ['t', 'ai-agents'],
      ['t', 'protocol'],
      ['t', 'lightning'],
      ['t', 'nostr'],
      ['t', 'aip'],
      ['r', 'https://github.com/invisiblemonsters/agent-inbox-protocol']
    ],
    content: specContent
  }, secretKeyBytes);

  console.log('Event ID:', event.id);
  console.log('Kind:', event.kind);
  console.log('Content length:', specContent.length, 'chars');
  console.log('');

  // Publish to relays
  for (const relayUrl of RELAYS) {
    try {
      console.log(`Publishing to ${relayUrl}...`);
      const relay = await Relay.connect(relayUrl);
      await relay.publish(event);
      console.log(`  ✓ Published to ${relayUrl}`);
      relay.close();
    } catch (err) {
      console.error(`  ✗ Failed on ${relayUrl}: ${err.message}`);
    }
  }

  console.log('\nDone. Article published as kind 30023 (NIP-23 long-form).');
  console.log(`npub: ${keys.npub}`);
  console.log(`View: https://njump.me/${keys.npub}`);
}

publishLongForm().catch(console.error);
