const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHash } = require('crypto');
const { buildCustomerPhoneService } = require('../src/modules/m_customerPhone');
const { buildCustomerPhoneController } = require('../src/controllers/c_customerPhone');
const key = phone => createHash('sha256').update(phone).digest('hex');
const customer = (id, extra = {}) => ({ id, shopid: 7, name: 'Alice', contact_phone: '06 12 34 56 78', contact_email: 'alice@example.test', ...extra });
const fixture = (extra = {}) => {
  const data = { customers: [], identities: [], members: [], archives: [], links: [], ...extra }, calls = [];
  const repository = {
    lockShop: async scope => { calls.push(['shop', scope]); },
    loadSources: async scope => { calls.push(['sources', scope]); return data; },
    createContact: async scope => { calls.push(['create', scope]); const id = String(100 + data.customers.length); data.customers.push(customer(id, { shopid: scope.shopId, name: scope.name, contact_phone: scope.phone, contact_email: '' })); return id; },
    saveLink: async scope => { calls.push(['link', scope]); data.links.push({ shopid: scope.shopId, contact_key: scope.contactKey, customer_id: scope.customerId, source_customer_id: scope.sourceCustomerId, match_kind: scope.matchKind }); },
    readSummary: async ({ shopId, customerId }) => ({ customer: data.customers.find(c => Number(c.shopid) === shopId && String(c.id) === customerId), member: data.members.find(m => Number(m.shopid) === shopId && String(m.customer_id) === customerId) }),
  };
  const connection = {};
  const service = buildCustomerPhoneService({ repository, runInTransaction: async work => { calls.push(['transaction']); return work(connection); } });
  return { data, calls, repository, service, connection };
};
test('valid variants create one contact and binding, without card, identity, consent or session writes', async () => {
  const f = fixture();
  const first = await f.service.resolve({ shopId: 7, phone: '06.12.34.56.78', name: ' Bob ' });
  const again = await f.service.resolve({ shopId: 7, phone: '+33612345678', name: 'Changed' });
  assert.equal(first.phone, '+33612345678'); assert.equal(first.created, true); assert.equal(first.customer.name, 'Bob');
  assert.equal(again.created, false); assert.equal(again.customer.id, first.customer.id); assert.equal(again.customer.name, 'Bob'); assert.equal(again.loyalty, null);
  assert.deepEqual(f.calls.filter(c => ['create', 'link'].includes(c[0])).map(c => c[0]), ['create', 'link']);
  assert.deepEqual(f.data.identities, []); assert.deepEqual(f.data.members, []);
});
test('invalid phones never transact; checkout ignores invalid and ambiguous but propagates database failures', async () => {
  const f = fixture({ customers: [customer('1'), customer('2')] });
  for (const phone of ['', '0612', 'garbage', '0612345678 ext 4', 612345678]) await assert.rejects(f.service.resolve({ shopId: 7, phone }), { status: 422, code: 'CUSTOMER_PHONE_INVALID' });
  assert.equal(f.calls.length, 0);
  assert.equal(await f.service.resolveForCheckout({ shopId: 7, phone: '' }), null);
  assert.equal(await f.service.resolveForCheckout({ shopId: 7, phone: '0612345678' }), null);
  assert.equal(f.calls.some(c => ['create', 'link'].includes(c[0])), false);
  f.repository.loadSources = async () => { throw new Error('database failed'); };
  await assert.rejects(f.service.resolveForCheckout({ shopId: 7, phone: '0612345678' }), /database failed/);
});
test('a unique local, global verified or member phone reuses its same-shop profile and reads points', async () => {
  for (const source of ['contact', 'local', 'global', 'member']) {
    const f = fixture({ customers: [customer('9007199254740993', { contact_phone: source === 'contact' ? '0612345678' : '' }), customer('9', { shopid: 8 })],
      identities: ['local', 'global'].includes(source) ? [{ shopid: 7, customer_id: '9007199254740993', channel: 'sms', destination: '06 12 34 56 78', verified_at: '2026-01-01' }] : [],
      members: [{ id: 'card', shopid: 7, customer_id: '9007199254740993', phone_e164: source === 'member' ? '+33612345678' : null, card_number: '1234567890123456', balance: 50, reserved: 12 }] });
    const result = await f.service.resolve({ shopId: 7, phone: '+33 6 12 34 56 78', name: 'Overwrite' });
    assert.equal(result.customer.id, '9007199254740993'); assert.equal(result.customer.name, 'Alice'); assert.equal(result.customer.email, 'alice@example.test');
    assert.deepEqual(result.loyalty, { id: 'card', cardNumber: '1234567890123456', balance: 50, reserved: 12, available: 38 });
    assert.equal(f.calls.some(c => c[0] === 'create'), false);
  }
});
test('manual binding and imported canonical aliases are reused; incompatible protected candidates remain ambiguous', async () => {
  const binding = { shopid: 7, contact_key: key('+33612345678'), customer_id: '2', source_customer_id: '1', match_kind: 'manual' };
  const f = fixture({ customers: [customer('1'), customer('2', { contact_phone: '' })], links: [binding] });
  assert.equal((await f.service.resolve({ shopId: 7, phone: '0612345678' })).customer.id, '2');
  assert.equal(f.calls.some(c => c[0] === 'link'), false);
  const imported = fixture({ customers: [customer('1'), customer('2', { contact_phone: '' })], links: [{ ...binding, customer_id: '1', match_kind: 'import' }],
    identities: [{ shopid: 7, customer_id: '2', channel: 'sms', destination: '+33612345678', verified_at: '2026-01-01' }] });
  assert.equal((await imported.service.resolve({ shopId: 7, phone: '0612345678' })).customer.id, '2');
  const conflict = fixture({ customers: [customer('1', { has_linked_orders: 1 }), customer('2')], links: [binding] });
  const result = await conflict.service.resolve({ shopId: 7, phone: '0612345678' });
  assert.equal(result.status, 'ambiguous'); assert.equal(result.customer, null); assert.equal(conflict.calls.some(c => ['link', 'create'].includes(c[0])), false);
});
test('existing checkout connection is reused with Shop first; summaries are scoped and read-only', async () => {
  const f = fixture({ customers: [customer('1')] }), connection = { checkout: true };
  await f.service.resolve({ shopId: 7, phone: '0612345678', connection });
  assert.equal(f.calls[0][0], 'shop'); assert.equal(f.calls[1][0], 'sources'); assert.equal(f.calls[0][1].connection, connection);
  assert.equal(f.calls.some(c => c[0] === 'transaction'), false);
  const count = f.calls.length;
  assert.equal((await f.service.getSummary({ shopId: 7, customerId: '1', connection })).customer.id, '1');
  assert.equal(await f.service.getSummary({ shopId: 8, customerId: '1', connection }), null); assert.equal(f.calls.length, count);
});
const response = () => ({ headers: {}, set(k,v) { this.headers[k] = v; return this; }, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } });
const staff = (access = 1, permissions = ['orders']) => ({ query: {}, body: { phone: '0612345678' }, headers: {}, shopid: 7, id: 10, sessionSubject: 'staff', currentUser: { id: 10, shopid: 7, access, status: 1, module_permissions: JSON.stringify(permissions) } });
const qr = () => ({ query: {}, body: { phone: '0612345678' }, headers: { origin: 'https://pos.test', authorization: 'Bearer table' }, shopid: 7, servicePointId: 3, sessionSubject: 'service_point', orderSource: 'table_qr', ip: '127.0.0.1' });
test('staff roles need orders or cashregister permission; body and query are whitelisted', async () => {
  let calls = 0;
  const controller = buildCustomerPhoneController({ access: { lookupQuota: async () => {} }, service: { resolve: async () => { calls++; return { status: 'resolved' }; } } });
  for (const role of [0,1,4,5]) { const res = response(); await controller.resolve(staff(role), res); assert.equal(res.statusCode, 200); }
  for (const req of [staff(6), staff(1, ['history']), { ...staff(), currentUser: { ...staff().currentUser, status: 0 } }, { ...staff(), body: { phone: '0612345678', customerId: '1' } }, { ...staff(), query: { shopId: '8' } }]) {
    const res = response(); await controller.resolve(req, res); assert([400,403,422].includes(res.statusCode));
  }
  assert.equal(calls, 4);
});
test('table QR requires active table, permitted origin and quotas; response has only public fields', async () => {
  let calls = 0; const quotas = [];
  const controller = buildCustomerPhoneController({ allowedOrigins: ['https://pos.test'], tableContext: { read: async ({ token }) => token === 'table' ? { shopId: 7, servicePointId: 3 } : null }, access: { lookupQuota: async scope => { quotas.push(scope); } },
    service: { resolve: async () => { calls++; return { status: 'resolved', phone: '+33612345678', created: false, customer: { id: '1', email: 'secret' }, loyalty: { id: 'secret', cardNumber: 'secret', balance: 30, reserved: 5, available: 25 } }; } } });
  let res = response(); await controller.resolve(qr(), res);
  assert.deepEqual(res.body.data, { status: 'resolved', phone: '+33612345678', created: false, profilePresent: true, loyalty: { available: 25 } });
  assert.equal(res.headers['Cache-Control'], 'no-store'); assert.equal(quotas.length, 2); assert.equal(res.headers['Set-Cookie'], undefined);
  for (const req of [{ ...qr(), orderSource: 'borne' }, { ...qr(), headers: { origin: 'https://bad.test', authorization: 'Bearer table' } }, { ...qr(), headers: { origin: 'https://pos.test', authorization: 'Bearer inactive' } }]) { res = response(); await controller.resolve(req, res); assert.equal(res.statusCode, 403); }
  assert.equal(calls, 1);
});

test('resolver SQL summary uses a current read after an existing checkout snapshot', async () => {
  const { buildSqlCustomerPhoneRepository } = require('../src/modules/m_customerPhone');
  const queries = [];
  const connection = { query: async sql => { queries.push(sql); return sql.includes('FROM customers') ? [[customer('1')]] : [[]]; } };
  await buildSqlCustomerPhoneRepository({ pool: connection }).readSummary({ shopId: 7, customerId: '1', connection, currentRead: true });
  assert.equal(queries.length, 2);
  assert(queries.every(sql => /FOR SHARE\s*$/.test(sql)), 'customer and membership summaries must not use an older checkout snapshot');
});

test('the resolver route sets no-store before authentication can reject the request', async () => {
  const { buildCustomersRouter } = require('../src/routers/r_customers');
  const router = buildCustomersRouter({ authentication: (_req,res) => { res.status(401).json({ denied: true }); }, phoneController: { resolve: () => { throw new Error('authentication must reject'); } } });
  const route = router.stack.find(layer => layer.route?.path === '/clients/resolve-phone').route;
  const res = response();
  const dispatch = async index => { if (route.stack[index]) await route.stack[index].handle({}, res, () => dispatch(index + 1)); };
  await dispatch(0);
  assert.equal(res.statusCode, 401); assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('QR quota rejection and a signed but inactive table do not reach resolution', async () => {
  const { buildLoyaltyTableContext } = require('../src/helpers/middleware/loyaltyTableContext');
  let called = false;
  const service = { resolve: async () => { called = true; return {}; } };
  const tableContext = buildLoyaltyTableContext({ verifyToken: () => ({ subject_type: 'service_point', source: 'table_qr', shopid: 7, service_point_id: 3 }), findServicePoint: async () => ({ shopid: 7, id: 3, type: 'table', is_active: 0 }) });
  let controller = buildCustomerPhoneController({ service, tableContext, allowedOrigins: ['https://pos.test'] });
  let res = response(); await controller.resolve(qr(), res); assert.equal(res.statusCode, 403); assert.equal(called, false);
  controller = buildCustomerPhoneController({ service, allowedOrigins: ['https://pos.test'], tableContext: { read: async () => ({ shopId: 7, servicePointId: 3 }) }, access: { lookupQuota: async () => { throw new (require('../src/helpers/domainError'))(429, 'LOYALTY_RATE_LIMITED', 'rate limited'); } } });
  res = response(); await controller.resolve(qr(), res); assert.equal(res.statusCode, 429); assert.equal(called, false);
});

test('getSummary returns null when the SQL repository finds no same-shop customer', async () => {
  const calls = [];
  const service = buildCustomerPhoneService({ repository: { readSummary: async scope => { calls.push(scope); return null; } } });
  assert.equal(await service.getSummary({ shopId: 7, customerId: '999' }), null);
  assert.equal(await service.getSummary({ shopId: 8, customerId: '1' }), null);
  assert.deepEqual(calls.map(c => [c.shopId,c.customerId]), [[7,'999'],[8,'1']]);
});

test('a preexisting snapshot cannot hide committed address or order protection from imported alias resolution', async () => {
  const { buildSqlCustomerPhoneRepository } = require('../src/modules/m_customerPhone');
  for (const protection of ['customer_addresses', 'orders', 'archives']) {
    const queries = [];
    const connection = { query: async sql => {
      queries.push(sql);
      if (/SELECT id FROM shop/.test(sql)) return [[{ id: 7 }]];
      // The outer customer query sees current profiles, but its old EXISTS subqueries see the checkout snapshot.
      if (/FROM customers c WHERE/.test(sql)) return [[customer('1', { has_addresses: 0, has_linked_orders: 0 }), customer('2', { contact_phone: '', has_addresses: 0, has_linked_orders: 0 })]];
      if (/FROM customer_identities/.test(sql)) return [[{ shopid: 7, customer_id: '2', channel: 'sms', destination: '+33612345678', verified_at: '2026-01-01' }]];
      if (/FROM customer_directory_contacts/.test(sql)) return [[{ shopid: 7, contact_key: key('+33612345678'), customer_id: '1', source_customer_id: '1', match_kind: 'import' }]];
      if (/FROM customers WHERE/.test(sql)) return [[customer('2', { contact_phone: '' })]];
      if (new RegExp(`FROM ${protection}\\b`).test(sql) && /FOR (?:SHARE|UPDATE)\s*$/.test(sql)) return [[{ customer_id: '1', customer_account_id: '1', customer_profile_id: null }]];
      return [[]];
    } };
    const repository = buildSqlCustomerPhoneRepository({ pool: connection });
    const service = buildCustomerPhoneService({ repository });
    const result = await service.resolve({ shopId: 7, phone: '0612345678', connection });
    assert.equal(result.status, 'ambiguous', `${protection} committed after the old snapshot must protect its source`);
    assert.equal(result.customer, null);
    assert.equal(queries.some(sql => /INSERT|UPDATE customers|UPDATE customer_directory/.test(sql)), false);
    assert.match(queries[0], /FROM shop.*FOR UPDATE/);
    assert.match(queries[1], /FROM customers c.*FOR UPDATE/s);
  }
});
