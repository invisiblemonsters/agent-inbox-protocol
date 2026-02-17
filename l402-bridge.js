/**
 * l402-bridge.js — Bridge between AIP task completion and L402 Lightning payments
 * 
 * Flow:
 * 1. Agent submits task to AIP inbox with payment offer
 * 2. AIP server accepts task, generates Lightning invoice via Coinos
 * 3. Task gets completed, agent pays invoice
 * 4. AIP confirms payment via preimage, marks task as paid
 * 5. Receipt published to Nostr
 * 
 * Future (v0.2): Replace Coinos with lnget/Aperture from lightning-agent-kit
 * for proper L402 flow with remote signer security model.
 */

const { createInvoice, checkInvoice } = require('./lightning.js');

class L402Bridge {
  constructor(options = {}) {
    this.defaultPrice = options.defaultPrice || 100; // sats
    this.maxPrice = options.maxPrice || 10000; // sats
    this.pendingPayments = new Map();
  }

  /**
   * Create a payment request for a task
   * @param {string} taskId - The AIP task ID
   * @param {number} amount - Amount in sats
   * @param {string} description - Payment description
   * @returns {Object} Invoice details
   */
  async createTaskPayment(taskId, amount, description) {
    if (amount > this.maxPrice) {
      throw new Error(`Amount ${amount} exceeds max price ${this.maxPrice}`);
    }

    const invoice = await createInvoice(amount, `AIP Task: ${description}`);
    
    this.pendingPayments.set(taskId, {
      invoiceId: invoice.id,
      amount,
      bolt11: invoice.bolt11 || invoice.text,
      status: 'pending',
      createdAt: Date.now(),
    });

    return {
      taskId,
      amount,
      bolt11: invoice.bolt11 || invoice.text,
      invoiceId: invoice.id,
      // L402-style challenge header
      l402Challenge: `L402 invoice="${invoice.bolt11 || invoice.text}", macaroon="aip-task-${taskId}"`,
    };
  }

  /**
   * Check if a task's payment has been received
   * @param {string} taskId - The AIP task ID
   * @returns {Object} Payment status
   */
  async checkTaskPayment(taskId) {
    const payment = this.pendingPayments.get(taskId);
    if (!payment) {
      return { status: 'not_found' };
    }

    const invoiceStatus = await checkInvoice(payment.invoiceId);
    
    if (invoiceStatus.paid || invoiceStatus.status === 'paid') {
      payment.status = 'paid';
      payment.paidAt = Date.now();
      payment.preimage = invoiceStatus.preimage;
      return {
        status: 'paid',
        amount: payment.amount,
        preimage: invoiceStatus.preimage,
        paidAt: payment.paidAt,
      };
    }

    return {
      status: 'pending',
      amount: payment.amount,
      bolt11: payment.bolt11,
    };
  }

  /**
   * Get pricing for a task based on capability
   * @param {string} capability - The task capability
   * @returns {number} Price in sats
   */
  getTaskPrice(capability) {
    const prices = {
      'research.security': 500,
      'research.web': 100,
      'code.generate': 300,
      'code.review': 200,
      'writing.technical': 250,
      'writing.creative': 150,
      'data.analysis': 200,
      'orchestration.delegate': 50,
    };
    return prices[capability] || this.defaultPrice;
  }

  /**
   * Generate L402-compatible 402 response headers
   * @param {string} taskId - Task ID
   * @param {string} bolt11 - Lightning invoice
   * @returns {Object} HTTP headers for 402 response
   */
  generate402Headers(taskId, bolt11) {
    return {
      'WWW-Authenticate': `L402 macaroon="aip-${taskId}", invoice="${bolt11}"`,
      'Content-Type': 'application/json',
    };
  }
}

module.exports = { L402Bridge };

// Self-test
if (require.main === module) {
  const bridge = new L402Bridge();
  console.log('L402 Bridge initialized');
  console.log('Capability prices:');
  const caps = ['research.security', 'research.web', 'code.generate', 'writing.creative'];
  caps.forEach(c => console.log(`  ${c}: ${bridge.getTaskPrice(c)} sats`));
}
