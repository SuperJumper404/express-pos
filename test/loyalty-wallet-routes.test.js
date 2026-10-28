const assert = require('assert/strict');
const express = require('express');
const http = require('http');
const { buildLoyaltyWalletRouter } = require('../src/routers/r_loyaltyWallet');

(async () => {
  const registered = [];
  let changes = [{ serial: 'serial', updated_tag: '100' }];
  const repository = {
    findPass: async serial => serial === 'serial' ? { serial, auth_token: 'a'.repeat(64) } : null,
    register: async value => { registered.push(value); return registered.length === 1; },
    unregister: async value => registered.push(value),
    updated: async ({ since = '0' }) => changes.filter(row => BigInt(row.updated_tag) > BigInt(since)),
  };
  const wallet = { getConfig: () => ({ applePassTypeId: 'pass.example', mode: 'development' }), repository: () => repository,
    getApplePass: async () => Buffer.from('PKPASS') };
  const app = express(); app.use(express.json()); app.use('/wallet/apple', buildLoyaltyWalletRouter({ wallet }));
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/wallet/apple/v1`;
  try {
    const url = `${base}/devices/device/registrations/pass.example/serial`;
    let response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pushToken: 'b'.repeat(64) }) });
    assert.equal(response.status, 401); assert.equal(registered.length, 0);
    const headers = { 'Content-Type': 'application/json', Authorization: `ApplePass ${'a'.repeat(64)}` };
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ pushToken: 'b'.repeat(64) }) }); assert.equal(response.status, 201);
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ pushToken: 'b'.repeat(64) }) }); assert.equal(response.status, 200);
    response = await fetch(`${base}/passes/pass.example/serial`, { headers }); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/vnd.apple.pkpass');
    response = await fetch(`${base}/devices/device/registrations/pass.example?passesUpdatedSince=0`); assert.deepEqual(await response.json(), { serialNumbers: ['serial'], lastUpdated: '100' });
    // A later committed change on another pass remains visible even during the same clock millisecond.
    changes.push({ serial: 'second-pass', updated_tag: '101' });
    response = await fetch(`${base}/devices/device/registrations/pass.example?passesUpdatedSince=100`);
    assert.deepEqual(await response.json(), { serialNumbers: ['second-pass'], lastUpdated: '101' });
    response = await fetch(`${base}/devices/device/registrations/pass.example?passesUpdatedSince=101`); assert.equal(response.status, 204);
    response = await fetch(`${base}/devices/device/registrations/wrong?passesUpdatedSince=0`); assert.equal(response.status, 404);
    response = await fetch(url, { method: 'DELETE', headers }); assert.equal(response.status, 200);
    console.log('loyalty wallet routes: authentication, register/update/unregister, content type and pass type isolation passed');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
