const assert = require('assert/strict');
const { test } = require('node:test');
const { buildClientDirectoryController } = require('../src/controllers/c_clientDirectory');
const request = data => ({ shopid: 7, id: 2, sessionSubject: 'staff', query: {}, params: {}, body: {},
  currentUser: { id: 2, shopid: 7, access: 0, status: 1 }, ...data });
const response = () => ({ code: 200, payload: null, headers: {}, set(key, value) { this.headers[key] = value; return this; },
  status(code) { this.code = code; return this; }, json(payload) { this.payload = payload; return this; }, send(payload) { this.payload = payload; return this; } });
test('directory preserves history permissions and refuses all non-staff or mismatched tenants', async () => {
  const calls = [];
  const controller = buildClientDirectoryController({ service: { list: async scope => { calls.push(scope); return { items: [] }; } } });
  for (const change of [{ sessionSubject: 'customer' }, { sessionSubject: 'service_point' }, { shopid: 8 },
    ...[2, 3, 6, 99].map(access => ({ currentUser: { id: 2, shopid: 7, access, status: 1, module_permissions: ['history'] } })),
    { currentUser: { id: 2, shopid: 7, access: 4, status: 1, module_permissions: ['orders'] } },
    { currentUser: { id: 2, shopid: 7, access: 1, status: 0 } }]) {
    const res = response(); await controller.list(request(change), res); assert.equal(res.code, 403);
  }
  const res = response(); await controller.list(request({ currentUser: { id: 2, shopid: 7, access: 1, status: 1, module_permissions: ['history'] } }), res);
  assert.equal(res.code, 200); assert.equal(calls.length, 1); assert.equal(calls[0].canManageLoyalty, false);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});
test('reconciliation requires admin and accepts only explicit validated fields', async () => {
  let called = 0;
  const controller = buildClientDirectoryController({ service: { reconcile: async () => { called++; return {}; } } });
  const staff = response(); await controller.reconcile(request({ currentUser: { id: 2, shopid: 7, access: 1, status: 1 } }), staff);
  assert.equal(staff.code, 403);
  const extra = response(); await controller.reconcile(request({ body: { dryRun: false, shopId: 8 } }), extra); assert.equal(extra.code, 400);
  const preview = response(); await controller.reconcile(request({ body: { dryRun: true } }), preview); assert.equal(preview.code, 200); assert.equal(called, 1);
});
