const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildLoyalty, buildSqlLoyaltyRepository } = require('../src/modules/m_loyalty');
const { normalizeProgram } = require('../src/helpers/loyalty');
let identity = {};
try { identity = require('../src/helpers/loyaltyIdentity'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

test('card and phone lookup preserve exact normalized identities', () => {
  assert.equal(typeof identity.normalizeLoyaltyLookup, 'function');
  assert.deepEqual(identity.normalizeLoyaltyLookup({ kind: 'card', value: '0001 2345-6789 0123' }), { kind: 'card', value: '0001234567890123' });
  assert.deepEqual(identity.normalizeLoyaltyLookup({ kind: 'phone', value: '06 12 34 56 78', countryCode: 'FR' }), { kind: 'phone', value: '+33612345678' });
  assert.deepEqual(identity.normalizeLoyaltyLookup({ qr: 'a'.repeat(64) }), { kind: 'qr', value: 'a'.repeat(64) });
  for (const input of [{ kind: 'phone', value: '123' }, { kind: 'card', value: '123' }, { qr: 'a'.repeat(64), kind: 'phone', value: '+33612345678' }, { kind: 'qr', value: 'z'.repeat(64) }]) {
    assert.throws(() => identity.normalizeLoyaltyLookup(input));
  }
  assert.match(identity.generateCardNumber(), /^\d{16}$/);
});

function fixture() {
  const members = [
    { id: 'one', shopid: 7, customer_id: '10', qr: 'a'.repeat(64), card_number: '0001234567890123', balance: 50, reserved: 10, revision: 1 },
    { id: 'two', shopid: 8, customer_id: '20', qr: 'b'.repeat(64), card_number: '0001234567890123', balance: 90, reserved: 0, revision: 1 },
  ];
  const program = normalizeProgram({ enabled: true });
  const repository = {
    lockShop: async () => {}, program: async () => ({ config: program, version: 1 }), history: async () => [{ reason: 'private history' }],
    member: async ({ shopId, memberId, customerId, qr, cardNumber }) => members.find(m => m.shopid === shopId && (memberId ? m.id === memberId : customerId ? m.customer_id === customerId : cardNumber ? m.card_number === cardNumber : m.qr === qr)),
    lookupMembers: async ({ shopId, kind, value }) => members.filter(m => m.shopid === shopId && (kind === 'phone' ? value === '+33612345678' : kind === 'card' ? value === m.card_number : value === m.qr)),
    setCardNumber: async ({ memberId, cardNumber }) => { members.find(m => m.id === memberId).card_number = cardNumber; },
  };
  return { members, repository, service: buildLoyalty({ repository, runInTransaction: work => work({}) }) };
}

test('lookup finds only enrolled members of the selected restaurant and returns a reduced kiosk view', async () => {
  const f = fixture();
  const result = await f.service.lookup({ shopId: 7, kind: 'phone', value: '+33612345678', audience: 'kiosk' });
  assert.equal(result.id, 'one'); assert.equal(result.available, 40); assert.equal(result.cardNumber, '0001234567890123');
  assert.equal(result.history, undefined); assert.equal(result.qr, undefined); assert.equal(result.customerId, undefined);
  assert.equal((await f.service.lookup({ shopId: 8, kind: 'card', value: '0001 2345 6789 0123' })).id, 'two');
  await assert.rejects(f.service.lookup({ shopId: 9, kind: 'phone', value: '+33612345678' }), { code: 'LOYALTY_NOT_FOUND' });
  await assert.rejects(f.service.lookup({ shopId: 7, kind: 'phone', value: '+33698765432' }), { code: 'LOYALTY_NOT_FOUND' });
  f.repository.lookupMembers = async () => f.members;
  await assert.rejects(f.service.lookup({ shopId: 7, kind: 'phone', value: '+33612345678' }), { code: 'LOYALTY_LOOKUP_AMBIGUOUS' });
  assert.equal(f.members.length, 2);
});

test('legacy cards receive a stable card number without changing points or QR and collision retries are bounded', async () => {
  const f = fixture(); f.members[0].card_number = null;
  let attempts = 0;
  f.repository.setCardNumber = async ({ cardNumber }) => {
    if (++attempts < 3) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
    f.members[0].card_number = cardNumber;
  };
  assert.equal(typeof f.service.ensureCardNumber, 'function');
  const cardNumber = await f.service.ensureCardNumber({ connection: {}, shopId: 7, memberId: 'one' });
  assert.match(cardNumber, /^\d{16}$/); assert.equal(attempts, 3);
  assert.equal(await f.service.ensureCardNumber({ connection: {}, shopId: 7, memberId: 'one' }), cardNumber);
  assert.equal(f.members[0].balance, 50); assert.equal(f.members[0].qr, 'a'.repeat(64));
  f.members[0].card_number = null; attempts = 0;
  f.repository.setCardNumber = async () => { attempts++; throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' }); };
  await assert.rejects(f.service.ensureCardNumber({ connection: {}, shopId: 7, memberId: 'one' }));
  assert.equal(attempts, 8);
});

test('SQL phone lookup joins verified identities and never searches free contact phone fields', async () => {
  const queries = [];
  const repository = buildSqlLoyaltyRepository();
  assert.equal(typeof repository.lookupMembers, 'function');
  await repository.lookupMembers({ shopId: 7, kind: 'phone', value: '+33612345678', connection: { query: async (sql, params) => { queries.push({ sql, params }); return [[]]; } } });
  assert.match(queries[0].sql, /customer_identities/); assert.match(queries[0].sql, /customer_account_identities/);
  assert.doesNotMatch(queries[0].sql, /contact_phone\s*(?:=|LIKE)/i);
  assert(queries[0].params.includes(7)); assert(queries[0].params.includes('+33612345678'));
});

test('kiosk access is limited to active kiosks and lookup quotas reject the 31st kiosk request', async () => {
  let access = {};
  try { access = require('../src/helpers/middleware/loyaltyAccess'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  assert.equal(typeof access.buildLoyaltyAccess, 'function');
  let count = 0;
  const guard = access.buildLoyaltyAccess({ findServicePoint: async ({ shopId, servicePointId }) => ({ id: servicePointId, shopid: shopId, type: 'kiosk', is_active: 1 }), consumeQuota: async () => ++count });
  const req = { sessionSubject: 'service_point', orderSource: 'borne', servicePointId: 5, shopid: 7 };
  assert.equal((await guard.kioskScope(req)).shopId, 7);
  await assert.rejects(guard.kioskScope({ ...req, orderSource: 'web' }), { status: 403 });
  for (let i = 0; i < 30; i++) await guard.lookupQuota({ shopId: 7, actorKey: 'kiosk:5', audience: 'kiosk' });
  await assert.rejects(guard.lookupQuota({ shopId: 7, actorKey: 'kiosk:5', audience: 'kiosk' }), { status: 429, code: 'LOYALTY_RATE_LIMITED' });
  count = 0;
  for (let i = 0; i < 60; i++) await guard.lookupQuota({ shopId: 7, actorKey: 'staff:2', audience: 'staff' });
  await assert.rejects(guard.lookupQuota({ shopId: 7, actorKey: 'staff:2', audience: 'staff' }), { status: 429 });
});
