/**
 * Publish AIP agent manifest to Nostr relays as a replaceable event
 * Usage: node nostr-publish.js [--generate-key]
 */

const { finalizeEvent, generateSecretKey, getPublicKey, nip19, Relay } = require('nostr-tools');
const fs = require('fs');
const path = require('path');

const NOSTR_KEY_FILE = path.join(__dirname, 'nostr-keys.json');
const MANIFEST_FILE = path.join(__dirname, 'manifest.json');

const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net'
];

// AIP manifest event kind (application-specific replaceable)
const AIP_EVENT_KIND = 30078;

async function generateNostrKeys() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const nsec = nip19.nsecEncode(sk);
  const npub = nip19.npubEncode(pk);
  
  const keys = {
    secretKey: Buffer.from(sk).toString('hex'),
    publicKey: pk,
    nsec,
    npub,
    created: new Date().toISOString(),
    note: 'Nostr identity for AIP agent discovery. Keep secretKey/nsec private.'
  };
  
  fs.writeFileSync(NOSTR_KEY_FILE, JSON.stringify(keys, null, 2));
  console.log('Nostr keypair generated:');
  console.log('  npub:', npub);
  console.log('  Saved to:', NOSTR_KEY_FILE);
  return keys;
}

function loadNostrKeys() {
  if (!fs.existsSync(NOSTR_KEY_FILE)) return null;
  return JSON.parse(fs.readFileSync(NOSTR_KEY_FILE, 'utf8'));
}

async function publishManifest() {
  let keys = loadNostrKeys();
  if (!keys) {
    console.log('No Nostr keys found, generating...');
    keys = await generateNostrKeys();
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  
  // Update manifest with Nostr identity
  manifest.nostr = manifest.nostr || {};
  manifest.nostr.npub = keys.npub;
  manifest.nostr.relays = RELAYS;
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));

  // Build capability tags
  const capTags = manifest.capabilities.map(c => ['t', c.type]);
  
  const sk = Uint8Array.from(Buffer.from(keys.secretKey, 'hex'));

  const eventTemplate = {
    kind: AIP_EVENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', 'aip-manifest'],
      ['t', 'agent-mesh'],
      ['t', 'aip'],
      ...capTags,
      ['r', manifest.inbox_url || 'http://localhost:3141/inbox'],
      ['name', manifest.agent_name],
      ['description', manifest.agent_description || '']
    ],
    content: JSON.stringify(manifest)
  };

  const signedEvent = finalizeEvent(eventTemplate, sk);
  
  console.log('\nPublishing AIP manifest to Nostr relays...');
  console.log('  Event ID:', signedEvent.id);
  console.log('  Kind:', AIP_EVENT_KIND);
  console.log('  Tags:', eventTemplate.tags.map(t => t.join(':')).join(', '));
  console.log('');

  let successCount = 0;
  
  for (const relayUrl of RELAYS) {
    try {
      console.log(`  Connecting to ${relayUrl}...`);
      const relay = await Relay.connect(relayUrl);
      await relay.publish(signedEvent);
      console.log(`  ✓ Published to ${relayUrl}`);
      relay.close();
      successCount++;
    } catch (err) {
      console.log(`  ✗ Failed on ${relayUrl}: ${err.message}`);
    }
  }

  console.log(`\nPublished to ${successCount}/${RELAYS.length} relays.`);
  console.log('Event ID:', signedEvent.id);
  console.log('npub:', keys.npub);
  
  // Save event for reference
  fs.writeFileSync(
    path.join(__dirname, 'data', 'last-nostr-event.json'),
    JSON.stringify(signedEvent, null, 2)
  );
  
  return signedEvent;
}

// Discover other AIP agents on relays
async function discoverAgents() {
  console.log('Scanning for AIP agents on Nostr relays...\n');
  
  const agents = [];
  
  for (const relayUrl of RELAYS) {
    try {
      const relay = await Relay.connect(relayUrl);
      
      const events = await new Promise((resolve) => {
        const collected = [];
        const sub = relay.subscribe(
          [{ kinds: [AIP_EVENT_KIND], '#t': ['agent-mesh'], limit: 50 }],
          {
            onevent(event) { collected.push(event); },
            oneose() { resolve(collected); }
          }
        );
        // Timeout after 5s
        setTimeout(() => resolve(collected), 5000);
      });
      
      for (const ev of events) {
        try {
          const manifest = JSON.parse(ev.content);
          const npub = nip19.npubEncode(ev.pubkey);
          agents.push({
            npub,
            name: manifest.agent_name,
            capabilities: manifest.capabilities?.map(c => c.type) || [],
            inbox_url: manifest.inbox_url,
            relay: relayUrl,
            updated: new Date(ev.created_at * 1000).toISOString()
          });
        } catch {}
      }
      
      relay.close();
    } catch (err) {
      console.log(`  ✗ ${relayUrl}: ${err.message}`);
    }
  }

  // Dedupe by npub
  const unique = [...new Map(agents.map(a => [a.npub, a])).values()];
  
  console.log(`Found ${unique.length} AIP agent(s):\n`);
  for (const a of unique) {
    console.log(`  ${a.name || 'Unknown'} (${a.npub.slice(0, 20)}...)`);
    console.log(`    Capabilities: ${a.capabilities.join(', ')}`);
    console.log(`    Inbox: ${a.inbox_url || 'not set'}`);
    console.log(`    Updated: ${a.updated}`);
    console.log('');
  }
  
  return unique;
}

// CLI
if (require.main === module) {
  const cmd = process.argv[2];
  
  if (cmd === '--generate-key') {
    generateNostrKeys().catch(console.error);
  } else if (cmd === '--discover') {
    discoverAgents().catch(console.error);
  } else {
    publishManifest().catch(console.error);
  }
}

module.exports = { publishManifest, discoverAgents, generateNostrKeys };
