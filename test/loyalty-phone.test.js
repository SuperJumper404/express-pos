const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildLoyalty } = require('../src/modules/m_loyalty');
const { normalizeProgram } = require('../src/helpers/loyalty');
let phoneSessions = {};
try { phoneSessions = require('../src/helpers/loyaltyPhoneSession'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

function fixture() {
  const members = [], customers = [], jobs = [];
  const program = normalizeProgram({ enabled: true });
  let queue = Promise.resolve();
  const repository = {
    lockShop: async () => {}, program: async () => ({ config: program, version: 1 }),
    lookupMembers: async ({ shopId, value }) => members.filter(m => m.shopid === shopId && m.phone_e164 === value),
    createPhoneCustomer: async ({ shopId, phone }) => { const id = String(customers.length + 1); customers.push({ id, shopId, phone }); return id; },
    member: async ({ shopId, memberId, customerId }) => members.find(m => m.shopid === shopId && (memberId ? m.id === memberId : m.customer_id === customerId)),
    insertMember: async ({ connection, ...member }) => { members.push(member); },
    setCardNumber: async ({ memberId, cardNumber }) => { members.find(m => m.id === memberId).card_number = cardNumber; },
    setMarketingConsent: async ({ memberId, marketingConsent }) => { members.find(m => m.id === memberId).marketing_consent = Number(marketingConsent); },
    enqueue: async input => { jobs.push(input); }, history: async () => [],
  };
  const runInTransaction = work => { const pending = queue.then(() => work({})); queue = pending.catch(() => {}); return pending; };
  return { members, customers, jobs, program, repository, service: buildLoyalty({ repository, runInTransaction }) };
}

test('phone-only enrolment creates one card for normalized concurrent numbers and is searchable at POS', async () => {
  const f = fixture(); assert.equal(typeof f.service.enrollPhone, 'function');
  const [first, reopened] = await Promise.all(['06 12 34 56 78', '+33612345678'].map(phone => f.service.enrollPhone({ shopId: 7, phone, countryCode: 'FR', marketingConsent: true })));
  assert.equal(first.member.id, reopened.member.id); assert.match(first.member.cardNumber, /^\d{16}$/);
  assert.equal(f.customers.length, 1); assert.equal(f.members.length, 1);
  assert.equal(f.customers[0].phone, '+33612345678'); assert.equal(f.members[0].phone_e164, '+33612345678');
  assert.equal((await f.service.lookup({ shopId: 7, kind: 'phone', value: '0612345678', audience: 'staff' })).id, first.member.id);
  const other = await f.service.enrollPhone({ shopId: 8, phone: '0612345678' }); assert.notEqual(other.member.id, first.member.id);
  await assert.rejects(f.service.enrollPhone({ shopId: 7, phone: 'someone@example.test' }), { status: 422 });
});

test('reopening an existing phone preserves points and a refused marketing consent', async () => {
  const f = fixture(); assert.equal(typeof f.service.enrollPhone, 'function');
  const first = await f.service.enrollPhone({ shopId: 7, phone: '0612345678' });
  f.members[0].balance = 45; f.members[0].marketing_consent = 0;
  const reopened = await f.service.enrollPhone({ shopId: 7, phone: '+33612345678', marketingConsent: true });
  assert.equal(reopened.member.id, first.member.id); assert.equal(reopened.member.balance, 45);
  assert.equal(reopened.member.marketingConsent, false); assert.equal(f.customers.length, 1);
  f.repository.lookupMembers = async () => [{ id: 'one' }, { id: 'two' }];
  await assert.rejects(f.service.enrollPhone({ shopId: 7, phone: '0612345678' }), { code: 'LOYALTY_LOOKUP_AMBIGUOUS' });
});

test('loyalty session is scoped, expires, rejects forgery and cannot authenticate a general customer account', async () => {
  assert.equal(typeof phoneSessions.buildLoyaltyPhoneSession, 'function');
  let now = new Date('2026-11-02T00:00:00Z');
  const sessions = phoneSessions.buildLoyaltyPhoneSession({ secret: 'p'.repeat(64), allowedOrigins: ['https://staging.smarteat.fr'], clock: () => now });
  const issued = sessions.create({ shopId: 7, customerId: '9007199254740993', memberId: '00000000-0000-4000-8000-000000000007' });
  const read = sessions.read({ rawToken: issued.rawToken, shopId: 7 });
  assert.equal(read.subject, 'loyalty'); assert.equal(read.customerId, '9007199254740993');
  assert.equal(sessions.read({ rawToken: issued.rawToken, shopId: 8 }), null);
  assert.equal(sessions.read({ rawToken: issued.rawToken.slice(0, -1) + '!', shopId: 7 }), null);
  assert(sessions.verifyCsrf({ session: read, token: issued.session.csrfToken, origin: 'https://staging.smarteat.fr' }));
  assert.equal(sessions.verifyCsrf({ session: read, token: issued.session.csrfToken, origin: 'https://other.test' }), false);
  assert.equal(sessions.verifyCsrf({ session: read, token: '0'.repeat(64), origin: 'https://staging.smarteat.fr' }), false);
  const general = require('../src/helpers/customerSession').buildCustomerSession({ repository: { read: () => { throw new Error('must not read a general account'); } } });
  assert.equal(await general.read({ rawToken: issued.rawToken, shopId: 7 }), null);
  now = new Date('2026-12-03T00:00:00Z'); assert.equal(sessions.read({ rawToken: issued.rawToken, shopId: 7 }), null);
});
