/**
 * dvm-bridge.js — NIP-90 Data Vending Machine bridge for AIP
 * 
 * Listens for NIP-90 job requests on Nostr relays and converts them
 * to AIP tasks. When tasks complete, publishes results back as NIP-90
 * job results with Lightning payment requests.
 * 
 * Supported kinds:
 *   5050 — Text Generation (security analysis, code review, etc.)
 *   5001 — Summarization
 *   5000 — Text Extraction
 * 
 * This bridges the Nostr DVM ecosystem with AIP's task lifecycle,
 * letting any Nostr client request services from our agent.
 */

const { finalizeEvent, getPublicKey } = require('nostr-tools/pure');
const { Relay } = require('nostr-tools/relay');

// DVM Kind mapping
const SUPPORTED_KINDS = {
  5050: { name: 'Text Generation', resultKind: 6050 },
  5001: { name: 'Summarization', resultKind: 6001 },
  5000: { name: 'Text Extraction', resultKind: 6000 },
};

// Our capabilities as a DVM
const DVM_CAPABILITIES = {
  5050: {
    description: 'Security analysis, code review, vulnerability assessment',
    pricing: { amount: 500, unit: 'msats' }, // 0.5 sats per request
    params: ['model', 'max_tokens', 'focus_area'],
  },
};

class DVMBridge {
  constructor(secretKey, relays) {
    this.secretKey = secretKey;
    this.pubkey = getPublicKey(secretKey);
    this.relays = relays || [
      'wss://relay.damus.io',
      'wss://nos.lol',
      'wss://relay.primal.net',
    ];
    this.connections = [];
  }

  /**
   * Start listening for DVM job requests
   */
  async start() {
    console.log(`[DVM] Starting bridge for pubkey ${this.pubkey.slice(0, 16)}...`);
    console.log(`[DVM] Supported kinds: ${Object.keys(SUPPORTED_KINDS).join(', ')}`);

    for (const url of this.relays) {
      try {
        const relay = await Relay.connect(url);
        console.log(`[DVM] Connected to ${url}`);

        // Subscribe to job requests mentioning us or broadcast
        relay.subscribe([
          {
            kinds: Object.keys(SUPPORTED_KINDS).map(Number),
            '#p': [this.pubkey], // Jobs specifically for us
            since: Math.floor(Date.now() / 1000) - 60, // Last minute
          },
          {
            kinds: Object.keys(SUPPORTED_KINDS).map(Number),
            since: Math.floor(Date.now() / 1000) - 60, // All recent jobs
            limit: 10,
          },
        ], {
          onevent: (event) => this.handleJobRequest(event, relay),
          oneose: () => console.log(`[DVM] Subscription active on ${url}`),
        });

        this.connections.push(relay);
      } catch (err) {
        console.error(`[DVM] Failed to connect to ${url}:`, err.message);
      }
    }
  }

  /**
   * Handle incoming NIP-90 job request
   */
  async handleJobRequest(event, relay) {
    const kindInfo = SUPPORTED_KINDS[event.kind];
    if (!kindInfo) return;

    console.log(`[DVM] Job request: kind=${event.kind} (${kindInfo.name})`);
    console.log(`[DVM]   From: ${event.pubkey.slice(0, 16)}...`);

    // Extract input
    const inputs = event.tags.filter(t => t[0] === 'i');
    const params = event.tags.filter(t => t[0] === 'param');
    const bid = event.tags.find(t => t[0] === 'bid');

    console.log(`[DVM]   Inputs: ${inputs.length}`);
    console.log(`[DVM]   Params: ${params.length}`);
    if (bid) console.log(`[DVM]   Bid: ${bid[1]} msats`);

    // Send processing feedback
    await this.sendFeedback(event, relay, 'processing', 'Analyzing request...');

    // TODO: Actually process the request through AIP task system
    // For now, this is a framework that shows the integration pattern

    // Send payment-required feedback with invoice
    // const invoice = await createInvoice(500, `DVM job ${event.id.slice(0, 8)}`);
    // await this.sendFeedback(event, relay, 'payment-required', '', invoice.bolt11);
  }

  /**
   * Send NIP-90 job feedback
   */
  async sendFeedback(jobEvent, relay, status, content = '', bolt11 = '') {
    const tags = [
      ['status', status, content],
      ['e', jobEvent.id],
      ['p', jobEvent.pubkey],
    ];

    if (bolt11) {
      tags.push(['amount', '500', bolt11]);
    }

    const event = finalizeEvent({
      kind: 7000,
      content: content,
      tags,
      created_at: Math.floor(Date.now() / 1000),
    }, this.secretKey);

    await relay.publish(event);
    console.log(`[DVM] Sent feedback: ${status}`);
  }

  /**
   * Send NIP-90 job result
   */
  async sendResult(jobEvent, relay, result, bolt11 = '') {
    const kindInfo = SUPPORTED_KINDS[jobEvent.kind];
    const tags = [
      ['request', JSON.stringify(jobEvent)],
      ['e', jobEvent.id],
      ['p', jobEvent.pubkey],
    ];

    // Include original inputs
    const inputs = jobEvent.tags.filter(t => t[0] === 'i');
    for (const input of inputs) {
      tags.push(input);
    }

    if (bolt11) {
      tags.push(['amount', '500', bolt11]);
    }

    const event = finalizeEvent({
      kind: kindInfo.resultKind,
      content: result,
      tags,
      created_at: Math.floor(Date.now() / 1000),
    }, this.secretKey);

    await relay.publish(event);
    console.log(`[DVM] Sent result: kind=${kindInfo.resultKind}`);
  }

  /**
   * Publish DVM announcement (kind 31990)
   */
  async announceCapabilities() {
    for (const [kind, cap] of Object.entries(DVM_CAPABILITIES)) {
      const event = finalizeEvent({
        kind: 31990,
        content: JSON.stringify({
          name: 'Metatron Security DVM',
          about: cap.description,
          pricing: cap.pricing,
        }),
        tags: [
          ['d', `metatron-dvm-${kind}`],
          ['k', kind],
        ],
        created_at: Math.floor(Date.now() / 1000),
      }, this.secretKey);

      for (const relay of this.connections) {
        try {
          await relay.publish(event);
        } catch (err) {
          // ignore
        }
      }
    }
    console.log('[DVM] Capabilities announced');
  }

  async stop() {
    for (const relay of this.connections) {
      relay.close();
    }
    console.log('[DVM] Bridge stopped');
  }
}

module.exports = { DVMBridge, SUPPORTED_KINDS };

if (require.main === module) {
  console.log('NIP-90 DVM Bridge for AIP');
  console.log('Supported kinds:', Object.entries(SUPPORTED_KINDS).map(([k, v]) => `${k}: ${v.name}`).join(', '));
  console.log('\nTo start: instantiate DVMBridge with your Nostr secret key and call start()');
}
