const assert = require('node:assert/strict');
const { test } = require('node:test');
const dbPath = require.resolve('../src/config/db');
require.cache[dbPath] = { exports: { query: () => { throw new Error('unexpected legacy DB query'); } } };
const { buildDetailOrderController } = require('../src/controllers/c_orders');
const { pickArchiveOrderFields, buildOrderArchiveModule } = require('../src/modules/m_orders');

const profile = { customer: { id: '9007199254740993', shopId: 7, name: 'Client', phone: '+33612345678', email: 'client@example.test' }, loyalty: { id: 'member', cardNumber: '0001234567890123', balance: 30, reserved: 5, available: 25 } };
function fixture({ shopId = 7, archived = false } = {}) {
  const rows = [{ id: 42, shopid: shopId, customer_profile_id: profile.customer.id, payment_status: 'paid' }, { id: 42, shopid: shopId, customer_profile_id: profile.customer.id }];
  const summaries = [];
  const controller = buildDetailOrderController({ archived, findIdentity: async () => rows[0], readDetails: async () => rows,
    customerPhone: { getSummary: async scope => { summaries.push(scope); return profile; } } });
  const req = { params: { id: 42 }, shopid: 7, id: 8, sessionSubject: 'staff', access: 1,
    currentUser: { id: 8, shopid: 7, status: 1, access: 1, module_permissions: ['orders'] } };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  return { rows, summaries, controller, req, res };
}
test('same-shop authorized staff receives current minimal profile on all paid detail rows', async () => {
  for (const archived of [false, true]) {
    assert.equal(typeof buildDetailOrderController, 'function');
    const f = fixture({ archived }); await f.controller(f.req, f.res);
    assert.equal(f.res.statusCode, 200); assert.equal(f.summaries.length, 1);
    assert.deepEqual(f.summaries[0], { shopId: 7, customerId: profile.customer.id });
    assert.deepEqual(f.res.body.data.map(row => row.clientProfile), [profile, profile]);
    assert.equal(f.rows[0].clientProfile, undefined, 'shared hydration rows must not be mutated');
  }
});
test('public/table QR, foreign-shop and unprivileged detail never reads or returns a profile', async () => {
  for (const mode of ['qr', 'public', 'foreign', 'no-permission', 'inactive', 'wrong-user-shop']) {
    const f = fixture({ shopId: mode === 'foreign' ? 8 : 7 });
    if (mode === 'qr') f.req.sessionSubject = 'service_point';
    if (mode === 'public') delete f.req.currentUser;
    if (mode === 'no-permission') f.req.currentUser.module_permissions = ['borne'];
    if (mode === 'inactive') f.req.currentUser.status = 0;
    if (mode === 'wrong-user-shop') f.req.currentUser.shopid = 8;
    await f.controller(f.req, f.res); assert.equal(f.summaries.length, 0, mode);
    assert.equal(f.res.body.data[0].clientProfile, undefined, mode);
    assert.equal(f.res.body.data[0].customer_profile_id, undefined, mode);
  }
});
test('staff sees profile-only as no card and missing profile summaries remain absent', async () => {
  for (const summary of [{ customer: profile.customer, loyalty: null }, null]) {
    const f = fixture();
    const controller = buildDetailOrderController({ findIdentity: async () => f.rows[0], readDetails: async () => f.rows,
      customerPhone: { getSummary: async () => summary } });
    await controller(f.req, f.res);
    assert.deepEqual(f.res.body.data[0].clientProfile, summary || undefined);
  }
});
test('archive copies the internal profile without changing authenticated ownership', () => {
  assert.deepEqual(pickArchiveOrderFields({ customer_profile_id: profile.customer.id, customer_account_id: '22' }),
    { customer_profile_id: profile.customer.id, customer_account_id: '22' });
});
test('public archive hydration contains no profile summary', async () => {
  const rows = [{ id: 1, shopid: 7, customer_profile_id: profile.customer.id }];
  const service = buildOrderArchiveModule({ repository: { findArchivedOrderDetailsByToken: async () => rows, findArchiveSnapshots: async () => [] } });
  const result = await service.mDetailArchivedOrderByToken('public-token');
  assert.equal(result[0].clientProfile, undefined);
  assert.equal(result[0].customer_profile_id, undefined);
});

test('order list controllers omit the internal profile column introduced by the schema', async () => {
  const ordersPath = require.resolve('../src/modules/m_orders');
  const controllerPath = require.resolve('../src/controllers/c_orders');
  const originalOrders = require.cache[ordersPath].exports;
  const originalController = require.cache[controllerPath];
  const rows = [{ id: 42, shopid: 7, customer_profile_id: profile.customer.id, subtotal: 10 }];
  try {
    require.cache[ordersPath].exports = { ...originalOrders, mAllOrder: async () => rows,
      mOrdersbyUserId: async () => rows, mAllArchivedOrders: async () => rows };
    delete require.cache[controllerPath];
    const controllers = require('../src/controllers/c_orders');
    for (const name of ['allOrder', 'ordersbyUserId', 'allArchivedOrders']) {
      const f = fixture(); const done = new Promise(resolve => { f.res.json = function(body) { this.body = body; resolve(); return this; }; });
      await controllers[name]({ shopid: 7, query: { servicePointId: 5 }, sessionSubject: 'service_point' }, f.res); await done;
      assert.equal(f.res.body.data[0].customer_profile_id, undefined, name);
      assert.equal(f.res.body.data[0].subtotal, 10, name);
      assert.equal(rows[0].customer_profile_id, profile.customer.id, 'must not mutate the shared query result');
    }
  } finally { require.cache[ordersPath].exports = originalOrders; require.cache[controllerPath] = originalController; }
});
