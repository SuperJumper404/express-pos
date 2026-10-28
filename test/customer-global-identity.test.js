const assert = require('node:assert/strict');
const { test } = require('node:test');
const { linkVerifiedCustomerIdentity } = require('../src/helpers/customerGlobalIdentity');

const fixture = () => {
  const customers = new Map([['1:11', null], ['2:22', null]]);
  const identities = new Map();
  const connection = { async query(sql, args) {
    if (sql.startsWith('SELECT global_customer_id')) return [[{ global_customer_id: customers.get(`${args[0]}:${args[1]}`) }]];
    if (sql.startsWith('SELECT account_id')) return [[identities.get(`${args[0]}:${args[1]}`)].filter(Boolean)];
    if (sql.startsWith('INSERT INTO customer_accounts')) return [{ affectedRows: 1 }];
    if (sql.startsWith('INSERT INTO customer_account_identities')) { identities.set(`${args[0]}:${args[1]}`, { account_id: args[2] }); return [{ affectedRows: 1 }]; }
    if (sql.startsWith('UPDATE customers')) { customers.set(`${args[1]}:${args[2]}`, args[0]); return [{ affectedRows: 1 }]; }
    throw new Error(sql);
  } };
  return { connection, customers, identities };
};
test('verified logins link two restaurant profiles to one stable global identity', async () => {
  const f = fixture();
  const a = await linkVerifiedCustomerIdentity({ connection: f.connection, shopId: 1, customerId: '11', channel: 'sms', destination: '+33612345678' });
  const b = await linkVerifiedCustomerIdentity({ connection: f.connection, shopId: 2, customerId: '22', channel: 'sms', destination: '+33612345678' });
  assert.equal(a, b);
  assert.equal(f.customers.get('1:11'), f.customers.get('2:22'));
});
test('linking a contact already attached to another account requires explicit recovery', async () => {
  const f = fixture();
  f.customers.set('1:11', 'account-a');
  f.identities.set('phone:+33612345678', { account_id: 'account-b' });
  await assert.rejects(linkVerifiedCustomerIdentity({ connection: f.connection, shopId: 1, customerId: '11', channel: 'sms', destination: '+33612345678' }), { code: 'CUSTOMER_IDENTITY_CONFLICT' });
  assert.equal(f.customers.get('1:11'), 'account-a');
});
