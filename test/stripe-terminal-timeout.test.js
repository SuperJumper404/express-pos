const assert = require('assert');
const { buildStripeTerminalModule } = require('../src/modules/m_stripeTerminal');

(async () => {
  const { cardWaitExpired } = require('../src/helpers/terminalCardWait');
  assert.strictEqual(cardWaitExpired({ card_wait_started_at: new Date(0) }, 11999), false);
  assert.strictEqual(cardWaitExpired({ card_wait_started_at: new Date(0) }, 12000), true);
  for (const started of [null, undefined, 'invalid']) {
    assert.strictEqual(cardWaitExpired({ card_wait_started_at: started }, 12000), false);
  }
  const { standalonePaymentDto } = require('../src/helpers/standaloneTerminalPayment');
  assert.strictEqual(standalonePaymentDto({ id: 41, terminal_reader_id: 21, reader_label: 'Comptoir',
    status: 'processing', created_at: new Date(), amount_cents: 500, currency: 'eur' }).readerLabel, 'Comptoir');
  const calls = [];
  const store = buildStripeTerminalModule({ connection: { query: async (sql, params) => {
    calls.push({ sql, params }); return [{ affectedRows: 1 }];
  } } });
  await store.updatePaymentSession({ shopId: 7, paymentId: 41, cardWaitStartedAt: new Date(0) });
  assert.match(calls[0].sql, /card_wait_started_at = COALESCE\(card_wait_started_at, \?\)/);
  await store.createStandalonePaymentSession({ shopId: 7, readerId: 21, cashierUserId: 11,
    idempotencyKey: 'attempt', connectedAccountId: 'acct', amountCents: 500, applicationFeeAmount: 1 });
  assert.match(calls[1].sql, /reader_label/);
  assert.match(calls[1].sql, /r\.label/);
  await store.listExpiredCardWaitPayments({ now: new Date(12000) });
  assert.match(calls[2].sql, /card_wait_started_at <= \?/);
  assert.deepStrictEqual(calls[2].params, [new Date(0), new Date(-18000)]);
  const { buildStripeTerminalMaintenance } = require('../src/services/stripeTerminalMaintenance');
  const maintained = [];
  const run = buildStripeTerminalMaintenance({ terminalStore: { listExpiredCardWaitPayments: async () => [
    { id: 1, cashier_user_id: 11 }, { id: 2, cashier_user_id: 0 }, { id: 3, cashier_user_id: 12 },
  ] }, paymentService: { maintainPayment: async row => { maintained.push(row.id); if (row.id === 1) throw new Error('unavailable'); } },
  kioskPaymentService: { maintainPayment: async row => maintained.push(row.id) }, logger: { error: () => {} } });
  await run();
  assert.deepStrictEqual(maintained, [1, 2, 3], 'One unavailable terminal must not stop the other deadlines');
  console.log('Terminal card wait storage and background maintenance: passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
