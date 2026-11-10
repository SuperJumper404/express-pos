const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCashClosureSnapshot } = require('../src/helpers/cashClosure');
const { buildCashReconciliation, validateCashDeclaration } = require('../src/helpers/cashReconciliation');
const { mGetStandaloneReportPayments, standalonePaymentSummary } = require('../src/modules/m_terminalReports');

const payment = { id: 81, amount_cents: 1250, confirmed_at: '2026-11-10 12:00:00.000000' };

test('standalone-only snapshot includes money without inventing orders or VAT', () => {
  const snapshot = buildCashClosureSnapshot({ archivedOrders: [], detailRows: [],
    standalonePayments: [payment], now: '2026-11-10 13:00:00.000000' });
  assert.equal(snapshot.total_revenue, 12.5);
  assert.equal(snapshot.orders_count, 0);
  assert.equal(snapshot.opened_at, payment.confirmed_at);
  assert.deepEqual(snapshot.standalone_terminal_summary, { count: 1, total: 12.5 });
  assert.deepEqual(snapshot.payments_summary, [{ payment: 'TPE Stripe', orders_count: 0, total: 12.5 }]);
  assert.deepEqual(snapshot.vat_summary, []);
});

test('order TPE and autonomous receipts merge without counting attachments as receipts', () => {
  const snapshot = buildCashClosureSnapshot({ archivedOrders: [{ id: 5, subtotal: 20,
    payment_provider: 'stripe_terminal', archived_at: '2026-11-10 12:01:00' }], detailRows: [],
    standalonePayments: [payment, payment, { ...payment, id: 82, amount_cents: 1 }], now: '2026-11-10 13:00:00' });
  assert.equal(snapshot.total_revenue, 32.51);
  assert.equal(snapshot.orders_count, 1);
  assert.deepEqual(snapshot.standalone_terminal_summary, { count: 2, total: 12.51 });
  assert.deepEqual(snapshot.payments_summary, [{ payment: 'TPE Stripe', orders_count: 1, total: 32.51 }]);
  assert.deepEqual(standalonePaymentSummary([]), { count: 0, total: 0 });
});

test('declared money accepts zero but rejects partial, negative and fractional cents', () => {
  assert.equal(validateCashDeclaration(undefined), null);
  assert.deepEqual(validateCashDeclaration({ declared_cash_cents: 0, declared_card_cents: 1234 }),
    { declared_cash_cents: 0, declared_card_cents: 1234 });
  for (const value of [null, {}, { declared_cash_cents: 1 }, { declared_cash_cents: -1, declared_card_cents: 0 },
    { declared_cash_cents: 1.5, declared_card_cents: 0 }, { declared_cash_cents: '', declared_card_cents: 0 },
    { declared_cash_cents: 0, declared_card_cents: '10' }, { declared_cash_cents: Number.MAX_SAFE_INTEGER + 1, declared_card_cents: 0 }]) {
    assert.throws(() => validateCashDeclaration(value), error => error.statusCode === 422);
  }
});

test('cash reconciliation follows physical register movements and excludes online card revenue', () => {
  const snapshot = { payments_summary: [{ payment: 'Espèces', total: 100 }, { payment: 'Carte bancaire', total: 20 },
    { payment: 'TPE Stripe', total: 12.5 }, { payment: 'Stripe', total: 90 }],
  courier_cash: { register_cash_sales_cents: 6000, received_cents: 1500, cash_refunded_by_register_cents: 1000 } };
  assert.deepEqual(buildCashReconciliation(snapshot, { declared_cash_cents: 6400, declared_card_cents: 3300 }), {
    expected_cash_cents: 6500, expected_card_cents: 3250,
    declared_cash_cents: 6400, declared_card_cents: 3300,
    cash_difference_cents: -100, card_difference_cents: 50,
  });
  const current = buildCashReconciliation(snapshot);
  assert.equal(current.declared_cash_cents, null);
  assert.equal(current.cash_difference_cents, null);
  assert.equal(buildCashReconciliation({ payments_summary: [{ payment: 'Espèces', total: 10 }] }).expected_cash_cents, 1000);
});

test('reader scopes succeeded autonomous receipts, with no attachment join and exclusive day end', async () => {
  const calls = [];
  const connection = { query: async (sql, values) => { calls.push({ sql, values }); return [[payment]]; } };
  assert.deepEqual(await mGetStandaloneReportPayments({ shopId: 7, from: '2026-11-10', to: '2026-11-10', connection }), [payment]);
  assert.match(calls[0].sql, /payment_kind = 'standalone'/);
  assert.match(calls[0].sql, /status = 'succeeded'/);
  assert.doesNotMatch(calls[0].sql, /JOIN|attachments/);
  assert.deepEqual(calls[0].values, [7, '2026-11-10', '2026-11-10']);
  assert.match(calls[0].sql, /INTERVAL 1 DAY/);
  await mGetStandaloneReportPayments({ shopId: 7, unclosed: true, closedAt: '2026-11-10 13:00:00', connection });
  assert.match(calls[1].sql, /cash_closure_id IS NULL/);
  assert.doesNotMatch(calls[1].sql, /confirmed_at[^\n]* > /);
});
