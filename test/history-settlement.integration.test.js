const assert = require('node:assert/strict');
const { test } = require('node:test');
const { withDeliveryDatabase } = require('./helpers/deliveryDatabase');
const { buildCashRegisterSettlementModule } = require('../src/modules/m_cashRegisterSettlements');
const { buildTerminalPaymentHistoryModule } = require('../src/modules/m_terminalPaymentHistory');

test('MySQL mixed history preserves legacy/new Unicode collations, groups, TPE, sorting and tenants', { skip: !process.env.DELIVERY_TEST_DATABASE_URL && 'explicit local disposable MySQL required; application credentials are never used' }, async () => {
await withDeliveryDatabase(async ({ pool, seedScenario }) => {
  await seedScenario();
  await pool.query('UPDATE users SET username=? WHERE id=10', ['Zoé']);
  const store = buildCashRegisterSettlementModule({ connection: pool });
  const makeGroup = shopid => store.insertSettlement({ shopid, service_point_id: null,
    table_reference: `Table Étoile ${shopid} 🍽`, payment_method: 'Especes', subtotal_before_discount: 25,
    discount_type: 'none', discount_value: 0, discount_amount: 0, total_amount: 25,
    stripe_terminal_payment_id: null, idempotency_key: `isolated-sql-${shopid}`,
    request_fingerprint: 'a'.repeat(64), created_by_user_id: shopid === 7 ? 10 : 12 });
  const own = await makeGroup(7);
  const foreign = await makeGroup(8);
  const [[source]] = await pool.query('SELECT * FROM archives WHERE id=32');
  await pool.query('UPDATE archives SET cash_register_settlement_id=?,subtotal=15 WHERE id=32', [own.id]);
  const child = { ...source, ordernumber: 'SECONDARY-GROUP-CHILD', customer: 'Élodie', subtotal: 10,
    cash_register_settlement_id: own.id, token: 'private-group-token' };
  delete child.id;
  await pool.query('INSERT INTO archives SET ?', [child]);
  await pool.query('INSERT INTO archives SET ?', [{ ...child, ordernumber: 'ORDINARY-FIXTURE',
    subtotal: 9, cash_register_settlement_id: null, token: 'private-order-token' }]);
  await pool.query('INSERT INTO archives SET ?', [{ ...child, shopid: 8, customerID: 12, operator: 12,
    ordernumber: 'FOREIGN-FIXTURE', subtotal: 25, cash_register_settlement_id: foreign.id }]);
  await pool.query('INSERT INTO stripe_terminal_payments SET ?', [{
    shopid: 7, terminal_reader_id: 21, cashier_user_id: 10, payment_kind: 'standalone',
    idempotency_key: 'isolated-sql-tpe', stripe_connected_account_id: 'acct_fixture',
    amount_cents: 1000, application_fee_amount: 0, currency: 'eur', status: 'succeeded',
    reader_label: 'Comptoir Étoilé 🍽',
  }]);
  const history = buildTerminalPaymentHistoryModule({ connection: pool });
  const result = await history.listEntries({ shopId: 7 });
  assert.equal(result.total, 3);
  const group = result.items.find(row => row.entryType === 'settlement');
  assert.equal(group.id, Number(own.id));
  assert.equal(group.subtotal, 25);
  assert.equal(group.archivedOrders.length, 2);
  assert.equal(group.archivedOrders.reduce((sum, row) => sum + Number(row.subtotal), 0), 25);
  assert(group.archivedOrders.every(row => !Object.hasOwn(row, 'token')));
  assert(!JSON.stringify(result).includes('FOREIGN-FIXTURE'));
  assert(result.items.some(row => row.entryType === 'terminal_payment' && row.taken_by_name === 'Zoé'));
  for (const sortBy of ['ordernumber', 'username', 'taken_by_name', 'prepared_by_name', 'customer', 'payment_status', 'status', 'subtotal', 'eventAt']) {
    for (const sortDesc of [false, true]) {
      const sorted = await history.listEntries({ shopId: 7, sortBy, sortDesc });
      assert.equal(sorted.total, 3);
      assert.equal(new Set(sorted.items.map(row => row.rowKey)).size, 3);
      if (sortBy === 'subtotal') assert.deepEqual(sorted.items.map(row => Number(row.subtotal)), sortDesc ? [25, 10, 9] : [9, 10, 25]);
    }
  }
  const accented = await history.listEntries({ shopId: 7, search: 'Table Étoile' });
  assert.equal(accented.total, 1);
  assert.equal(accented.items[0].id, Number(own.id));
  const first = await history.listEntries({ shopId: 7, page: 1, itemsPerPage: 1 });
  const second = await history.listEntries({ shopId: 7, page: 2, itemsPerPage: 1 });
  assert.equal(first.total, 3);
  assert.equal(second.total, 3);
  assert.notEqual(first.items[0].rowKey, second.items[0].rowKey);
  const search = await history.listEntries({ shopId: 7, search: 'SECONDARY-GROUP-CHILD' });
  assert.equal(search.total, 1);
  assert.equal(search.items[0].archivedOrders.length, 2);
  const other = await history.listEntries({ shopId: 8 });
  assert.equal(other.total, 1);
  assert.equal(other.items[0].id, Number(foreign.id));
  console.log('INTEGRATION_SQL=' + JSON.stringify({ actualMySql: true, migrations: true,
    groupedHistory: true, pagination: true, childSearch: true, tenantIsolation: true, privateTokensOmitted: true, unicodeSorts: true }));
});
});
