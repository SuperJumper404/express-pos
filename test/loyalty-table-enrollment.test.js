const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildLoyaltyController } = require('../src/controllers/c_loyalty');
let contexts = {};
try { contexts = require('../src/helpers/middleware/loyaltyTableContext'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const response = () => ({ set() {}, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } });
const personal = { customerSession: { shopId: 7, customerId: '10' }, query: { shopId: '7' }, body: {}, headers: {} };

test('table enrollment requires signed table source and an active table in the same restaurant', async () => {
  assert.equal(typeof contexts.buildLoyaltyTableContext, 'function');
  let decoded = { subject_type: 'service_point', source: 'table_qr', shopid: 7, service_point_id: 3 };
  let point = { id: 3, shopid: 7, type: 'table', is_active: 1 };
  const context = contexts.buildLoyaltyTableContext({ verifyToken: () => decoded, findServicePoint: async () => point });
  assert.deepEqual(await context.read({ token: 'signed', shopId: 7 }), { shopId: 7, servicePointId: 3 });
  for (const source of ['borne', 'web']) { decoded.source = source; assert.equal(await context.read({ token: 'signed', shopId: 7 }), null); }
  decoded.source = 'table_qr'; decoded.shopid = 8;
  assert.equal(await context.read({ token: 'signed', shopId: 7 }), null);
  decoded.shopid = 7; point.is_active = 0;
  assert.equal(await context.read({ token: 'signed', shopId: 7 }), null);
  point.is_active = 1; point.type = 'kiosk';
  assert.equal(await context.read({ token: 'signed', shopId: 7 }), null);
  assert.equal(await context.read({ shopId: 7 }), null);
  const expired = contexts.buildLoyaltyTableContext({ verifyToken: () => { throw new Error('expired'); } });
  assert.equal(await expired.read({ token: 'expired', shopId: 7 }), null);
});

test('direct account and Wallet links cannot enroll but existing memberships remain readable', async () => {
  let enrolled = 0;
  const controller = buildLoyaltyController({ loyalty: { enroll: async () => { enrolled++; return { id: 'member' }; }, getMember: async () => ({ id: 'member', balance: 50 }) }, tableContext: { read: async () => null } });
  let res = response(); await controller.enroll(personal, res);
  assert.equal(res.statusCode, 403); assert.equal(enrolled, 0);
  res = response(); await controller.getPersonal(personal, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.data.balance, 50);
});

test('table enrollment forwards optional consent explicitly and preferences need no table context', async () => {
  const received = [];
  const controller = buildLoyaltyController({ loyalty: {
    enroll: async input => { received.push(input); return { id: 'member' }; },
    setMarketingConsent: async input => { received.push(input); return { id: 'member', marketingConsent: input.marketingConsent }; },
  }, tableContext: { read: async ({ token }) => token === 'table' ? { shopId: 7, servicePointId: 3 } : null } });
  const res = response(); await controller.enroll({ ...personal, headers: { 'x-table-session': 'table' } }, res);
  assert.equal(res.statusCode, 200); assert.equal(received[0].marketingConsent, false);
  assert.equal(typeof controller.setPreferences, 'function');
  const pref = response(); await controller.setPreferences({ ...personal, body: { marketingConsent: false } }, pref);
  assert.equal(pref.statusCode, 200); assert.equal(received[1].marketingConsent, false);
  const invalid = response(); await controller.setPreferences({ ...personal, body: { marketingConsent: 'yes' } }, invalid);
  assert.equal(invalid.statusCode, 422);
});
