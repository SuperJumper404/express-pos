const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const bcrypt = require('bcrypt');
const { encryptPin, decryptPin } = require('../src/helpers/pinVault');
const controllerPath = path.join(__dirname, '../src/controllers/c_users.js');
process.env.PIN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
let target;
let writes;
let lookups;
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename === controllerPath) {
    if (request === '../modules/m_users') return {
      mFindUserByIdAndShop: async (id, shopid) => { lookups.push([id, shopid]); return target ? [target] : []; },
      mUpdateUser: async (data, id) => { writes.push({ data, id }); },
      mRegister: async data => { writes.push({ data }); },
      mGetAllUser: async () => [target],
    };
    if (request === '../modules/m_servicePoints') return {};
    if (request === '../helpers/env') return { envJWTKEY: 'fixture' };
    if (request === '../helpers/mailer') return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};
const controller = require(controllerPath);
Module._load = originalLoad;
const req = () => ({ id: 1, shopid: 7, headers: { authorization: 'Bearer active-fixture' }, sessionSubject: 'staff', currentUser: { id: 1, shopid: 7, access: 0, status: 1, token: 'active-fixture' }, params: { id: '2' }, body: {} });
const response = () => ({ headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(s) { this.statusCode = s; return this; }, json(p) { this.payload = p; return this; } });
const reset = () => { target = { id: 2, shopid: 7, access: 1, staff_login_id: 'ABCD23', is_primary_admin: 0 }; writes = []; lookups = []; };

test('only a current same-shop administrator can reveal a PIN; invalid subjects never query storage', async () => {
  assert.equal(typeof controller.getStaffCredentials, 'function');
  for (const override of [{ sessionSubject: 'service_point' }, { currentUser: { id: 1, shopid: 7, access: 1, status: 1 } }, { currentUser: { id: 1, shopid: 8, access: 0, status: 1 } }, { currentUser: { id: 1, shopid: 7, access: 0, status: 0 } }]) {
    reset(); const res = response();
    await controller.getStaffCredentials({ ...req(), ...override }, res);
    assert.equal(res.statusCode, 403); assert.equal(lookups.length, 0); assert.equal(writes.length, 0);
  }
});
test('reveal returns decrypted PIN only on demand with no-store, and does not mutate credentials', async () => {
  assert.equal(typeof controller.getStaffCredentials, 'function'); reset();
  target.staff_pin_encrypted = encryptPin('0042', { kind: 'staff', shopId: 7, loginId: 'ABCD23' });
  const res = response(); await controller.getStaffCredentials(req(), res);
  assert.equal(res.statusCode, 200); assert.deepEqual(res.payload.data, { staff_login_id: 'ABCD23', staff_pin: '0042', needs_regeneration: false });
  assert.match(res.headers['cache-control'], /no-store/); assert.deepEqual(lookups, [[2, 7]]); assert.equal(writes.length, 0);
});
test('logged-out and replaced administrator sessions cannot reveal PINs', async () => {
  reset();
  for (const token of [null, '', 'replacement-token']) {
    const request = req(); request.currentUser.token = token;
    const res = response(); await controller.getStaffCredentials(request, res);
    assert.equal(res.statusCode, 401); assert.equal(lookups.length, 0);
  }
});
test('legacy PIN requires explicit regeneration; unknown, primary admin and nonstaff targets cannot be revealed', async () => {
  assert.equal(typeof controller.getStaffCredentials, 'function'); reset();
  const legacy = response(); await controller.getStaffCredentials(req(), legacy);
  assert.equal(legacy.payload.data.staff_pin, null); assert.equal(legacy.payload.data.needs_regeneration, true); assert.equal(writes.length, 0);
  for (const value of [null, { ...target, is_primary_admin: 1 }, { ...target, access: 3 }]) {
    target = value; const res = response(); await controller.getStaffCredentials(req(), res); assert.equal(res.statusCode, 404);
  }
});
test('bad target identifiers are rejected before querying and unavailable encryption fails closed', async () => {
  assert.equal(typeof controller.getStaffCredentials, 'function'); reset();
  const invalid = response(); await controller.getStaffCredentials({ ...req(), params: { id: '2 OR 1=1' } }, invalid);
  assert.equal(invalid.statusCode, 400); assert.equal(lookups.length, 0);
  target.staff_pin_encrypted = 'corrupted'; const res = response(); await controller.getStaffCredentials(req(), res);
  assert.equal(res.statusCode, 503); assert.ok(!JSON.stringify(res.payload).includes('corrupted')); assert.equal(writes.length, 0);
});
test('regeneration writes a matching hash and encrypted copy atomically, retaining the login ID', async () => {
  reset(); const res = response(); await controller.setStaffCredentials(req(), res);
  assert.equal(res.statusCode, 200); assert.equal(writes.length, 1);
  const data = writes[0].data; const pin = res.payload.data.staff_pin;
  assert.equal(data.staff_login_id, 'ABCD23'); assert.ok(await bcrypt.compare(pin, data.staff_pin_hash));
  assert.equal(decryptPin(data.staff_pin_encrypted, { kind: 'staff', shopId: 7, loginId: 'ABCD23' }), pin);
  assert.match(res.headers['cache-control'], /no-store/);
});
test('creation encrypts PIN before inserting and missing key prevents any credential write', async () => {
  reset(); const res = response(); await controller.registerWithStaffCredentials({ ...req(), body: { username: 'Fixture', access: 1 } }, res);
  assert.equal(res.statusCode, 200); const data = writes[0].data;
  assert.equal(decryptPin(data.staff_pin_encrypted, { kind: 'staff', shopId: 7, loginId: data.staff_login_id }), res.payload.data.staff_pin);
  const previous = process.env.PIN_ENCRYPTION_KEY; delete process.env.PIN_ENCRYPTION_KEY;
  try { reset(); const failed = response(); await controller.setStaffCredentials(req(), failed); assert.equal(failed.statusCode, 503); assert.equal(writes.length, 0); }
  finally { process.env.PIN_ENCRYPTION_KEY = previous; }
});
