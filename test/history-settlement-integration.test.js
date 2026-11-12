const assert = require('assert/strict');
const test = require('node:test');
const { buildTerminalPaymentHistoryModule } = require('../src/modules/m_terminalPaymentHistory');

const fixture = ({ totalAmount = '25.00' } = {}) => {
  const calls = [];
  const connection = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (/COUNT\(\*\) AS total/.test(sql)) return [[{ total: 3 }]];
    if (/UNION ALL/.test(sql)) return [[
      { id: 123, entry_type: 'settlement', event_at: '2026-11-12 12:00:00' },
      { id: 123, entry_type: 'order', event_at: '2026-11-12 11:00:00' },
      { id: 123, entry_type: 'terminal_payment', event_at: '2026-11-12 10:00:00' },
    ]];
    if (/FROM cash_register_settlements s/.test(sql)) return [[{
      id: '123', shopid: 7, table_reference: 'Table 9', total_amount: totalAmount,
      payment_method: 'Especes', created_at: '2026-11-12 12:00:00',
    }]];
    if (/FROM archives a/.test(sql)) return [/cash_register_settlement_id IN/.test(sql) ? [
      { id: '201', shopid: 7, cash_register_settlement_id: '123', subtotal: '15.00', ordernumber: 'A201',
        client_order_token: 'private-client-token', token: 'private-receipt-token', phone: '+33612345678' },
      { id: '202', shopid: 7, cash_register_settlement_id: '123', subtotal: '10.00', ordernumber: 'A202' },
    ] : [{ id: 123, shopid: 7, subtotal: '9.00', ordernumber: 'A123' }]];
    if (/FROM stripe_terminal_payments p/.test(sql)) return [[{
      id: 123, shopid: 7, payment_kind: 'standalone', amount_cents: 800,
      currency: 'eur', status: 'succeeded', terminal_reader_id: 21,
      cashier_user_id: 11, created_at: '2026-11-12 10:00:00', attachments_count: 0,
    }]];
    throw new Error('Unexpected query');
  } };
  return { calls, module: buildTerminalPaymentHistoryModule({ connection }) };
};

test('history keeps one complete settlement before pagination alongside colliding order and TPE IDs', async () => {
  const f = fixture();
  const result = await f.module.listEntries({ shopId: 7, page: 2, itemsPerPage: 3, search: 'Table 9' });
  assert.equal(result.total, 3);
  assert.deepEqual(result.items.map(row => row.rowKey), ['settlement:123', 'order:123', 'terminal-payment:123']);
  const group = result.items[0];
  assert.equal(group.id, 123);
  assert.equal(group.entryType, 'settlement');
  assert.equal(group.isSettlement, true);
  assert.equal(group.cash_register_settlement_id, 123);
  assert.equal(group.historyLabel, 'Encaissement table Table 9');
  assert.equal(group.subtotal, 25);
  assert.equal(group.payment_status, 'paid');
  assert.deepEqual(group.archivedOrders.map(row => [row.id, row.cash_register_settlement_id, row.subtotal]),
    [[201, 123, '15.00'], [202, 123, '10.00']]);
  for (const child of group.archivedOrders) {
    assert.equal(child.client_order_token, undefined);
    assert.equal(child.token, undefined);
    assert.equal(child.phone, undefined);
  }
  const page = f.calls.find(call => /UNION ALL/.test(call.sql) && !/COUNT\(\*\) AS total/.test(call.sql));
  assert.match(page.sql, /a\.cash_register_settlement_id IS NULL/);
  assert.match(page.sql, /FROM cash_register_settlements s/);
  assert.match(page.sql, /s\.shopid = \?/);
  assert.match(page.sql, /EXISTS/);
  assert.deepEqual(page.values.slice(-2), [3, 3]);
  assert.equal(page.values.filter(value => value === '%Table 9%').length, 3);
  const children = f.calls.find(call => /cash_register_settlement_id IN/.test(call.sql));
  assert.match(children.sql, /a\.shopid = \?/);
  assert.match(children.sql, /COALESCE\(a.hidden_from_history, 0\) = 0/);
  assert.deepEqual(children.values, [7, 123]);
  for (const call of f.calls) assert.doesNotMatch(call.sql, /Table 9/);
});

test('history rejects corrupt stored settlement amounts instead of emitting a false financial total', async () => {
  for (const totalAmount of ['not-money', '-1.00', null]) {
    await assert.rejects(() => fixture({ totalAmount }).module.listEntries({ shopId: 7 }),
      { code: 'TERMINAL_INTERNAL_ERROR' });
  }
});
