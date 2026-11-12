const assert = require('assert/strict');
const test = require('node:test');
const { resolveTerminalCardTicket } = require('../src/helpers/stripeTerminalCardTicket');
const { buildTerminalPaymentHistoryModule } = require('../src/modules/m_terminalPaymentHistory');
const { buildTerminalPaymentHistoryController } = require('../src/controllers/c_terminalPaymentHistory');
const { buildStripeTerminalWebhookHandler } = require('../src/services/stripeTerminalWebhooks');

const session = { id: 81, shopid: 7, status: 'succeeded', payment_kind: 'standalone',
  stripe_payment_intent_id: 'pi_receipt', stripe_charge_id: 'ch_receipt', amount_cents: 1200, currency: 'eur' };
const intent = { id: 'pi_receipt', status: 'succeeded', amount: 1200, currency: 'eur',
  metadata: { terminal_payment_id: '81', shop_id: '7' }, latest_charge: { id: 'ch_receipt',
    payment_method_details: { card_present: { brand: 'visa', last4: '4242', funding: 'debit', fullPan: '4242424242424242', client_secret: 'secret',
      receipt: { application_preferred_name: 'VISA', dedicated_file_name: 'A0000000031010' } } } } };

test('receipt recovery expands the charge, retains saved details and filters sensitive data', async () => {
  const calls = [];
  const stripe = { paymentIntents: { retrieve: async (...args) => { calls.push(args); return intent; } } };
  const ticket = await resolveTerminalCardTicket({ ...session, card_receipt_details: JSON.stringify({ authorizationCode: '123456' }) }, null, stripe);
  assert.deepEqual(calls, [['pi_receipt', { expand: ['latest_charge'] }]]);
  assert.equal(ticket.brand, 'visa');
  assert.equal(ticket.last4, '4242');
  assert.equal(ticket.funding, 'debit');
  assert.equal(ticket.authorizationCode, '123456');
  assert.equal(ticket.applicationPreferredName, 'VISA');
  assert.doesNotMatch(JSON.stringify(ticket), /4242424242424242|client_secret|secret/);
})

test('a transaction from another shop cannot fill a receipt and Stripe downtime keeps stored data', async () => {
  const stored = { ...session, card_receipt_details: JSON.stringify({ brand: 'visa', last4: '4242' }) };
  for (const retrieve of [async () => ({ ...intent, metadata: { ...intent.metadata, shop_id: '8' } }),
    async () => { throw new Error('Stripe unavailable'); }]) {
    const ticket = await resolveTerminalCardTicket(stored, null, { paymentIntents: { retrieve } });
    assert.equal(ticket.last4, '4242');
    assert.equal(ticket.applicationPreferredName, null);
  }
})

test('historical receipts with brand and PAN still recover the previously unsaved card type', async () => {
  let calls = 0;
  const stored = { ...session, card_receipt_details: JSON.stringify({ brand: 'visa', last4: '4242',
    applicationPreferredName: 'VISA', dedicatedFileName: 'A0000000031010' }) };
  const ticket = await resolveTerminalCardTicket(stored, null, { paymentIntents: { retrieve: async () => { calls++; return intent; } } });
  assert.equal(calls, 1);
  assert.equal(ticket.funding, 'debit');
})

test('history recovers a confirmed receipt within its shop without changing payment state', async () => {
  const queries = [];
  const module = buildTerminalPaymentHistoryModule({ connection: { query: async (sql, values) => {
    queries.push({ sql, values });
    return [[values[0] === 7 && values[1] === 81 ? session : null].filter(Boolean)];
  } }, stripe: { paymentIntents: { retrieve: async () => intent } } });
  const ticket = await module.getCardTicket({ shopId: 7, paymentId: 81 });
  assert.equal(ticket.last4, '4242');
  assert.equal(ticket.terminalPaymentId, 81);
  await assert.rejects(() => module.getCardTicket({ shopId: 8, paymentId: 81 }));
  assert(queries.every(q => /^SELECT/.test(q.sql)));
})

test('webhooks save receipt details even when Stripe delivers only a charge id', async () => {
  let finalized;
  const store = { findPaymentSession: async () => ({ ...session, status: 'processing' }),
    finalizeStandalonePaymentSucceeded: async values => { finalized = values; return { finalized: true }; } };
  const handle = buildStripeTerminalWebhookHandler({ terminalStore: { withTransaction: work => work(store) },
    stripe: { paymentIntents: { retrieve: async () => intent } } });
  await handle({ type: 'payment_intent.succeeded', created: 1793534400,
    data: { object: { ...intent, metadata: { ...intent.metadata, payment_kind: 'standalone' }, latest_charge: 'ch_receipt' } } });
  const card = JSON.parse(finalized.cardReceiptDetails);
  assert.equal(card.brand, 'visa');
  assert.equal(card.last4, '4242');
  assert.equal(card.applicationPreferredName, 'VISA');
});

test('receipt history endpoint requires history access and uses the authenticated shop', async () => {
  const calls = [];
  const controller = buildTerminalPaymentHistoryController({ historyStore: { getCardTicket: async input => { calls.push(input); return { terminalPaymentId: 81 }; } } });
  const response = () => ({ status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
  const denied = response();
  await controller.getCardTicket({ params: { id: '81' }, shopid: 7, id: 11, access: 1, sessionSubject: 'staff',
    currentUser: { id: 11, shopid: 7, access: 1, status: 1, module_permissions: ['cashregister'] } }, denied);
  assert.equal(denied.code, 403);
  assert.equal(calls.length, 0);
  const allowed = response();
  await controller.getCardTicket({ params: { id: '81' }, shopid: 7, id: 11, access: 0, sessionSubject: 'staff' }, allowed);
  assert.equal(allowed.code, 200);
  assert.deepEqual(calls[0], { paymentId: '81', shopId: 7, userId: 11 });
});
