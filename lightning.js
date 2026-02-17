/**
 * AIP Lightning Payment Module
 * Uses Coinos.io API for Lightning invoice creation and payment verification.
 * 
 * Coinos API (behind Cloudflare, requires browser-obtained token):
 *   POST /api/login → {token}
 *   POST /api/invoice → {hash, text (bolt11)}  
 *   GET  /api/me → {balance}
 *   POST /api/payments → send payment
 * 
 * Token must be obtained via browser and saved to coinos-token.json
 */

const fs = require('fs');
const path = require('path');

const TOKEN_FILE = path.join(__dirname, 'coinos-token.json');
const COINOS_API = 'https://coinos.io/api';

function getToken() {
  if (!fs.existsSync(TOKEN_FILE)) {
    console.warn('[LIGHTNING] No coinos-token.json found. Run: node lightning.js --get-token (via browser)');
    return null;
  }
  const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  return data.token;
}

async function coinosRequest(method, endpoint, body = null) {
  const token = getToken();
  if (!token) throw new Error('No Coinos API token. Login via browser first.');

  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${COINOS_API}${endpoint}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Coinos API error (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Create a Lightning invoice for receiving payment
 * @param {number} amount - Amount in sats
 * @param {string} memo - Invoice description
 * @returns {Object} {hash, text (bolt11 invoice string)}
 */
async function createInvoice(amount, memo = 'AIP task payment') {
  return coinosRequest('POST', '/invoice', {
    invoice: {
      amount,
      type: 'lightning',
      memo
    }
  });
}

/**
 * Check wallet balance
 * @returns {Object} {balance in sats}
 */
async function getBalance() {
  return coinosRequest('GET', '/me');
}

/**
 * Pay a Lightning invoice
 * @param {string} payreq - BOLT11 invoice string
 * @returns {Object} payment result with preimage
 */
async function payInvoice(payreq) {
  return coinosRequest('POST', '/payments', { payreq });
}

/**
 * Verify a spam bond payment (check if invoice was paid)
 * @param {string} hash - Payment hash from the invoice
 * @returns {boolean}
 */
async function verifyPayment(hash) {
  try {
    const data = await coinosRequest('GET', `/invoice/${hash}`);
    return data && data.received;
  } catch {
    return false;
  }
}

/**
 * Generate a spam bond invoice for a task request
 * @param {string} taskId - Task ID for the memo
 * @param {number} amount - Bond amount in sats (default 1000)
 * @returns {Object} {hash, bolt11, amount}
 */
async function createSpamBond(taskId, amount = 1000) {
  const invoice = await createInvoice(amount, `AIP spam bond: ${taskId}`);
  return {
    hash: invoice.hash,
    bolt11: invoice.text || invoice.bolt11,
    amount
  };
}

// CLI
if (require.main === module) {
  const cmd = process.argv[2];
  
  if (cmd === '--balance') {
    getBalance().then(d => console.log('Balance:', d)).catch(console.error);
  } else if (cmd === '--invoice') {
    const amount = parseInt(process.argv[3]) || 1000;
    const memo = process.argv[4] || 'AIP test invoice';
    createInvoice(amount, memo).then(d => {
      console.log('Invoice created:');
      console.log('  Hash:', d.hash);
      console.log('  BOLT11:', (d.text || d.bolt11 || '').slice(0, 80) + '...');
    }).catch(console.error);
  } else if (cmd === '--save-token') {
    const token = process.argv[3];
    if (!token) { console.log('Usage: node lightning.js --save-token <token>'); process.exit(1); }
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, saved: new Date().toISOString() }, null, 2));
    console.log('Token saved to', TOKEN_FILE);
  } else {
    console.log('AIP Lightning Module');
    console.log('  --balance          Check Coinos wallet balance');
    console.log('  --invoice <sats>   Create Lightning invoice');
    console.log('  --save-token <t>   Save Coinos API token');
    console.log('');
    console.log('Token status:', fs.existsSync(TOKEN_FILE) ? 'SAVED' : 'MISSING');
  }
}

module.exports = { createInvoice, getBalance, payInvoice, verifyPayment, createSpamBond };
