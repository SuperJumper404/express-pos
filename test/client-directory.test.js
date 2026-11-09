const assert = require('assert/strict');
const { test } = require('node:test');
const { buildClientDirectory, selectClientRows, clientDirectoryCsv, clientPhoneKey } = require('../src/helpers/clientDirectory');
const customer = (id, data = {}) => ({ id, shopid: 7, name: '', contact_phone: '', contact_email: '', ...data });
const archive = (id, data = {}) => ({ id, shopid: 7, customer: 'Alice', phone: '06 12 34 56 78', subtotal: '8.00', created: '2026-11-01T12:00:00Z', ...data });
const identity = (id, phone) => ({ shopid: 7, customer_id: id, channel: 'sms', destination: phone, verified_at: '2026-10-01T12:00:00Z' });
const build = data => buildClientDirectory({ shopId: 7, now: new Date('2026-11-06T12:00:00Z'), canManageLoyalty: true, ...data });

test('one account includes its card, explicit and uniquely matched historical purchases', () => {
  const result = build({ customers: [customer('9007199254740993', { name: 'Alice' }), customer('9', { name: 'Sans achat' })],
    identities: [identity('9007199254740993', '+33612345678')],
    members: [{ id: 'card-1', shopid: 7, customer_id: '9007199254740993', balance: 50, reserved: 10 }],
    archives: [archive(1), archive(2, { customer_account_id: '9007199254740993', phone: '555', subtotal: '12.00' })] });
  assert.equal(result.rows.length, 2);
  const row = result.rows.find(value => value.id === '9007199254740993');
  assert.equal(row.orderCount, 2);
  assert.equal(row.totalSpent, 20);
  assert.equal(row.averageSpent, 10);
  assert.deepEqual(row.loyalty, { id: 'card-1', cardNumber: null, balance: 50, reserved: 10, available: 40 });
  assert.equal(row.verified, true);
  assert.equal(result.metrics.clientCount, 2);
  assert.equal(result.rows.find(value => value.id === '9').orderCount, 0);
});
test('invalid historical phones are retained; valid formats group together, anonymous purchases do not become clients', () => {
  const result = build({ archives: [archive(1), archive(2, { phone: '+33 6 12 34 56 78' }), archive(3, { phone: '555' }), archive(4, { phone: '' })] });
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows.find(row => row.phone === '555').orderCount, 1);
  assert.equal(result.rows.find(row => row.phone !== '555').orderCount, 2);
  assert.equal(result.metrics.ordersWithoutPhone, 1);
  assert.equal(clientPhoneKey('06.12.34.56.78'), '+33612345678');
});
test('ambiguous phones and names never choose an account', () => {
  const result = build({ customers: [customer('1', { name: 'Alice' }), customer('2', { name: 'Alice' })],
    identities: [identity('1', '+33612345678'), identity('2', '+33612345678')], archives: [archive(1)] });
  const history = result.rows.find(row => row.source === 'historical');
  assert.equal(result.rows.length, 3);
  assert.equal(history.reconciliation.status, 'ambiguous');
  assert.deepEqual(history.reconciliation.candidateIds, ['1', '2']);
  assert.equal(result.rows.find(row => row.id === '1').orderCount, 0);
});
test('a verified account appearing after import absorbs only an unprotected historical alias in the directory', () => {
  const first = build({ archives: [archive(1)] });
  const key = first.contacts[0].contactKey;
  const input = { customers: [customer('1', { contact_phone: '0612345678' }), customer('2', { name: 'Compte' })],
    identities: [identity('2', '+33612345678')], archives: [archive(1)],
    links: [{ shopid: 7, contact_key: key, customer_id: '1', source_customer_id: '1', match_kind: 'import' }] };
  const before = JSON.stringify(input);
  const result = build(input);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].id, '2');
  assert.equal(result.rows[0].orderCount, 1);
  assert.equal(JSON.stringify(input), before);
  const protectedResult = build({ ...input, members: [{ id: 'own-card', shopid: 7, customer_id: '1', balance: 5, reserved: 0 }] });
  assert.equal(protectedResult.rows.length, 2, 'two card/account profiles never merge');
  assert.equal(protectedResult.rows.find(row => row.id === '1').loyalty.balance, 5);
  assert.equal(protectedResult.rows.find(row => row.id === '1').reconciliation.status, 'ambiguous');
  const withActiveOrder = build({ ...input, customers: [customer('1', { has_linked_orders: 1 }), customer('2')] });
  assert.equal(withActiveOrder.rows.length, 2, 'a profile with a live explicitly linked order is also protected');
});
test('explicit attribution wins over phone matching and cross-restaurant data is excluded', () => {
  const result = build({ customers: [customer('1'), customer('2'), customer('3', { shopid: 8 })],
    identities: [identity('2', '+33612345678')], archives: [archive(1, { customer_account_id: '1' }), archive(2, { shopid: 8 })] });
  assert.equal(result.rows.find(row => row.id === '1').orderCount, 1);
  assert.equal(result.rows.find(row => row.id === '2').orderCount, 0);
  assert.equal(result.rows.length, 2);
});
test('non-admin directory omits every loyalty field and filters respect the full result', () => {
  const input = { customers: [customer('1', { name: '=SUM(1)' }), customer('2', { name: 'Bob' })],
    members: [{ id: 'card-1', shopid: 7, customer_id: '1', balance: 12, reserved: 0 }] };
  const result = build(input);
  assert.equal(selectClientRows(result.rows, { filter: 'members', q: 'SUM' }).length, 1);
  assert.equal(selectClientRows(result.rows, { q: 'Bob' })[0].id, '2');
  assert.ok(clientDirectoryCsv(result.rows).includes("'=SUM(1)"), 'spreadsheet formula text is escaped');
  assert.equal(Object.hasOwn(build({ ...input, canManageLoyalty: false }).rows[0], 'loyalty'), false);
});

test('internal profile ownership groups orders, protects aliases and never overrides authenticated ownership', () => {
  const result = build({ customers: [customer('1'), customer('2')], archives: [archive(1, { customer_profile_id: '1' }), archive(2, { customer_account_id: '2', customer_profile_id: '1' }), archive(3, { customer_profile_id: '999' })] });
  assert.equal(result.rows.find(row => row.id === '1').orderCount, 1);
  assert.equal(result.rows.find(row => row.id === '2').orderCount, 1);
  assert.equal(result.contacts.length, 0);
  const key = build({ archives: [archive(1)] }).contacts[0].contactKey;
  const protectedResult = build({ customers: [customer('1'), customer('2')], archives: [archive(1, { customer_profile_id: '1' })], identities: [identity('2', '+33612345678')], links: [{ shopid: 7, contact_key: key, customer_id: '1', source_customer_id: '1', match_kind: 'import' }] });
  assert.equal(protectedResult.rows.length, 2);
  assert.equal(protectedResult.contacts[0].status, 'ambiguous');
});
