const assert = require('assert/strict');
const { test } = require('node:test');
const { buildClientDirectoryService } = require('../src/modules/m_clientDirectory');
const fixture = () => {
  const data = { customers: [{ id: '1', shopid: 7, name: 'Alice', contact_phone: '', contact_email: '' }],
    identities: [{ shopid: 7, customer_id: '1', channel: 'sms', destination: '+33612345678', verified_at: '2026-01-01' }],
    members: [], links: [], archives: [
      { id: 1, shopid: 7, phone: '0612345678', customer: 'Alice', subtotal: 8, created: '2026-11-01' },
      { id: 2, shopid: 7, phone: '555', customer: 'Ancien', subtotal: 4, created: '2026-11-02' },
    ] };
  const calls = [];
  let next = 10;
  const repository = {
    loadSources: async ({ shopId }) => { assert.equal(shopId, 7); return structuredClone(data); },
    lockShop: async scope => { calls.push(['lock', scope.shopId]); },
    createContact: async ({ shopId, name, phone }) => { const id = String(next++); calls.push(['create', id]); data.customers.push({ id, shopid: shopId, name, contact_phone: phone }); return id; },
    saveLink: async value => { calls.push(['link', value.customerId]); const existing = data.links.findIndex(link => link.contact_key === value.contactKey);
      const row = { shopid: value.shopId, contact_key: value.contactKey, customer_id: value.customerId, source_customer_id: value.sourceCustomerId, match_kind: value.matchKind };
      if (existing >= 0) data.links[existing] = row; else data.links.push(row); },
  };
  return { data, calls, service: buildClientDirectoryService({ repository, runInTransaction: work => work({}), clock: () => new Date('2026-11-06') }) };
};
const scope = { shopId: 7, canManageLoyalty: true };
test('dry-run is read-only; applying and replaying import preserves IDs and counts', async () => {
  const f = fixture();
  const before = JSON.stringify(f.data);
  const preview = await f.service.reconcile({ shopId: 7, actorId: 2, dryRun: true });
  assert.equal(preview.created, 1); assert.equal(preview.linked, 1);
  assert.equal(JSON.stringify(f.data), before);
  await f.service.reconcile({ shopId: 7, actorId: 2, dryRun: false });
  assert.deepEqual(f.calls.filter(call => call[0] === 'create'), [['create', '10']]);
  const again = await f.service.reconcile({ shopId: 7, actorId: 2, dryRun: false });
  assert.equal(again.created, 0); assert.equal(again.linked, 0);
  const result = await f.service.list({ ...scope, page: 1, pageSize: 1 });
  assert.equal(result.items.length, 1); assert.equal(result.total, 2); assert.equal(result.metrics.clientCount, 2);
  assert.equal(result.items[0].source, 'historical');
  assert.equal((await f.service.list({ ...scope, filter: 'unmatched' })).total, 1);
});
test('manual mapping is explicit, tenant-owned and resolves the old contact identifier', async () => {
  const f = fixture();
  const old = (await f.service.list(scope)).items.find(row => row.phone === '555');
  await assert.rejects(() => f.service.linkContact({ shopId: 7, actorId: 2, contactKey: old.contactKeys[0], customerId: '999' }), error => error.status === 404);
  await f.service.linkContact({ shopId: 7, actorId: 2, contactKey: old.contactKeys[0], customerId: '1' });
  const detail = await f.service.detail({ ...scope, id: old.id });
  assert.equal(detail.client.customerId, '1'); assert.equal(detail.orders.length, 2);
  assert.equal(detail.client.totalSpent, 12);
  f.data.customers.push({ id: '2', shopid: 7, name: 'Autre compte' });
  await assert.rejects(() => f.service.linkContact({ shopId: 7, actorId: 2, contactKey: old.contactKeys[0], customerId: '2' }), error => error.code === 'CLIENT_CONTACT_PROTECTED');
});
test('protected source contacts cannot be merged and read endpoints do not write', async () => {
  const f = fixture();
  await f.service.reconcile({ shopId: 7, actorId: 2, dryRun: false });
  f.data.members.push({ id: 'own-card', shopid: 7, customer_id: '10', balance: 8, reserved: 0 });
  const row = (await f.service.list(scope)).items.find(value => value.id === '10');
  await assert.rejects(() => f.service.linkContact({ shopId: 7, actorId: 2, contactKey: row.contactKeys[0], customerId: '1' }), error => error.code === 'CLIENT_CONTACT_PROTECTED');
  const calls = f.calls.length;
  await f.service.list(scope); await f.service.exportCsv(scope); await f.service.detail({ ...scope, id: '1' });
  assert.equal(f.calls.length, calls);
});
test('non-admin cannot filter on loyalty; malformed paging and IDs are rejected', async () => {
  const f = fixture();
  await assert.rejects(() => f.service.list({ ...scope, canManageLoyalty: false, filter: 'members' }), error => error.status === 403);
  await assert.rejects(() => f.service.list({ ...scope, pageSize: '-1' }), error => error.status === 400);
  await assert.rejects(() => f.service.detail({ ...scope, id: '1 OR 1' }), error => error.status === 400);
});
test('old imported customer IDs resolve after a verified account appears', async () => {
  const f = fixture();
  const verified = f.data.identities.splice(0);
  await f.service.reconcile({ shopId: 7, actorId: 2, dryRun: false });
  const imported = (await f.service.list(scope)).items.find(row => row.phone === '0612345678');
  f.data.identities.push(...verified);
  const detail = await f.service.detail({ ...scope, id: imported.id });
  assert.equal(detail.client.customerId, '1');
  assert.equal((await f.service.list(scope)).items.some(row => row.id === imported.id), false);
});
test('persisted aliases survive hiding the last archive without restoring financial history', async () => {
  const f = fixture();
  const verified = f.data.identities.splice(0);
  const historical = (await f.service.list(scope)).items.find(row => row.phone === '0612345678');
  await f.service.reconcile({ shopId: 7, actorId: 2, dryRun: false });
  const imported = (await f.service.detail({ ...scope, id: historical.id })).client.id;
  f.data.identities.push(...verified);
  await f.service.reconcile({ shopId: 7, actorId: 2, dryRun: false });
  f.data.archives[0].hidden_from_history = 1;
  const rows = (await f.service.list(scope)).items;
  assert.equal(rows.some(row => row.id === imported), false);
  assert.equal((await f.service.detail({ ...scope, id: historical.id })).client.id, '1');
  const detail = await f.service.detail({ ...scope, id: imported });
  assert.equal(detail.client.id, '1'); assert.equal(detail.orders.length, 0);
});
